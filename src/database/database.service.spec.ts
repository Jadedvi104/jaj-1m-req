import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DatabaseService } from './database.service';

jest.mock('pg', () => ({ Pool: jest.fn() }));
describe('DatabaseService transaction safety', () => {
  let query: jest.Mock;
  let release: jest.Mock;
  let connect: jest.Mock;
  let poolQuery: jest.Mock;
  let end: jest.Mock;
  let service: DatabaseService;
  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [] });
    release = jest.fn();
    connect = jest.fn().mockResolvedValue({ query, release });
    poolQuery = jest.fn().mockResolvedValue({ rows: [{ ok: true }] });
    end = jest.fn().mockResolvedValue(undefined);
    (Pool as unknown as jest.Mock).mockImplementation(() => ({
      connect,
      query: poolQuery,
      end,
      on: jest.fn(),
    }));
    service = new DatabaseService(
      new ConfigService({
        DATABASE_URL: 'postgres://test',
        DATABASE_SSL: 'false',
      }),
    );
  });
  it('commits successful work and releases the connection', async () => {
    await expect(
      service.transaction(() => Promise.resolve('done')),
    ).resolves.toBe('done');
    expect(query.mock.calls).toEqual([
      ['begin isolation level serializable'],
      ['commit'],
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('rolls back nonretryable work and releases the connection', async () => {
    const error = new Error('failure');
    await expect(service.transaction(() => Promise.reject(error))).rejects.toBe(
      error,
    );
    expect(query.mock.calls).toEqual([
      ['begin isolation level serializable'],
      ['rollback'],
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each(['40001', '40P01'])(
    'retries %s and eventually commits',
    async (code) => {
      const work = jest
        .fn()
        .mockRejectedValueOnce({ code })
        .mockResolvedValue('done');
      await expect(service.transaction(work)).resolves.toBe('done');
      expect(work).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
      expect(query.mock.calls.map(([sql]: [string]) => sql)).toEqual([
        'begin isolation level serializable',
        'rollback',
        'begin isolation level serializable',
        'commit',
      ]);
    },
  );
  it('bounds retries at three attempts', async () => {
    const error = { code: '40001' };
    const work = jest.fn().mockRejectedValue(error);
    await expect(service.transaction(work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });
  it('releases after commit fails', async () => {
    query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('commit failed'));
    await expect(service.transaction(() => Promise.resolve())).rejects.toThrow(
      'commit failed',
    );
    expect(query).toHaveBeenLastCalledWith('rollback');
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('propagates pool exhaustion without executing work', async () => {
    connect.mockRejectedValue(new Error('pool timeout'));
    const work = jest.fn();
    await expect(service.transaction(work)).rejects.toThrow('pool timeout');
    expect(work).not.toHaveBeenCalled();
  });
  it('forwards parameterized queries and closes the pool', async () => {
    await service.query('select $1', [42]);
    expect(poolQuery).toHaveBeenCalledWith('select $1', [42]);
    await service.query('select 2');
    expect(poolQuery).toHaveBeenLastCalledWith('select 2', []);
    await service.ping();
    expect(poolQuery).toHaveBeenLastCalledWith('select 1');
    await service.onModuleDestroy();
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('requires a database URL', () => {
    const environment = jest.replaceProperty(process, 'env', {});
    try {
      expect(() => new DatabaseService(new ConfigService())).toThrow();
    } finally {
      environment.restore();
    }
  });
  it('verifies database certificates by default and supports a custom CA', () => {
    new DatabaseService(
      new ConfigService({
        DATABASE_URL: 'postgres://test',
        DATABASE_SSL_CA: 'ca-pem',
      }),
    );
    expect(Pool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ssl: { rejectUnauthorized: true, ca: 'ca-pem' },
      }),
    );
  });
  it.each([
    'sslmode=no-verify',
    'ssl=false',
    'sslrootcert=file',
    'uselibpqcompat=true',
  ])('rejects URL TLS overrides: %s', (parameter) => {
    expect(
      () =>
        new DatabaseService(
          new ConfigService({ DATABASE_URL: `postgres://test?${parameter}` }),
        ),
    ).toThrow('Configure database TLS');
  });
  it.each(['0', '-1', '1.5', '101', 'NaN'])(
    'rejects invalid pool size %s',
    (size) => {
      expect(
        () =>
          new DatabaseService(
            new ConfigService({
              DATABASE_URL: 'postgres://test',
              DATABASE_POOL_SIZE: size,
            }),
          ),
      ).toThrow('DATABASE_POOL_SIZE');
    },
  );
  it('rejects an ambiguous TLS flag', () => {
    expect(
      () =>
        new DatabaseService(
          new ConfigService({
            DATABASE_URL: 'postgres://test',
            DATABASE_SSL: 'yes',
          }),
        ),
    ).toThrow('DATABASE_SSL');
  });
  it('discards a broken connection and preserves the original error if rollback fails', async () => {
    const original = new Error('original failure');
    query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('rollback failure'));
    await expect(
      service.transaction(() => Promise.reject(original)),
    ).rejects.toBe(original);
    expect(release).toHaveBeenCalledWith(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('releases the connection before retry backoff', async () => {
    jest.useFakeTimers();
    try {
      const work = jest
        .fn()
        .mockRejectedValueOnce({ code: '40001' })
        .mockResolvedValue('ok');
      const pending = service.transaction(work);
      await jest.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(1);
      await jest.runAllTimersAsync();
      await expect(pending).resolves.toBe('ok');
    } finally {
      jest.useRealTimers();
    }
  });
  it('preserves non-Error rejections', async () => {
    await expect(
      // Deliberately test a third-party dependency rejecting with a non-Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      service.transaction(() => Promise.reject(null)),
    ).rejects.toBeNull();
  });
});
