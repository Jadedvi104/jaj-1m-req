# Restaurant Ordering API

NestJS foundation for a multi-branch, dine-in ordering platform using PostgreSQL, a transactional outbox, and Kafka-compatible messaging.

The current vertical slice supports:

- Permanent table QR identities with rotating presence codes.
- Atomic, all-or-nothing inventory reservations.
- Ten-minute reservations with one five-minute extension.
- Branch-local sequential daily order numbers in Bangkok time.
- Random public order references and idempotent order creation.
- Product-size pricing and spice-level snapshots.
- Exact-amount KBank payment confirmation.
- Safe handling of duplicate, late, and mismatched confirmations.
- Durable outbox events and asynchronous Kafka publication.
- Automatic release of expired reservations.
- Health and readiness endpoints.
- PostgreSQL-enforced tenant relationships and RLS defense in depth.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the scaling plan.

## Requirements

- Node.js 22 LTS+
- PostgreSQL 17+ or Supabase Cloud Postgres
- A Kafka-compatible managed service for production
- Docker Desktop for the local container stack

## Configuration

```bash
cp .env.example .env
npm install
```

Use a Supabase connection string in `DATABASE_URL`, budget `DATABASE_POOL_SIZE` across all replicas, replace the example webhook token, and configure the Azure Kafka-compatible endpoint through the `KAFKA_*` variables. Never commit `.env` or bank credentials.

## Local development

Start Docker Desktop, then run:

```bash
docker compose up --build
```

The PostgreSQL image applies `database/migrations/001_initial_schema.sql` when its data volume is first created. To migrate an empty Supabase/PostgreSQL database directly:

```bash
DATABASE_URL='postgresql://...' npm run db:migrate
```

To run the API without Docker:

```bash
npm run start:dev
```

## API

### Create a physical-presence table session

- `POST /api/users` and `POST /api/products`
- `GET /api/users` and `GET /api/products`
- `GET /api/users/:id` and `GET /api/products/:id`
- `PATCH /api/users/:id` and `PATCH /api/products/:id`
- `DELETE /api/users/:id` and `DELETE /api/products/:id`

Data is held in memory and resets when the application restarts.

## Redis

The global `RedisModule` provides `RedisService` for Redis-backed features. Copy
`.env.example` to `.env` and set `REDIS_URL` for your environment. If omitted,
the application uses `redis://localhost:6379`.

Inject the service into a Nest provider and use `get`, `set`, or `del`:

```typescript
constructor(private readonly redisService: RedisService) {}

await this.redisService.set('example:key', 'value', 60);
const value = await this.redisService.get('example:key');
```

Connections are established on the first Redis operation and closed during
application shutdown. The raw client is also injectable with `REDIS_CLIENT` for
commands not exposed by `RedisService`.

## Project setup

```bash
$ yarn install
```

```json
{
  "branchId": "00000000-0000-4000-8000-000000000001",
  "tablePublicId": "00000000-0000-4000-8000-000000000002",
  "rotatingCode": "code-currently-displayed-at-the-table"
}
```

### Create an order and reservation

`POST /api/orders` requires an `Idempotency-Key` header.

```json
{
  "branchId": "00000000-0000-4000-8000-000000000001",
  "tableSessionId": "00000000-0000-4000-8000-000000000004",
  "customerName": "Guest",
  "customerPhone": "+66812345678",
  "items": [
    {
      "productId": "00000000-0000-4000-8000-000000000003",
      "quantity": 2,
      "sizeCode": "large",
      "spiceLevel": "medium"
    }
  ]
}
```

Money is represented as integer satang. THB 120.50 is `12050`.

### Public order status

```text
GET /api/orders/:publicReference
PATCH /api/orders/:publicReference/extend
```

### Interim KBank confirmation adapter

```text
POST /api/webhooks/kbank/payments
X-Webhook-Token: configured-secret
```

```json
{
  "paymentReference": "KB-order-reference",
  "transactionId": "provider-transaction-id",
  "amountSatang": 12050
}
```

The final KBank adapter must replace the interim shared-token check with the bank's documented signature verification and payload mapping.

### Health

```text
GET /api/health/live
GET /api/health/ready
```

## Verification

```bash
npm run build
npm run lint
npm test -- --runInBand
```

## Planned slices

- Supabase Auth and hierarchical staff authorization.
- Rotating table-code issuance.
- KBank QR generation, official webhook mapping, and reconciliation polling.
- Staff acceptance, kitchen display, substitutions, and manual partial refunds.
- Branch menu and daily-inventory administration endpoints.
- Promotions, WebSockets, Firebase push notifications, retention jobs, and reports.
- Bluetooth printing and offline synchronization (explicitly deferred).
- Cache, production orchestration, observability, and load testing.
