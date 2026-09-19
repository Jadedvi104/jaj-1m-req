import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApp, createHttpAdapter } from '../src/app.setup';
import { DatabaseService } from '../src/database/database.service';
import { OutboxPublisherService } from '../src/messaging/outbox-publisher.service';
import { ReservationExpirerService } from '../src/reservations/reservation-expirer.service';

// Explicit opt-in: the suite owns a randomized schema in a disposable test DB.
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL test database.',
  );
}

const schema = `qa_http_${randomUUID().replaceAll('-', '')}`;
const corporationId = randomUUID();
const branchId = randomUUID();
const tableId = randomUUID();
const tablePublicId = randomUUID();
const productId = randomUUID();
const webhookToken = 'integration-webhook-secret';

interface TableSessionResponse {
  sessionId: string;
  expiresAt: string;
}

interface OrderResponse {
  id: string;
  publicReference: string;
  displayNumber: string;
  status: string;
  totalSatang: number;
  currency: 'THB';
  reservationExpiresAt: string;
  extensionUsed: boolean;
  paymentReference: string;
}

describe('HTTP + PostgreSQL integration: customer ordering journey', () => {
  let admin: Pool;
  let db: DatabaseService;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    admin = new Pool({
      connectionString: url,
      max: 1,
      ssl:
        process.env.TEST_DATABASE_SSL === 'true'
          ? {
              rejectUnauthorized: true,
              ca: process.env.TEST_DATABASE_SSL_CA,
            }
          : false,
    });
    await admin.query(`create schema "${schema}"`);

    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    db = new DatabaseService(
      new ConfigService({
        DATABASE_URL: scoped.toString(),
        DATABASE_SSL: process.env.TEST_DATABASE_SSL ?? 'false',
        DATABASE_SSL_CA: process.env.TEST_DATABASE_SSL_CA,
        DATABASE_POOL_SIZE: '4',
      }),
    );
    for (const migration of [
      '001_initial_schema.sql',
      '002_order_request_fingerprint.sql',
    ]) {
      await db.query(
        readFileSync(
          resolve(__dirname, `../database/migrations/${migration}`),
          'utf8',
        ),
      );
    }

    const config = new ConfigService({
      DATABASE_URL: scoped.toString(),
      DATABASE_SSL: process.env.TEST_DATABASE_SSL ?? 'false',
      KBANK_WEBHOOK_TOKEN: webhookToken,
      NODE_ENV: 'test',
      ENABLE_DEMO_CRUD: 'false',
    });
    const testingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue(db)
      .overrideProvider(ConfigService)
      .useValue(config)
      // The journey deliberately verifies durable outbox writes, not Kafka delivery
      // or the timer-driven expiry worker, which have dedicated unit/integration tests.
      .overrideProvider(OutboxPublisherService)
      .useValue({})
      .overrideProvider(ReservationExpirerService)
      .useValue({})
      .compile();

    app = testingModule.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 30_000);

  beforeEach(async () => {
    await db.query('truncate corporations cascade');
    await db.query('truncate outbox_events');
    await db.query('insert into corporations(id,name) values ($1,$2)', [
      corporationId,
      'HTTP Journey QA',
    ]);
    await db.query(
      'insert into branches(id,corporation_id,name) values ($1,$2,$3)',
      [branchId, corporationId, 'Central'],
    );
    await db.query(
      `insert into dining_tables(
         id,branch_id,public_id,table_number,rotating_code_hash,rotating_code_expires_at
       ) values ($1,$2,$3,'A1',encode(digest('table-code','sha256'),'hex'),now()+interval '5 minutes')`,
      [tableId, branchId, tablePublicId],
    );
    await db.query(
      "insert into products(id,corporation_id,name_th,name_en) values ($1,$2,'ข้าว','Rice')",
      [productId, corporationId],
    );
    await db.query(
      `insert into branch_menu_items(
         corporation_id,branch_id,product_id,price_satang,estimated_prep_minutes
       ) values ($1,$2,$3,1250,5)`,
      [corporationId, branchId, productId],
    );
    await db.query(
      `insert into daily_inventory(
         branch_id,product_id,business_date,available_quantity
       ) values ($1,$2,(now() at time zone 'Asia/Bangkok')::date,5)`,
      [branchId, productId],
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    else if (db) await db.onModuleDestroy();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  async function createSession(): Promise<TableSessionResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/table-sessions',
      payload: {
        branchId,
        tablePublicId,
        rotatingCode: 'table-code',
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<TableSessionResponse>();
  }

  async function createOrder(
    sessionId: string,
    idempotencyKey: string,
    overrides: Partial<{
      customerName: string;
      customerPhone: string;
      quantity: number;
    }> = {},
  ): Promise<{ statusCode: number; body: OrderResponse }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        branchId,
        tableSessionId: sessionId,
        customerName: overrides.customerName ?? 'Guest',
        customerPhone: overrides.customerPhone ?? '0800000000',
        items: [
          {
            productId,
            quantity: overrides.quantity ?? 2,
            spiceLevel: 'medium',
          },
        ],
      },
    });
    return {
      statusCode: response.statusCode,
      body: response.json<OrderResponse>(),
    };
  }

  it('completes the public order-to-payment journey through real HTTP and PostgreSQL', async () => {
    expect((await app.inject('/api/health/live')).statusCode).toBe(200);
    expect((await app.inject('/api/health/ready')).json()).toEqual({
      status: 'ready',
      database: 'ok',
    });

    const session = await createSession();
    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const created = await createOrder(session.sessionId, 'journey-happy-path');
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      displayNumber: '1',
      status: 'pending_payment',
      totalSatang: 2500,
      currency: 'THB',
      extensionUsed: false,
    });
    expect(created.body.paymentReference).toBe(
      `KB-${created.body.publicReference}`,
    );

    const publicView = await app.inject(
      `/api/orders/${created.body.publicReference}`,
    );
    expect(publicView.statusCode).toBe(200);
    expect(publicView.json()).toEqual(created.body);

    const extended = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${created.body.publicReference}/extend`,
    });
    expect(extended.statusCode).toBe(200);
    const extendedOrder = extended.json<OrderResponse>();
    expect(extendedOrder.extensionUsed).toBe(true);
    expect(
      new Date(extendedOrder.reservationExpiresAt).getTime() -
        new Date(created.body.reservationExpiresAt).getTime(),
    ).toBe(300_000);

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/webhooks/kbank/payments',
      headers: { 'x-webhook-token': 'wrong-secret' },
      payload: {
        paymentReference: created.body.paymentReference,
        transactionId: 'bank-happy-path',
        amountSatang: 2500,
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    const confirmation = {
      method: 'POST' as const,
      url: '/api/webhooks/kbank/payments',
      headers: { 'x-webhook-token': webhookToken },
      payload: {
        paymentReference: created.body.paymentReference,
        transactionId: 'bank-happy-path',
        amountSatang: 2500,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject(confirmation);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        orderId: created.body.id,
        status: 'paid',
      });
    }

    const finalView = await app.inject(
      `/api/orders/${created.body.publicReference}`,
    );
    expect(finalView.json()).toMatchObject({
      id: created.body.id,
      status: 'paid',
      extensionUsed: true,
    });
    const inventory = await db.query<{
      reserved_quantity: number;
      sold_quantity: number;
    }>(
      'select reserved_quantity,sold_quantity from daily_inventory where product_id=$1',
      [productId],
    );
    expect(inventory.rows[0]).toEqual({
      reserved_quantity: 0,
      sold_quantity: 2,
    });
    const events = await db.query<{ event_type: string }>(
      'select event_type from outbox_events order by event_type',
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      'order.paid',
      'order.reserved',
    ]);
  });

  it('replays an identical order but rejects idempotency-key reuse for changed input', async () => {
    const session = await createSession();
    const first = await createOrder(session.sessionId, 'stable-order-key');
    const replay = await createOrder(session.sessionId, 'stable-order-key');
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toEqual(first.body);

    const conflict = await createOrder(session.sessionId, 'stable-order-key', {
      customerPhone: '0899999999',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toHaveProperty('publicReference');

    const state = await db.query<{
      orders: string;
      reserved: number;
      events: string;
    }>(
      `select
         (select count(*) from orders)::text orders,
         (select reserved_quantity from daily_inventory where product_id=$1) reserved,
         (select count(*) from outbox_events)::text events`,
      [productId],
    );
    expect(state.rows[0]).toEqual({ orders: '1', reserved: 2, events: '1' });
  });

  it('keeps mismatched payments in review and makes webhook retries side-effect safe', async () => {
    const session = await createSession();
    const created = await createOrder(session.sessionId, 'review-order');
    expect(created.statusCode).toBe(201);
    const confirmation = {
      method: 'POST' as const,
      url: '/api/webhooks/kbank/payments',
      headers: { 'x-webhook-token': webhookToken },
      payload: {
        paymentReference: created.body.paymentReference,
        transactionId: 'bank-review',
        amountSatang: 2499,
      },
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject(confirmation);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        orderId: created.body.id,
        status: 'review_required',
      });
    }
    const conflictingRetry = await app.inject({
      ...confirmation,
      payload: { ...confirmation.payload, transactionId: 'replacement' },
    });
    expect(conflictingRetry.statusCode).toBe(409);

    const persisted = await db.query<{
      order_status: string;
      payment_status: string;
      received_amount_satang: number;
      reserved_quantity: number;
      sold_quantity: number;
      review_events: string;
    }>(
      `select
         o.status order_status,
         p.status payment_status,
         p.received_amount_satang,
         i.reserved_quantity,
         i.sold_quantity,
         (select count(*) from outbox_events where event_type='payment.amount_mismatch')::text review_events
       from orders o
       join payments p on p.order_id=o.id
       join daily_inventory i on i.product_id=$2 and i.branch_id=o.branch_id
       where o.id=$1`,
      [created.body.id, productId],
    );
    expect(persisted.rows[0]).toEqual({
      order_status: 'pending_payment',
      payment_status: 'review_required',
      received_amount_satang: 2499,
      reserved_quantity: 2,
      sold_quantity: 0,
      review_events: '1',
    });
  });
});
