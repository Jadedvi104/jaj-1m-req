import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DatabaseService } from '../src/database/database.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { TableSessionsService } from '../src/table-sessions/table-sessions.service';
import { ReservationExpirerService } from '../src/reservations/reservation-expirer.service';

// Explicit opt-in: never use DATABASE_URL or a developer's application schema.
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL test database.',
  );
const schema = `qa_${randomUUID().replaceAll('-', '')}`;
const branch = randomUUID();
const otherBranch = randomUUID();
const corp = randomUUID();
const table = randomUUID();
const publicTable = randomUUID();
const product = randomUUID();
const product2 = randomUUID();

describe('PostgreSQL integration: real migration and domain transactions', () => {
  let admin: Pool;
  let db: DatabaseService;
  let orders: OrdersService;
  let payments: PaymentsService;
  let sessions: TableSessionsService;
  let expirer: ReservationExpirerService;
  let sessionId: string;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`create schema "${schema}"`);
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    db = new DatabaseService(
      new ConfigService({
        DATABASE_URL: scoped.toString(),
        DATABASE_SSL: process.env.TEST_DATABASE_SSL ?? 'false',
        DATABASE_POOL_SIZE: '6',
      }),
    );
    await db.query(
      readFileSync(
        resolve(__dirname, '../database/migrations/001_initial_schema.sql'),
        'utf8',
      ),
    );
    orders = new OrdersService(db);
    await db.query(
      readFileSync(
        resolve(
          __dirname,
          '../database/migrations/002_order_request_fingerprint.sql',
        ),
        'utf8',
      ),
    );
    payments = new PaymentsService(db);
    sessions = new TableSessionsService(db);
    expirer = new ReservationExpirerService(db);
  }, 30000);
  beforeEach(async () => {
    await db.query('truncate corporations cascade');
    await db.query('truncate outbox_events');
    await db.query('insert into corporations(id,name) values ($1,$2)', [
      corp,
      'QA',
    ]);
    await db.query(
      'insert into branches(id,corporation_id,name) values ($1,$3,$4),($2,$3,$4)',
      [branch, otherBranch, corp, 'Branch'],
    );
    await db.query(
      "insert into dining_tables(id,branch_id,public_id,table_number,rotating_code_hash,rotating_code_expires_at) values ($1,$2,$3,'A1',encode(digest('code','sha256'),'hex'),now()+interval '5 minutes')",
      [table, branch, publicTable],
    );
    await db.query(
      "insert into products(id,corporation_id,name_th,name_en) values ($1,$3,'ข้าว','Rice'),($2,$3,'ชา','Tea')",
      [product, product2, corp],
    );
    for (const id of [product, product2]) {
      await db.query(
        'insert into branch_menu_items(corporation_id,branch_id,product_id,price_satang,estimated_prep_minutes) values ($1,$2,$3,1000,5)',
        [corp, branch, id],
      );
      await db.query(
        "insert into daily_inventory(branch_id,product_id,business_date,available_quantity) values ($1,$2,(now() at time zone 'Asia/Bangkok')::date,5)",
        [branch, id],
      );
    }
    sessionId = (
      await sessions.create({
        branchId: branch,
        tablePublicId: publicTable,
        rotatingCode: 'code',
      })
    ).sessionId;
  });
  afterAll(async () => {
    await db?.onModuleDestroy();
    // Only the generated, identifier-safe schema belonging to this run is removed.
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });
  function dto(quantity = 1) {
    return {
      branchId: branch,
      tableSessionId: sessionId,
      customerName: 'Guest',
      customerPhone: '080',
      items: [{ productId: product, quantity }],
    };
  }
  async function stock() {
    return (
      await db.query<{ reserved_quantity: number; sold_quantity: number }>(
        'select reserved_quantity,sold_quantity from daily_inventory where product_id=$1',
        [product],
      )
    ).rows[0];
  }
  async function count(
    tableName:
      'orders' | 'payments' | 'outbox_events' | 'branch_order_counters',
  ) {
    return Number(
      (await db.query<{ count: string }>(`select count(*) from ${tableName}`))
        .rows[0].count,
    );
  }
  it('stores price/size/spice snapshots, Bangkok date, payment and reservation event', async () => {
    await db.query(
      "insert into product_sizes(branch_id,product_id,size_code,label_th,label_en,price_satang) values ($1,$2,'large','ใหญ่','Large',1500)",
      [branch, product],
    );
    const created = await orders.create(
      {
        ...dto(2),
        items: [
          {
            productId: product,
            quantity: 2,
            sizeCode: 'large',
            spiceLevel: 'medium',
          },
        ],
      },
      'create',
    );
    expect(created.totalSatang).toBe(3000);
    expect(created.displayNumber).toBe('1');
    expect(created.paymentReference).toBe(`KB-${created.publicReference}`);
    const snapshot = (
      await db.query('select * from order_items where order_id=$1', [
        created.id,
      ])
    ).rows[0];
    expect(snapshot).toMatchObject({
      quantity: 2,
      unit_price_satang: 1500,
      line_total_satang: 3000,
      spice_level: 'medium',
      size_code: 'large',
      product_name_en: 'Rice',
    });
    const timing = (
      await db.query<{ valid: boolean }>(
        "select business_date=(now() at time zone 'Asia/Bangkok')::date and reservation_expires_at between created_at+interval '599 seconds' and created_at+interval '601 seconds' valid from orders where id=$1",
        [created.id],
      )
    ).rows[0];
    expect(timing.valid).toBe(true);
    expect(await stock()).toEqual({ reserved_quantity: 2, sold_quantity: 0 });
    expect(await count('payments')).toBe(1);
    expect(await count('outbox_events')).toBe(1);
  });
  it('rolls back an entire multi-item order when any item lacks stock', async () => {
    await expect(
      orders.create(
        {
          ...dto(),
          items: [
            { productId: product, quantity: 2 },
            { productId: product2, quantity: 6 },
          ],
        },
        'no-stock',
      ),
    ).rejects.toThrow('Insufficient availability');
    expect(await stock()).toEqual({ reserved_quantity: 0, sold_quantity: 0 });
    for (const name of [
      'orders',
      'payments',
      'outbox_events',
      'branch_order_counters',
    ] as const)
      expect(await count(name)).toBe(0);
  });
  it('rolls back stock, payment, order and counter when outbox insertion fails', async () => {
    await db.query(
      "alter table outbox_events add constraint qa_reject_reserved check (event_type <> 'order.reserved')",
    );
    try {
      await expect(orders.create(dto(), 'outbox-fail')).rejects.toMatchObject({
        code: '23514',
      });
      expect(await stock()).toEqual({ reserved_quantity: 0, sold_quantity: 0 });
      for (const name of [
        'orders',
        'payments',
        'outbox_events',
        'branch_order_counters',
      ] as const)
        expect(await count(name)).toBe(0);
    } finally {
      await db.query(
        'alter table outbox_events drop constraint qa_reject_reserved',
      );
    }
  });
  it('prevents overselling under competing transactions', async () => {
    const results = await Promise.allSettled([
      orders.create(dto(4), 'race-a'),
      orders.create(dto(4), 'race-b'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await stock()).toEqual({ reserved_quantity: 4, sold_quantity: 0 });
    expect(await count('orders')).toBe(1);
  });
  it('returns one order for concurrent requests with the same idempotency key', async () => {
    const [a, b] = await Promise.all([
      orders.create(dto(), 'same'),
      orders.create(dto(), 'same'),
    ]);
    expect(a.id).toBe(b.id);
    expect(await count('orders')).toBe(1);
    expect(await stock()).toEqual({ reserved_quantity: 1, sold_quantity: 0 });
    expect(await count('outbox_events')).toBe(1);
  });
  it('allocates distinct sequential order numbers under concurrency', async () => {
    const results = await Promise.all([
      orders.create(dto(), 'first'),
      orders.create(dto(), 'second'),
    ]);
    expect(results.map((order) => Number(order.displayNumber)).sort()).toEqual([
      1, 2,
    ]);
  });
  it('accepts only one extension and adds exactly five minutes', async () => {
    const created = await orders.create(dto(), 'extend');
    const results = await Promise.allSettled([
      orders.extend(created.publicReference),
      orders.extend(created.publicReference),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const updated = await orders.findPublic(created.publicReference);
    expect(updated.extensionUsed).toBe(true);
    expect(
      new Date(updated.reservationExpiresAt).getTime() -
        new Date(created.reservationExpiresAt).getTime(),
    ).toBe(300000);
  });
  it('confirms duplicate payments once and moves reserved stock to sold stock', async () => {
    const created = await orders.create(dto(2), 'pay');
    const confirmation = {
      paymentReference: created.paymentReference!,
      transactionId: 'bank-1',
      amountSatang: 2000,
    };
    const results = await Promise.all([
      payments.confirm(confirmation),
      payments.confirm(confirmation),
    ]);
    expect(results).toEqual([
      { orderId: created.id, status: 'paid' },
      { orderId: created.id, status: 'paid' },
    ]);
    expect(await stock()).toEqual({ reserved_quantity: 0, sold_quantity: 2 });
    expect(await count('outbox_events')).toBe(2);
  });
  it('routes amount mismatch to review without changing stock', async () => {
    const created = await orders.create(dto(), 'mismatch');
    await expect(
      payments.confirm({
        paymentReference: created.paymentReference!,
        transactionId: 'bank-1',
        amountSatang: 999,
      }),
    ).resolves.toMatchObject({ status: 'review_required' });
    expect(await stock()).toEqual({ reserved_quantity: 1, sold_quantity: 0 });
    expect((await orders.findPublic(created.publicReference)).status).toBe(
      'pending_payment',
    );
  });
  it('expires once, releases stock, and routes late payment to review', async () => {
    const created = await orders.create(dto(2), 'expire');
    await db.query(
      "update orders set reservation_expires_at=now()-interval '1 second' where id=$1",
      [created.id],
    );
    await expirer.expireBatch();
    await expirer.expireBatch();
    expect(await stock()).toEqual({ reserved_quantity: 0, sold_quantity: 0 });
    expect((await orders.findPublic(created.publicReference)).status).toBe(
      'expired',
    );
    expect(await count('outbox_events')).toBe(2);
    await expect(
      payments.confirm({
        paymentReference: created.paymentReference!,
        transactionId: 'late',
        amountSatang: 2000,
      }),
    ).resolves.toMatchObject({ status: 'review_required' });
    expect(await stock()).toEqual({ reserved_quantity: 0, sold_quantity: 0 });
    await expect(orders.extend(created.publicReference)).rejects.toThrow(
      'cannot be extended',
    );
  });
  it('keeps inventory consistent when expiry and a late payment race', async () => {
    const created = await orders.create(dto(), 'expiry-race');
    await db.query(
      "update orders set reservation_expires_at=now()-interval '1 second' where id=$1",
      [created.id],
    );
    await Promise.all([
      expirer.expireBatch(),
      payments.confirm({
        paymentReference: created.paymentReference!,
        transactionId: 'late-race',
        amountSatang: 1000,
      }),
    ]);
    await expirer.expireBatch();
    expect(await stock()).toEqual({ reserved_quantity: 0, sold_quantity: 0 });
    expect((await orders.findPublic(created.publicReference)).status).toBe(
      'expired',
    );
  });
  it('rejects wrong branch, wrong presence code, and expired sessions', async () => {
    await expect(
      sessions.create({
        branchId: otherBranch,
        tablePublicId: publicTable,
        rotatingCode: 'code',
      }),
    ).rejects.toThrow('Invalid');
    await expect(
      sessions.create({
        branchId: branch,
        tablePublicId: publicTable,
        rotatingCode: 'wrong',
      }),
    ).rejects.toThrow('Invalid');
    await expect(
      orders.create({ ...dto(), branchId: otherBranch }, 'cross-branch'),
    ).rejects.toThrow('Invalid');
    await db.query(
      "update table_sessions set expires_at=now()-interval '1 second'",
    );
    await expect(orders.create(dto(), 'old-session')).rejects.toThrow(
      'Invalid',
    );
  });
  it('hides an order after public access expires', async () => {
    const created = await orders.create(dto(), 'public-expiry');
    await db.query(
      "update orders set public_access_expires_at=now()-interval '1 second' where id=$1",
      [created.id],
    );
    await expect(orders.findPublic(created.publicReference)).rejects.toThrow(
      'Order not found',
    );
    await expect(orders.extend(created.publicReference)).rejects.toThrow(
      'cannot be extended',
    );
    await expect(orders.create(dto(), 'public-expiry')).rejects.toMatchObject({
      status: 409,
    });
  });
  it('binds idempotency to the originating session and complete request', async () => {
    const original = dto();
    await orders.create(original, 'bound-key');
    const anotherSession = await sessions.create({
      branchId: branch,
      tablePublicId: publicTable,
      rotatingCode: 'code',
    });
    await expect(
      orders.create(
        { ...original, tableSessionId: anotherSession.sessionId },
        'bound-key',
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      orders.create({ ...original, customerPhone: 'different' }, 'bound-key'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count('orders')).toBe(1);
    expect(await stock()).toEqual({ reserved_quantity: 1, sold_quantity: 0 });
  });
  it('preserves review-required payment data and emits only one review event for retries', async () => {
    const created = await orders.create(dto(), 'review-retry');
    const confirmation = {
      paymentReference: created.paymentReference!,
      transactionId: 'original-bank-txn',
      amountSatang: 999,
    };
    await payments.confirm(confirmation);
    await expect(payments.confirm(confirmation)).resolves.toMatchObject({
      status: 'review_required',
    });
    await expect(
      payments.confirm({
        ...confirmation,
        transactionId: 'replacement',
        amountSatang: 1000,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      payments.confirm({ ...confirmation, amountSatang: 1000 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count('outbox_events')).toBe(2);
    expect(await stock()).toEqual({ reserved_quantity: 1, sold_quantity: 0 });
    expect(
      (
        await db.query(
          'select provider_transaction_id, received_amount_satang from payments where order_id=$1',
          [created.id],
        )
      ).rows[0],
    ).toMatchObject({
      provider_transaction_id: 'original-bank-txn',
      received_amount_satang: 999,
    });
  });
  it('reserves overlapping multi-product requests supplied in opposite orders', async () => {
    const items = [
      { productId: product, quantity: 1 },
      { productId: product2, quantity: 1 },
    ];
    const results = await Promise.all([
      orders.create({ ...dto(), items }, 'ordered-a'),
      orders.create({ ...dto(), items: [...items].reverse() }, 'ordered-b'),
    ]);
    expect(results).toHaveLength(2);
    expect(results.map((order) => order.totalSatang)).toEqual([2000, 2000]);
    expect(await stock()).toEqual({ reserved_quantity: 2, sold_quantity: 0 });
  });
  it('enforces inventory constraints and cross-branch table relationships', async () => {
    await expect(
      db.query(
        'update daily_inventory set reserved_quantity=6 where product_id=$1',
        [product],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db.query(
        'insert into table_sessions(branch_id,table_id) values ($1,$2)',
        [otherBranch, table],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('allows exact remaining stock and rejects the next reservation', async () => {
    await orders.create(dto(5), 'last-stock');
    await expect(orders.create(dto(), 'no-more')).rejects.toThrow(
      'Insufficient',
    );
    expect(await stock()).toEqual({ reserved_quantity: 5, sold_quantity: 0 });
  });

  it('rejects unavailable menus, inactive products, and unknown sizes', async () => {
    await db.query(
      'update branch_menu_items set available=false where product_id=$1',
      [product],
    );
    await expect(orders.create(dto(), 'unavailable')).rejects.toThrow(
      'unavailable',
    );
    await db.query(
      'update branch_menu_items set available=true where product_id=$1',
      [product],
    );
    await db.query('update products set active=false where id=$1', [product]);
    await expect(orders.create(dto(), 'inactive')).rejects.toThrow(
      'unavailable',
    );
    await db.query('update products set active=true where id=$1', [product]);
    await expect(
      orders.create(
        {
          ...dto(),
          items: [{ productId: product, quantity: 1, sizeCode: 'unknown' }],
        },
        'unknown-size',
      ),
    ).rejects.toThrow('unavailable');
    expect(await count('orders')).toBe(0);
  });

  it('rejects expired rotating codes and inactive tables', async () => {
    await db.query(
      "update dining_tables set rotating_code_expires_at=now()-interval '1 second'",
    );
    await expect(
      sessions.create({
        branchId: branch,
        tablePublicId: publicTable,
        rotatingCode: 'code',
      }),
    ).rejects.toThrow('Invalid');
    await db.query(
      "update dining_tables set rotating_code_expires_at=now()+interval '5 minutes', active=false",
    );
    await expect(
      sessions.create({
        branchId: branch,
        tablePublicId: publicTable,
        rotatingCode: 'code',
      }),
    ).rejects.toThrow('Invalid');
    await expect(orders.create(dto(), 'inactive-table')).rejects.toThrow(
      'Invalid',
    );
  });

  it('does not permit one provider transaction to pay two orders', async () => {
    const first = await orders.create(dto(), 'first-pay');
    const second = await orders.create(dto(), 'second-pay');
    await payments.confirm({
      paymentReference: first.paymentReference!,
      transactionId: 'unique-bank-txn',
      amountSatang: 1000,
    });
    await expect(
      payments.confirm({
        paymentReference: second.paymentReference!,
        transactionId: 'unique-bank-txn',
        amountSatang: 1000,
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await stock()).toEqual({ reserved_quantity: 1, sold_quantity: 1 });
    expect((await orders.findPublic(second.publicReference)).status).toBe(
      'pending_payment',
    );
  });

  it('enforces corporation ownership for branch menu entries', async () => {
    const otherCorp = randomUUID();
    const foreignProduct = randomUUID();
    await db.query("insert into corporations(id,name) values ($1,'Other')", [
      otherCorp,
    ]);
    await db.query(
      "insert into products(id,corporation_id,name_th,name_en) values ($1,$2,'อื่น','Other')",
      [foreignProduct, otherCorp],
    );
    await expect(
      db.query(
        'insert into branch_menu_items(corporation_id,branch_id,product_id,price_satang,estimated_prep_minutes) values ($1,$2,$3,100,1)',
        [corp, branch, foreignProduct],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
