import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, Transaction } from '../database/database.service';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';

interface PaymentRow {
  payment_id: string;
  order_id: string;
  branch_id: string;
  business_date: string;
  expected_amount_satang: number;
  payment_status: string;
  order_status: string;
  provider_transaction_id: string | null;
  received_amount_satang: number | null;
  reservation_active: boolean;
}

@Injectable()
export class PaymentsService {
  constructor(private readonly db: DatabaseService) {}

  async confirm(
    dto: ConfirmPaymentDto,
  ): Promise<{ orderId: string; status: string }> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<PaymentRow>(
        `with locked_payment as materialized (
         select p.id payment_id, p.order_id, p.expected_amount_satang,
                p.status payment_status, o.status order_status, o.branch_id,
                o.business_date::text, o.reservation_expires_at,
                p.provider_transaction_id, p.received_amount_satang
         from payments p join orders o on o.id = p.order_id
         where p.provider_payment_reference = $1 for update of p, o
         ) select *, reservation_expires_at > clock_timestamp() reservation_active
           from locked_payment`,
        [dto.paymentReference],
      );
      if (!result.rowCount)
        throw new NotFoundException('Payment reference not found');
      const payment = result.rows[0];

      if (payment.provider_transaction_id !== null) {
        if (
          payment.provider_transaction_id !== dto.transactionId ||
          payment.received_amount_satang !== dto.amountSatang
        ) {
          throw new ConflictException(
            'Payment reference already has a different confirmation',
          );
        }
        return {
          orderId: payment.order_id,
          status:
            payment.payment_status === 'confirmed'
              ? 'paid'
              : payment.payment_status,
        };
      }
      if (payment.payment_status !== 'pending') {
        throw new ConflictException('Payment requires reconciliation');
      }
      if (dto.amountSatang !== payment.expected_amount_satang) {
        await tx.query(
          `update payments set received_amount_satang=$2, provider_transaction_id=$3,
             status='review_required', updated_at=now() where id=$1`,
          [payment.payment_id, dto.amountSatang, dto.transactionId],
        );
        await this.outbox(
          tx,
          payment.order_id,
          'payment.amount_mismatch',
          payment.branch_id,
          dto,
        );
        return { orderId: payment.order_id, status: 'review_required' };
      }
      if (
        payment.order_status !== 'pending_payment' ||
        !payment.reservation_active
      ) {
        await tx.query(
          `update payments set received_amount_satang=$2, provider_transaction_id=$3,
             status='review_required', updated_at=now() where id=$1`,
          [payment.payment_id, dto.amountSatang, dto.transactionId],
        );
        await this.outbox(
          tx,
          payment.order_id,
          'payment.late_confirmation',
          payment.branch_id,
          dto,
        );
        return { orderId: payment.order_id, status: 'review_required' };
      }

      await tx.query(
        `update daily_inventory i set
           reserved_quantity = reserved_quantity - oi.quantity,
           sold_quantity = sold_quantity + oi.quantity
         from order_items oi where oi.order_id=$1 and i.branch_id=$2
           and i.product_id=oi.product_id and i.business_date=$3`,
        [payment.order_id, payment.branch_id, payment.business_date],
      );
      await tx.query(
        `update payments set received_amount_satang=$2, provider_transaction_id=$3,
           status='confirmed', confirmed_at=now(), updated_at=now() where id=$1`,
        [payment.payment_id, dto.amountSatang, dto.transactionId],
      );
      await tx.query(
        `update orders set status='paid', updated_at=now() where id=$1`,
        [payment.order_id],
      );
      await this.outbox(tx, payment.order_id, 'order.paid', payment.branch_id, {
        orderId: payment.order_id,
        transactionId: dto.transactionId,
      });
      return { orderId: payment.order_id, status: 'paid' };
    });
  }

  private outbox(
    tx: Transaction,
    orderId: string,
    type: string,
    key: string,
    payload: object,
  ) {
    return tx.query(
      `insert into outbox_events(aggregate_type, aggregate_id, event_type, partition_key, payload)
       values ('order',$1,$2,$3,$4)`,
      [orderId, type, key, JSON.stringify(payload)],
    );
  }
}
