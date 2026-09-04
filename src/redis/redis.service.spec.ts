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
