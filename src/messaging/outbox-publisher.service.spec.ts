import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { DatabaseService, Transaction } from '../database/database.service';
import { OutboxPublisherService } from './outbox-publisher.service';

jest.mock('kafkajs', () => ({ Kafka: jest.fn() }));
describe('OutboxPublisherService', () => {
  let query: jest.Mock;
  let send: jest.Mock;
  let disconnect: jest.Mock;
  let service: OutboxPublisherService;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    send = jest.fn().mockResolvedValue(undefined);
    disconnect = jest.fn().mockResolvedValue(undefined);
    (Kafka as unknown as jest.Mock).mockClear().mockImplementation(() => ({
      producer: () => ({
        connect: jest.fn().mockResolvedValue(undefined),
        send,
        disconnect,
      }),
    }));
    service = new OutboxPublisherService(
      {
        transaction: (work: (tx: Transaction) => Promise<unknown>) =>
          work({ query } as Transaction),
      } as DatabaseService,
      new ConfigService({
        KAFKA_BROKERS: 'one:9092, two:9092',
        KAFKA_SSL: 'false',
      }),
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('leaves events durable when Kafka is not configured', async () => {
    const environment = jest.replaceProperty(process, 'env', {});
    service = new OutboxPublisherService(
      {} as DatabaseService,
      new ConfigService(),
    );
    try {
      await service.onModuleInit();
    } finally {
      environment.restore();
    }
    await jest.advanceTimersByTimeAsync(500);
    expect(Kafka).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('does not send empty batches', async () => {
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(send).not.toHaveBeenCalled();
  });
  it('publishes keyed events with stable IDs before marking them delivered', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'event',
          event_type: 'order.paid',
          partition_key: 'branch',
          payload: { orderId: 'order' },
        },
      ],
      rowCount: 1,
    });
    send.mockImplementation(() => {
      expect(query).toHaveBeenCalledTimes(1);
      return Promise.resolve();
    });
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledWith({
      topic: 'orders.v1',
      acks: -1,
      messages: [
        {
          key: 'branch',
          value: JSON.stringify({
            id: 'event',
            type: 'order.paid',
            data: { orderId: 'order' },
          }),
          headers: { 'event-id': 'event', 'event-type': 'order.paid' },
        },
      ],
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('published_at=now()'),
      [['event']],
    );
  });
  it('does not mark failed sends and retries on the next tick', async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: 'event',
          event_type: 'order.paid',
          partition_key: 'branch',
          payload: {},
        },
      ],
      rowCount: 1,
    });
    send.mockRejectedValueOnce(new Error('broker down'));
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    expect(query).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('prevents overlapping publication and clears the interval on shutdown', async () => {
    let resolve!: () => void;
    query.mockResolvedValueOnce({
      rows: [{ id: 'event', payload: {} }],
      rowCount: 1,
    });
    send.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    resolve();
    await jest.advanceTimersByTimeAsync(0);
    await service.onModuleDestroy();
    const count = query.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(count);
    expect(disconnect).toHaveBeenCalled();
  });
});
