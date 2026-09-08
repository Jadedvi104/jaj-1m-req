import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { DatabaseService } from '../database/database.service';

interface OutboxRow {
  id: string;
  event_type: string;
  partition_key: string;
  payload: object;
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private producer?: Producer;
  private timer?: NodeJS.Timeout;
  private activeBatch?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const brokers = this.config.get<string>('KAFKA_BROKERS');
    if (!brokers) {
      this.logger.warn(
        'KAFKA_BROKERS is not configured; outbox events remain durable for later delivery',
      );
      return;
    }
    const username = this.config.get<string>('KAFKA_SASL_USERNAME');
    const password = this.config.get<string>('KAFKA_SASL_PASSWORD');
    const kafka = new Kafka({
      clientId: 'restaurant-ordering-api',
      brokers: brokers.split(',').map((broker) => broker.trim()),
      // Event Hubs requires a longer request timeout for idempotent producers.
      requestTimeout: 60_000,
      ssl: this.config.get('KAFKA_SSL', 'true') === 'true',
      sasl:
        username && password
          ? { mechanism: 'plain', username, password }
          : undefined,
    });
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      metadataMaxAge: 180_000,
    });
    await this.producer.connect();
    this.timer = setInterval(() => void this.publishBatch(), 250);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeBatch;
    await this.producer?.disconnect();
  }

  private publishBatch(): Promise<void> {
    if (!this.producer || this.stopping) return Promise.resolve();
    this.activeBatch ??= this.runBatch(this.producer).finally(() => {
      this.activeBatch = undefined;
    });
    return this.activeBatch;
  }

  private async runBatch(producer: Producer): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const result = await tx.query<OutboxRow>(
          `select id, event_type, partition_key, payload from outbox_events
           where published_at is null order by occurred_at
           for update skip locked limit 100`,
        );
        if (!result.rowCount) return;
        await producer.send({
          topic: this.config.get('KAFKA_ORDER_TOPIC', 'orders.v1'),
          acks: -1,
          messages: result.rows.map((event) => ({
            key: event.partition_key,
            value: JSON.stringify({
              id: event.id,
              type: event.event_type,
              data: event.payload,
            }),
            headers: { 'event-id': event.id, 'event-type': event.event_type },
          })),
        });
        await tx.query(
          `update outbox_events set published_at=now(), attempts=attempts+1
           where id = any($1::uuid[])`,
          [result.rows.map((event) => event.id)],
        );
      });
    } catch (error) {
      this.logger.error(
        'Outbox publication failed; events will retry',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
