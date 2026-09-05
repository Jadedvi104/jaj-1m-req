import { Test } from '@nestjs/testing';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { configureApp, createHttpAdapter } from '../src/app.setup';
import { DatabaseService } from '../src/database/database.service';
import { OutboxPublisherService } from '../src/messaging/outbox-publisher.service';
import { ReservationExpirerService } from '../src/reservations/reservation-expirer.service';

const id = '00000000-0000-4000-8000-000000000001';
const order = {
  branchId: id,
  tableSessionId: id,
  customerName: 'Guest',
  customerPhone: '080',
  items: [{ productId: id, quantity: 1 }],
};
const payment = {
  paymentReference: 'KB-order',
  transactionId: 'bank-1',
  amountSatang: 100,
};

describe('Production Fastify HTTP contract (isolated database)', () => {
  let app: NestFastifyApplication;
  const db = { query: jest.fn(), ping: jest.fn(), transaction: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(db)
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ KBANK_WEBHOOK_TOKEN: 'test-secret' }))
      .overrideProvider(OutboxPublisherService)
      .useValue({})
      .overrideProvider(ReservationExpirerService)
      .useValue({})
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    db.query.mockResolvedValue({ rowCount: 0, rows: [] });
    db.ping.mockResolvedValue(undefined);
    db.transaction.mockImplementation(
      (work: (tx: typeof db) => Promise<unknown>) => work(db),
    );
  });
  afterAll(async () => {
    await app?.close();
  });
  it('serves the root only under /api', async () => {
    expect((await app.inject({ method: 'GET', url: '/api' })).body).toBe(
      'Hello World!',
    );
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(
      404,
    );
  });
  it('keeps liveness independent from database failure', async () => {
    db.ping.mockRejectedValue(new Error('secret connection string'));
    expect((await app.inject('/api/health/live')).json()).toEqual({
      status: 'ok',
    });
    const response = await app.inject('/api/health/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      database: 'unavailable',
    });
    expect(response.body).not.toContain('secret');
  });
  it('reports database readiness', async () => {
    expect((await app.inject('/api/health/ready')).json()).toEqual({
      status: 'ready',
      database: 'ok',
    });
  });
  describe.each([
    {
      route: 'users',
      payload: { name: 'Ada', email: 'ada@example.com' },
      patch: { name: 'Grace' },
    },
    {
      route: 'products',
      payload: { name: 'Rice', price: 12.5, description: 'Food' },
      patch: { name: 'Noodles' },
    },
  ])('$route CRUD', ({ route, payload, patch }) => {
    it('supports create/list/read/partial update/delete with real services', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/${route}`,
        payload,
      });
      expect(created.statusCode).toBe(201);
      const entity = created.json<{ id: number }>();
      expect(entity).toMatchObject(payload);
      expect((await app.inject(`/api/${route}`)).json()).toContainEqual(entity);
      expect((await app.inject(`/api/${route}/${entity.id}`)).json()).toEqual(
        entity,
      );
      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/${route}/${entity.id}`,
        payload: patch,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ ...entity, ...patch });
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/${route}/${entity.id}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual(updated.json());
      expect((await app.inject(`/api/${route}/${entity.id}`)).statusCode).toBe(
        404,
      );
    });
    it.each(['GET', 'PATCH', 'DELETE'] as const)(
      'rejects malformed and unknown IDs on %s',
      async (method) => {
        expect(
          (
            await app.inject({
              method,
              url: `/api/${route}/abc`,
              ...(method === 'PATCH' ? { payload: {} } : {}),
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await app.inject({
              method,
              url: `/api/${route}/99999`,
              ...(method === 'PATCH' ? { payload: {} } : {}),
            })
          ).statusCode,
        ).toBe(404);
      },
    );
    it('rejects unknown properties and empty creates', async () => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/${route}`,
            payload: { ...payload, admin: true },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/${route}`,
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
    });
  });
  it.each([
    ['users', { name: '', email: 'bad' }],
    ['users', { name: 'A', email: 12 }],
    ['products', { name: 'A', price: -1 }],
    ['products', { name: 'A', price: '12' }],
    ['products', { name: 'A', price: 1, description: null }],
  ])('rejects invalid %s input %p', async (route, payload) => {
    expect(
      (await app.inject({ method: 'POST', url: `/api/${route}`, payload }))
        .statusCode,
    ).toBe(400);
  });
  it.each([
    {},
    { ...order, branchId: 'bad' },
    { ...order, items: [] },
    { ...order, items: [{ productId: id, quantity: 0 }] },
    { ...order, items: [{ productId: id, quantity: 1.5 }] },
    { ...order, items: [{ productId: id, quantity: '1' }] },
    { ...order, items: [{ productId: id, quantity: 1, price: 0 }] },
    { ...order, customerName: 'a'.repeat(101) },
  ])('rejects malformed order before database access: %p', async (payload) => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/orders',
          headers: { 'idempotency-key': 'key' },
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('requires an idempotency header', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/orders', payload: order }))
        .statusCode,
    ).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('returns existing order through the real order controller and service', async () => {
    db.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id,
          public_reference: id,
          display_number: '1',
          status: 'pending_payment',
          total_satang: 100,
          extension_used: false,
        },
      ],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'idempotency-key': 'key' },
      payload: order,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      publicReference: id,
      totalSatang: 100,
      currency: 'THB',
    });
  });
  it.each([
    ['GET', '/api/orders/bad', 400],
    ['PATCH', '/api/orders/bad/extend', 400],
    ['GET', `/api/orders/${id}`, 404],
    ['PATCH', `/api/orders/${id}/extend`, 409],
  ] as const)('%s %s returns %s', async (method, url, status) => {
    expect((await app.inject({ method, url })).statusCode).toBe(status);
  });
  it('creates a table session and rejects invalid codes', async () => {
    const payload = { branchId: id, tablePublicId: id, rotatingCode: 'code' };
    db.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id, expires_at: new Date('2030-01-01') }],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/table-sessions',
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ sessionId: id });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/table-sessions',
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/table-sessions',
          payload: { ...payload, rotatingCode: '' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it.each([undefined, 'wrong', 'test-secrex'])(
    'rejects webhook token %p without payment processing',
    async (token) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/kbank/payments',
        headers: token ? { 'x-webhook-token': token } : {},
        payload: payment,
      });
      expect(response.statusCode).toBe(401);
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );
  it('accepts the configured webhook token and maps missing payment to 404', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/webhooks/kbank/payments',
          headers: { 'x-webhook-token': 'test-secret' },
          payload: payment,
        })
      ).statusCode,
    ).toBe(404);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it.each([-1, 1.5, '100'])(
    'rejects invalid payment amount %p',
    async (amountSatang) => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/webhooks/kbank/payments',
            headers: { 'x-webhook-token': 'test-secret' },
            payload: { ...payment, amountSatang },
          })
        ).statusCode,
      ).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed JSON and oversized bodies', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/orders',
          headers: { 'content-type': 'application/json' },
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/orders',
          payload: { data: 'x'.repeat(65536) },
        })
      ).statusCode,
    ).toBe(413);
  });
  it('does not leak database errors over HTTP', async () => {
    db.query.mockRejectedValue(new Error('private database credentials'));
    const response = await app.inject(`/api/orders/${id}`);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('credentials');
  });
});
