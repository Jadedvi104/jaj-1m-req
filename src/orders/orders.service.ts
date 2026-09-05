import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, Transaction } from '../database/database.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderView } from './order.types';

interface MenuRow {
  product_id: string;
  name_th: string;
  name_en: string;
  base_price: number;
  size_price: number | null;
  available_quantity: number;
  reserved_quantity: number;
  sold_quantity: number;
  table_id: string;
  table_number: string;
  corporation_id: string;
}

interface OrderRow {
  id: string;
  public_reference: string;
  display_number: string;
  status: string;
  total_satang: number;
  reservation_expires_at: Date;
  extension_used: boolean;
  provider_payment_reference?: string;
}

@Injectable()
export class OrdersService {
  constructor(private readonly db: DatabaseService) {}

  async create(
    dto: CreateOrderDto,
    idempotencyKey: string,
  ): Promise<OrderView> {
    if (!idempotencyKey?.trim())
      throw new BadRequestException('Idempotency-Key header is required');
    const duplicateIds = dto.items.map((item) => item.productId);
    if (new Set(duplicateIds).size !== duplicateIds.length) {
      throw new BadRequestException(
        'Each product may appear only once; use quantity instead',
      );
    }

    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx.query<OrderRow>(
          `select o.*, p.provider_payment_reference
         from orders o left join payments p on p.order_id = o.id
         where o.branch_id = $1 and o.idempotency_key = $2`,
          [dto.branchId, idempotencyKey],
        );
        if (existing.rowCount) return this.toView(existing.rows[0]);

        const table = await tx.query<MenuRow>(
          `select t.id table_id, t.table_number, b.corporation_id
         from table_sessions s join dining_tables t on t.id = s.table_id
         join branches b on b.id = t.branch_id
         where s.id = $1 and s.branch_id = $2 and s.expires_at > now() and t.active`,
          [dto.tableSessionId, dto.branchId],
        );
        if (!table.rowCount)
          throw new BadRequestException(
            'Invalid or expired table session code',
          );

        const selected: Array<
          MenuRow & {
            quantity: number;
            sizeCode?: string;
            spiceLevel?: string;
            price: number;
          }
        > = [];
        for (const item of dto.items) {
          const menu = await tx.query<MenuRow>(
            `select p.id product_id, p.name_th, p.name_en,
                  bmi.price_satang base_price, ps.price_satang size_price,
                  i.available_quantity, i.reserved_quantity, i.sold_quantity
           from branch_menu_items bmi
           join products p on p.id = bmi.product_id and p.corporation_id = $1
           join daily_inventory i on i.branch_id = bmi.branch_id
             and i.product_id = bmi.product_id
             and i.business_date = (now() at time zone 'Asia/Bangkok')::date
           left join product_sizes ps on ps.branch_id = bmi.branch_id
             and ps.product_id = bmi.product_id and ps.size_code = $4
           where bmi.branch_id = $2 and bmi.product_id = $3 and bmi.available and p.active
           for update of i`,
            [
              table.rows[0].corporation_id,
              dto.branchId,
              item.productId,
              item.sizeCode ?? null,
            ],
          );
          if (
            !menu.rowCount ||
            (item.sizeCode && menu.rows[0].size_price === null)
          ) {
            throw new BadRequestException(
              `Product ${item.productId} or selected size is unavailable`,
            );
          }
          const row = menu.rows[0];
          if (
            row.available_quantity - row.reserved_quantity - row.sold_quantity <
            item.quantity
          ) {
            throw new ConflictException(
              `Insufficient availability for product ${item.productId}`,
            );
          }
          selected.push({
            ...row,
            ...item,
            price: row.size_price ?? row.base_price,
          });
        }

        const businessDate = await tx.query<{ day: string }>(
          `select (now() at time zone 'Asia/Bangkok')::date::text as day`,
        );
        const counter = await tx.query<{ last_number: string }>(
          `insert into branch_order_counters(branch_id, business_date, last_number)
         values ($1, $2, 1)
         on conflict (branch_id, business_date) do update
           set last_number = branch_order_counters.last_number + 1
         returning last_number`,
          [dto.branchId, businessDate.rows[0].day],
        );
        const total = selected.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0,
        );
        const order = await tx.query<OrderRow>(
          `insert into orders(
           corporation_id, branch_id, table_id, table_session_id, business_date, display_number,
           idempotency_key, customer_name, customer_phone, table_number_snapshot,
           subtotal_satang, total_satang, reservation_expires_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,now() + interval '10 minutes')
         returning *`,
          [
            table.rows[0].corporation_id,
            dto.branchId,
            table.rows[0].table_id,
            dto.tableSessionId,
            businessDate.rows[0].day,
            counter.rows[0].last_number,
            idempotencyKey,
            dto.customerName,
            dto.customerPhone,
            table.rows[0].table_number,
            total,
          ],
        );

