import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export type Transaction = Pick<PoolClient, 'query'>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('DATABASE_URL');
    const url = new URL(connectionString);
    if (
      [...url.searchParams.keys()].some(
        (key) => key.startsWith('ssl') || key === 'uselibpqcompat',
      )
    ) {
      throw new Error(
        'Configure database TLS using DATABASE_SSL and DATABASE_SSL_CA, not URL parameters',
      );
    }
    const poolSize = Number(config.get('DATABASE_POOL_SIZE', '10'));
    if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 100) {
      throw new Error(
        'DATABASE_POOL_SIZE must be an integer between 1 and 100',
      );
    }
    const ssl = config.get<string>('DATABASE_SSL', 'true');
    if (ssl !== 'true' && ssl !== 'false')
      throw new Error('DATABASE_SSL must be true or false');
    this.pool = new Pool({
      connectionString,
      max: poolSize,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 3_000,
      application_name: 'restaurant-ordering-api',
      ssl:
        ssl === 'true'
          ? {
              rejectUnauthorized: true,
              ca: config.get<string>('DATABASE_SSL_CA'),
            }
          : false,
    });
    this.pool.on('error', () =>
      this.logger.error('Unexpected idle database connection failure'),
    );
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
      let discardClient = false;
      try {
        await client.query('begin isolation level serializable');
        const result = await work(client);
        await client.query('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          discardClient = true;
          this.logger.error('Database rollback failed; discarding connection');
          throw error;
        }
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        if (attempt === 3 || (code !== '40001' && code !== '40P01'))
          throw error;
      } finally {
        client.release(discardClient);
      }
      // Release scarce pool capacity before waiting to retry.
      await new Promise((resolve) =>
        setTimeout(resolve, attempt * 10 + Math.random() * 20),
      );
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
