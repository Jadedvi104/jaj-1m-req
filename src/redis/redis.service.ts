import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createClient } from 'redis';
import { REDIS_CLIENT } from './redis.constants';

export type RedisClient = ReturnType<typeof createClient>;

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private connection?: Promise<RedisClient>;

  constructor(@Inject(REDIS_CLIENT) readonly client: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return (await this.connectedClient()).get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const client = await this.connectedClient();

    if (ttlSeconds === undefined) {
      await client.set(key, value);
      return;
    }

    await client.set(key, value, {
      expiration: { type: 'EX', value: ttlSeconds },
    });
  }

  async del(key: string): Promise<number> {
    return (await this.connectedClient()).del(key);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.close();
    }
  }

  private async connectedClient(): Promise<RedisClient> {
    if (this.client.isReady) {
      return this.client;
    }

    this.connection ??= this.client.connect().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });

    return this.connection;
  }
}
