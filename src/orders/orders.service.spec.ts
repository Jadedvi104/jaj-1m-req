import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, Transaction } from '../database/database.service';
import { OrdersService } from './orders.service';
import { orderFingerprint } from './order-policy';

const row = {
  id: 'order',
  public_reference: 'public',
  display_number: '12',
  status: 'pending_payment',
  total_satang: 2400,
  reservation_expires_at: new Date('2030-01-01'),
  extension_used: false,
  table_session_id: 'session',
  public_access_valid: true,
  request_fingerprint: '',
};
const dto = {
  branchId: 'branch',
  tableSessionId: 'session',
  customerName: 'Guest',
  customerPhone: '080',
  items: [{ productId: 'product', quantity: 2 }],
};
const menu = {
  product_id: 'product',
  name_th: 'อาหาร',
  name_en: 'Food',
  base_price: 1200,
  size_price: null,
  available_quantity: 10,
  reserved_quantity: 2,
  sold_quantity: 3,
};
row.request_fingerprint = orderFingerprint(dto);
const result = (rows: object[] = []) => ({ rows, rowCount: rows.length });

describe('OrdersService', () => {
  let query: jest.Mock;
  let direct: jest.Mock;
  let transaction: jest.Mock;
  let service: OrdersService;
  beforeEach(() => {
    query = jest.fn().mockResolvedValue(result());
    direct = jest.fn();
    transaction = jest.fn((work: (tx: Transaction) => Promise<unknown>) =>
      work({ query } as Transaction),
    );
    service = new OrdersService({
      query: direct,
      transaction,
    } as unknown as DatabaseService);
  });
  function arrange(selected = menu) {
    query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result([
          { table_id: 'table', table_number: 'A1', corporation_id: 'corp' },
        ]),
      )
      .mockResolvedValueOnce(result([selected]))
      .mockResolvedValueOnce(result([{ day: '2026-09-05' }]))
      .mockResolvedValueOnce(result([{ last_number: '12' }]))
      .mockResolvedValueOnce(result([row]));
  }
  it.each(['', ' ', undefined])(
    'rejects missing idempotency key %p without opening a transaction',
    async (key) => {
      await expect(service.create(dto, key as string)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects repeated products before reserving anything', async () => {
    await expect(
      service.create({ ...dto, items: [dto.items[0], dto.items[0]] }, 'key'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('returns an existing order without writes', async () => {
    query.mockResolvedValueOnce(
      result([{ ...row, provider_payment_reference: 'KB-public' }]),
    );
    await expect(service.create(dto, 'key')).resolves.toMatchObject({
      publicReference: 'public',
      paymentReference: 'KB-public',
      currency: 'THB',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects an invalid session before checking inventory', async () => {
    await expect(service.create(dto, 'key')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([null, { ...menu, size_price: null }])(
    'rejects unavailable product or size %p',
    async (selected) => {
      query
        .mockResolvedValueOnce(result())
        .mockResolvedValueOnce(result([{ corporation_id: 'corp' }]))
        .mockResolvedValueOnce(result(selected ? [selected] : []));
      await expect(
        service.create(
          { ...dto, items: [{ ...dto.items[0], sizeCode: 'large' }] },
          'key',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(query).toHaveBeenCalledTimes(3);
    },
  );
  it('subtracts both sold and reserved units when checking stock', async () => {
    arrange({ ...menu, available_quantity: 6 });
    await expect(service.create(dto, 'key')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(query).toHaveBeenCalledTimes(3);
  });
  it.each([null, 1500, 0])(
    'creates stock, price snapshots, payment and outbox atomically for size price %p',
    async (sizePrice) => {
      arrange({ ...menu, size_price: sizePrice } as typeof menu);
      const created = await service.create(dto, 'key');
      const price = sizePrice ?? 1200;
      expect(created).toMatchObject({
        id: 'order',
        displayNumber: '12',
        paymentReference: 'KB-public',
      });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('insert into orders('),
        [
          'corp',
          'branch',
          'table',
          'session',
          '2026-09-05',
          '12',
          'key',
          'Guest',
          '080',
          'A1',
          price * 2,
          orderFingerprint(dto),
        ],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('update daily_inventory'),
        ['branch', 'product', '2026-09-05', 2],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('insert into order_items'),
        [
          'corp',
          'order',
          'product',
          'อาหาร',
          'Food',
          null,
          null,
          2,
          price,
          price * 2,
        ],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('insert into payments'),
        ['order', 'KB-public', price * 2],
      );
      expect(query).toHaveBeenLastCalledWith(
        expect.stringContaining('insert into outbox_events'),
        ['order', 'order.reserved', 'branch', expect.any(String)],
      );
      expect(direct).not.toHaveBeenCalled();
    },
  );
  it('recovers a concurrent idempotency unique conflict', async () => {
    transaction.mockRejectedValueOnce({
      code: '23505',
      constraint: 'orders_branch_idempotency_unique',
    });
    direct.mockResolvedValueOnce(result([row]));
    await expect(service.create(dto, 'key')).resolves.toMatchObject({
      id: 'order',
    });
    expect(direct).toHaveBeenCalledWith(expect.any(String), ['branch', 'key']);
  });
  it.each([
    { code: '23505', constraint: 'other' },
    { code: '23505', constraint: 'orders_branch_idempotency_unique' },
    new Error('offline'),
  ])('propagates unrecoverable failures %p', async (error) => {
    transaction.mockRejectedValueOnce(error);
    direct.mockResolvedValue(result());
    await expect(service.create(dto, 'key')).rejects.toBe(error);
  });
  it('returns a public view and hides persistence-only fields', async () => {
    direct.mockResolvedValue(result([{ ...row, customer_phone: 'secret' }]));
    const view = await service.findPublic('public');
    expect(view).toMatchObject({
      publicReference: 'public',
      totalSatang: 2400,
    });
    expect(view).not.toHaveProperty('customer_phone');
  });
  it('maps missing or expired public access to 404', async () => {
    direct.mockResolvedValue(result());
    await expect(service.findPublic('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('returns an extended reservation', async () => {
    direct.mockResolvedValue(result([{ ...row, extension_used: true }]));
    await expect(service.extend('public')).resolves.toMatchObject({
      extensionUsed: true,
    });
  });
  it('maps ineligible extensions to conflict', async () => {
    direct.mockResolvedValue(result());
    await expect(service.extend('public')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it.each([
    { table_session_id: 'another-session' },
    { request_fingerprint: 'different-body' },
    { request_fingerprint: null },
    { public_access_valid: false },
  ])(
    'rejects unsafe idempotency replay %p on both lookup paths',
    async (override) => {
      const stored = result([{ ...row, ...override }]);
      query.mockResolvedValueOnce(stored);
      await expect(service.create(dto, 'key')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(query).toHaveBeenCalledTimes(1);
      transaction.mockRejectedValueOnce({
        code: '23505',
        constraint: 'orders_branch_idempotency_unique',
      });
      direct.mockResolvedValueOnce(stored);
      await expect(service.create(dto, 'key')).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );
  it('loads multiple menu items once and preserves their price/quantity association', async () => {
    query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result([
          { table_id: 'table', table_number: 'A1', corporation_id: 'corp' },
        ]),
      )
      .mockResolvedValueOnce(
        result([
          { ...menu, product_id: 'a', base_price: 100 },
          { ...menu, product_id: 'z', base_price: 200 },
        ]),
      )
      .mockResolvedValueOnce(result([{ day: '2026-09-05' }]))
      .mockResolvedValueOnce(result([{ last_number: '12' }]))
      .mockResolvedValueOnce(result([row]));
    const items = [
      { productId: 'z', quantity: 2 },
      { productId: 'a', quantity: 1 },
    ];
    await service.create({ ...dto, items }, 'key');
    const menuCalls = query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('from unnest'),
    );
    expect(menuCalls).toHaveLength(1);
    expect(menuCalls[0]).toEqual([
      expect.stringContaining('order by i.product_id'),
      ['corp', 'branch', ['z', 'a'], [null, null]],
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('insert into payments'),
      ['order', 'KB-public', 500],
    );
    expect(items[0].productId).toBe('z');
  });
  it('rejects totals that cannot fit the database before allocating an order number', async () => {
    arrange({ ...menu, base_price: 2_147_483_647 });
    await expect(service.create(dto, 'key')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(query).toHaveBeenCalledTimes(3);
  });
});
