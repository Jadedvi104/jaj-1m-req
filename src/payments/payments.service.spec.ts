import { ConflictException, NotFoundException } from '@nestjs/common';
import { DatabaseService, Transaction } from '../database/database.service';
import { PaymentsService } from './payments.service';

const dto = {
  paymentReference: 'KB-public',
  transactionId: 'bank-1',
  amountSatang: 1200,
};
const payment = {
  payment_id: 'payment',
  order_id: 'order',
  branch_id: 'branch',
  business_date: '2026-09-05',
  expected_amount_satang: 1200,
  payment_status: 'pending',
  order_status: 'pending_payment',
  reservation_expires_at: new Date('2030-01-01'),
  provider_transaction_id: null,
  received_amount_satang: null,
  reservation_active: true,
};

describe('PaymentsService', () => {
  let query: jest.Mock;
  let service: PaymentsService;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-05T00:00:00Z'));
    query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    service = new PaymentsService({
      transaction: (work: (tx: Transaction) => Promise<unknown>) =>
        work({ query } as Transaction),
    } as DatabaseService);
  });
  afterEach(() => jest.useRealTimers());
  function arrange(overrides = {}) {
    query.mockResolvedValueOnce({
      rows: [{ ...payment, ...overrides }],
      rowCount: 1,
    });
  }
  it('rejects unknown references without mutations', async () => {
    await expect(service.confirm(dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('converts reserved stock into sold stock and emits one paid event', async () => {
    arrange();
    await expect(service.confirm(dto)).resolves.toEqual({
      orderId: 'order',
      status: 'paid',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('update daily_inventory'),
      ['order', 'branch', '2026-09-05'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status='confirmed'"),
      ['payment', 1200, 'bank-1'],
    );
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('insert into outbox_events'),
      [
        'order',
        'order.paid',
        'branch',
        JSON.stringify({ orderId: 'order', transactionId: 'bank-1' }),
      ],
    );
    expect(query).toHaveBeenCalledTimes(5);
  });
  it('acknowledges duplicate confirmation without selling twice', async () => {
    arrange({
      payment_status: 'confirmed',
      provider_transaction_id: 'bank-1',
      received_amount_satang: 1200,
    });
    await expect(service.confirm(dto)).resolves.toEqual({
      orderId: 'order',
      status: 'paid',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects another transaction for an already confirmed payment', async () => {
    arrange({
      payment_status: 'confirmed',
      provider_transaction_id: 'other',
      received_amount_satang: 1200,
    });
    await expect(service.confirm(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1199, 1201])(
    'routes amount %p to review without selling stock',
    async (amountSatang) => {
      arrange();
      await expect(
        service.confirm({ ...dto, amountSatang }),
      ).resolves.toMatchObject({ status: 'review_required' });
      expect(query).toHaveBeenCalledTimes(3);
      expect(query).toHaveBeenLastCalledWith(expect.any(String), [
        'order',
        'payment.amount_mismatch',
        'branch',
        expect.any(String),
      ]);
    },
  );
  it.each([
    { order_status: 'expired' },
    { order_status: 'paid' },
    { reservation_active: false },
  ])(
    'routes late or ineligible confirmation to review: %p',
    async (overrides) => {
      arrange(overrides);
      await expect(service.confirm(dto)).resolves.toMatchObject({
        status: 'review_required',
      });
      expect(query).toHaveBeenCalledTimes(3);
      expect(query).toHaveBeenLastCalledWith(expect.any(String), [
        'order',
        'payment.late_confirmation',
        'branch',
        expect.any(String),
      ]);
    },
  );
  it('propagates an inventory failure to the transaction boundary', async () => {
    arrange();
    query.mockRejectedValueOnce(new Error('inventory constraint'));
    await expect(service.confirm(dto)).rejects.toThrow('inventory constraint');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each([
    'confirmed',
    'review_required',
    'refund_pending',
    'partially_refunded',
  ])('acknowledges identical retries in %s without writes', async (status) => {
    arrange({
      payment_status: status,
      provider_transaction_id: dto.transactionId,
      received_amount_satang: dto.amountSatang,
    });
    await expect(service.confirm(dto)).resolves.toMatchObject({
      status: status === 'confirmed' ? 'paid' : status,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(['confirmed', 'review_required'])(
    'rejects altered amounts after %s',
    async (status) => {
      arrange({
        payment_status: status,
        provider_transaction_id: dto.transactionId,
        received_amount_satang: 1199,
      });
      await expect(service.confirm(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
  it('does not replace a mismatched payment with another transaction', async () => {
    arrange({
      payment_status: 'review_required',
      provider_transaction_id: 'original',
      received_amount_satang: 100,
    });
    await expect(service.confirm(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('fails closed for non-pending payments with no recorded transaction', async () => {
    arrange({ payment_status: 'failed' });
    await expect(service.confirm(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
