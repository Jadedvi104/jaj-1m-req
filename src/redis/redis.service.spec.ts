import { RedisClient, RedisService } from './redis.service';

describe('RedisService', () => {
  const connectMock = jest.fn();
  const getMock = jest.fn();
  const setMock = jest.fn();
  const closeMock = jest.fn();
  const client = {
    isOpen: false,
    isReady: false,
    connect: connectMock,
    get: getMock,
    set: setMock,
    del: jest.fn(),
    close: closeMock,
  } as unknown as RedisClient;

  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(client, { isOpen: false, isReady: false });
    connectMock.mockResolvedValue(client);
    service = new RedisService(client);
  });

  it('connects lazily and reuses the same connection', async () => {
    getMock.mockResolvedValue('value');

    await expect(service.get('key')).resolves.toBe('value');
    await service.get('key');

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('key');
  });

  it('sets a value with an optional TTL', async () => {
    await service.set('key', 'value', 60);

    expect(setMock).toHaveBeenCalledWith('key', 'value', {
      expiration: { type: 'EX', value: 60 },
    });
  });

  it('closes an open connection during shutdown', async () => {
    Object.assign(client, { isOpen: true });

    await service.onApplicationShutdown();

    expect(closeMock).toHaveBeenCalled();
  });
});

// Connection failure and contention are important even though Redis is currently optional.
describe('Redis failure and concurrency behavior', () => {
  function setup() {
    const client = {
      isOpen: false,
      isReady: false,
      connect: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      close: jest.fn(),
    };
    client.connect.mockResolvedValue(client);
    return {
      client,
      service: new RedisService(client as unknown as RedisClient),
    };
  }
  it('coalesces concurrent connection attempts', async () => {
    const { client, service } = setup();
    await Promise.all([service.get('a'), service.get('b'), service.del('c')]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.del).toHaveBeenCalledWith('c');
  });
  it('retries connection after a failed attempt', async () => {
    const { client, service } = setup();
    client.connect.mockRejectedValueOnce(new Error('offline'));
    await expect(service.get('a')).rejects.toThrow('offline');
    await expect(service.get('a')).resolves.toBeNull();
    expect(client.connect).toHaveBeenCalledTimes(2);
  });
  it('uses an already ready client and omits TTL when absent', async () => {
    const { client, service } = setup();
    client.isReady = true;
    await service.set('key', 'value');
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.set).toHaveBeenCalledWith('key', 'value');
  });
  it('does not close an unopened client', async () => {
    const { client, service } = setup();
    await service.onApplicationShutdown();
    expect(client.close).not.toHaveBeenCalled();
  });
  it('propagates command failures', async () => {
    const { client, service } = setup();
    client.get.mockRejectedValue(new Error('command timeout'));
    await expect(service.get('key')).rejects.toThrow('command timeout');
  });
  it.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid TTL %p before connecting',
    async (ttl) => {
      const { client, service } = setup();
      await expect(service.set('key', 'value', ttl)).rejects.toThrow(
        RangeError,
      );
      expect(client.connect).not.toHaveBeenCalled();
      expect(client.set).not.toHaveBeenCalled();
    },
  );
  it('awaits a pending connection before closing and refuses new work after shutdown', async () => {
    const { client, service } = setup();
    let finish!: (value: typeof client) => void;
    client.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = service.get('key');
    const shutdown = service.onApplicationShutdown();
    await expect(service.get('other')).rejects.toThrow('shutting down');
    expect(client.close).not.toHaveBeenCalled();
    client.isOpen = true;
    finish(client);
    await Promise.all([pending, shutdown]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
