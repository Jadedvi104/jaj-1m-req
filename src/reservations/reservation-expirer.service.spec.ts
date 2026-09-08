import { Logger } from '@nestjs/common';
import { DatabaseService, Transaction } from '../database/database.service';
import { ReservationExpirerService } from './reservation-expirer.service';

describe('ReservationExpirerService', () => {
  let query: jest.Mock;
  let service: ReservationExpirerService;
  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [] });
    service = new ReservationExpirerService({
      transaction: (work: (tx: Transaction) => Promise<unknown>) =>
        work({ query } as Transaction),
    } as DatabaseService);
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('does nothing when no reservations are due', async () => {
    await service.expireBatch();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('coalesces overlapping batches and waits for completion during shutdown', async () => {
    let finish!: (value: { rows: object[] }) => void;
    query.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = service.expireBatch();
    const second = service.expireBatch();
    expect(second).toBe(first);
    let stopped = false;
    const shutdown = service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    finish({ rows: [] });
    await Promise.all([first, second, shutdown]);
    await service.expireBatch();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('releases every expired order and emits events in the transaction', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: 'one', branch_id: 'branch', business_date: '2026-09-05' },
        { id: 'two', branch_id: 'branch', business_date: '2026-09-05' },
      ],
    });
    await service.expireBatch();
    expect(query).toHaveBeenCalledTimes(7);
    for (const id of ['one', 'two']) {
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('update daily_inventory'),
        [id, 'branch', '2026-09-05'],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("status='expired'"),
        [id],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('insert into outbox_events'),
        [id, 'branch'],
      );
    }
  });
  it('logs a failed batch and can recover on the next tick', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error('offline'));
    await service.expireBatch();
    expect(log).toHaveBeenCalled();
    await service.expireBatch();
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('runs on schedule and stops on destruction', async () => {
    jest.useFakeTimers();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(10000);
    expect(query).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(20000);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
