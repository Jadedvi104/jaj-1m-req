import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class ReservationExpirerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReservationExpirerService.name);
  private timer?: NodeJS.Timeout;
  private activeBatch?: Promise<void>;
  private stopping = false;
  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.expireBatch(), 10_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeBatch;
  }

  expireBatch(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.activeBatch ??= this.runBatch().finally(() => {
      this.activeBatch = undefined;
    });
    return this.activeBatch;
  }

  private async runBatch(): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const expired = await tx.query<{
          id: string;
          branch_id: string;
          business_date: string;
        }>(
          `select id, branch_id, business_date::text from orders
           where status='pending_payment' and reservation_expires_at <= now()
           order by reservation_expires_at for update skip locked limit 100`,
        );
        for (const order of expired.rows) {
          await tx.query(
            `update daily_inventory i set reserved_quantity=reserved_quantity-oi.quantity
             from order_items oi where oi.order_id=$1 and i.branch_id=$2
               and i.product_id=oi.product_id and i.business_date=$3`,
            [order.id, order.branch_id, order.business_date],
          );
          await tx.query(
            `update orders set status='expired', updated_at=now() where id=$1`,
            [order.id],
          );
          await tx.query(
            `insert into outbox_events(aggregate_type,aggregate_id,event_type,partition_key,payload)
             values ('order',$1::uuid,'order.expired',$2,jsonb_build_object('orderId',$1::uuid::text))`,
            [order.id, order.branch_id],
          );
        }
      });
    } catch (error) {
      this.logger.error(
        'Failed to expire reservations',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
