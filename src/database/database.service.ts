import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export type Transaction = Pick<PoolClient, 'query'>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('DATABASE_URL');
    this.pool = new Pool({
      connectionString,
      max: Number(config.get('DATABASE_POOL_SIZE', '10')),
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 3_000,
      application_name: 'restaurant-ordering-api',
      ssl:
        config.get('DATABASE_SSL', 'true') === 'true'
          ? { rejectUnauthorized: false }
          : false,
    });
  }

  query<Row extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values);
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('begin isolation level serializable');
        const result = await work(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        const code = (error as { code?: string }).code;
        if (attempt === 3 || (code !== '40001' && code !== '40P01'))
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * 10 + Math.random() * 20),
        );
      } finally {
        client.release();
      }
    }
    throw new Error('Transaction retry limit exceeded');
  }

  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