        for (const item of selected) {
          await tx.query(
            `update daily_inventory set reserved_quantity = reserved_quantity + $4
           where branch_id = $1 and product_id = $2 and business_date = $3`,
            [
              dto.branchId,
              item.product_id,
              businessDate.rows[0].day,
              item.quantity,
            ],
          );
          await tx.query(
            `insert into order_items(corporation_id, order_id, product_id, product_name_th, product_name_en,
             size_code, spice_level, quantity, unit_price_satang, line_total_satang)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              table.rows[0].corporation_id,
              order.rows[0].id,
              item.product_id,
              item.name_th,
              item.name_en,
              item.sizeCode ?? null,
              item.spiceLevel ?? null,
              item.quantity,
              item.price,
              item.price * item.quantity,
            ],
          );
        }

        const paymentReference = `KB-${order.rows[0].public_reference}`;
        await tx.query(
          `insert into payments(order_id, provider_payment_reference, expected_amount_satang)
         values ($1,$2,$3)`,
          [order.rows[0].id, paymentReference, total],
        );
        await this.outbox(
          tx,
          order.rows[0].id,
          'order.reserved',
          dto.branchId,
          {
            orderId: order.rows[0].id,
            publicReference: order.rows[0].public_reference,
            branchId: dto.branchId,
            expiresAt: order.rows[0].reservation_expires_at,
          },
        );
        return this.toView({
          ...order.rows[0],
          provider_payment_reference: paymentReference,
        });
      });
    } catch (error) {
      const dbError = error as { code?: string; constraint?: string };
      if (
        dbError.code === '23505' &&
        dbError.constraint === 'orders_branch_idempotency_unique'
      ) {
        const existing = await this.db.query<OrderRow>(
          `select o.*, p.provider_payment_reference from orders o
           left join payments p on p.order_id=o.id
           where o.branch_id=$1 and o.idempotency_key=$2`,
          [dto.branchId, idempotencyKey],
        );
        if (existing.rowCount) return this.toView(existing.rows[0]);
      }
      throw error;
    }
  }

  async findPublic(reference: string): Promise<OrderView> {
    const result = await this.db.query<OrderRow>(
      `select o.*, p.provider_payment_reference from orders o
       left join payments p on p.order_id = o.id
       where o.public_reference = $1 and o.public_access_expires_at > now()`,
      [reference],
    );
    if (!result.rowCount) throw new NotFoundException('Order not found');
    return this.toView(result.rows[0]);
  }

  async extend(reference: string): Promise<OrderView> {
    const result = await this.db.query<OrderRow>(
      `update orders set reservation_expires_at = reservation_expires_at + interval '5 minutes',
         extension_used = true, updated_at = now()
       where public_reference = $1 and status = 'pending_payment' and not extension_used
         and reservation_expires_at > now()
       returning *`,
      [reference],
    );
    if (!result.rowCount)
      throw new ConflictException('Reservation cannot be extended');
    return this.toView(result.rows[0]);
  }

  private outbox(
    tx: Transaction,
    id: string,
    type: string,
    key: string,
    payload: object,
  ) {
    return tx.query(
      `insert into outbox_events(aggregate_type, aggregate_id, event_type, partition_key, payload)
       values ('order',$1,$2,$3,$4)`,
      [id, type, key, JSON.stringify(payload)],
    );
  }

  private toView(row: OrderRow): OrderView {
    return {
      id: row.id,
      publicReference: row.public_reference,
      displayNumber: row.display_number,
      status: row.status,
      totalSatang: row.total_satang,
      currency: 'THB',
      reservationExpiresAt: row.reservation_expires_at,
      extensionUsed: row.extension_used,
      paymentReference: row.provider_payment_reference,
    };
  }
}
