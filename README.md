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

See [FRONTEND_NEXTJS_GUIDE.md](./FRONTEND_NEXTJS_GUIDE.md) for the Next.js frontend
build plan, current API contracts, and backend integration prerequisites.

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) for the current audit, compatibility
changes, verification results, and remaining production release requirements.

## Project architecture

This application is a modular NestJS backend for multi-branch, dine-in ordering.
The current production-oriented path handles table presence, order reservation,
payment confirmation, reservation expiry, and reliable event publication. The
`users` and `products` CRUD routes are development-only examples and are not the
production identity or menu architecture.

```text
Client applications
        |
        | HTTPS (production ingress, WAF, and rate limits are required)
        v
NestJS 11 API on Fastify
  |-- feature controllers -> application services -> PostgreSQL
  |                                              |-- orders and inventory
  |                                              `-- transactional outbox
  |-- background reservation expiry                    |
  |-- Redis abstraction (available for future cache)   v
  `-- health endpoints                         Kafka-compatible broker
                                                        |
                                                        v
                                               idempotent consumers
```

The API process is intended to be stateless so multiple replicas can run behind
a load balancer. PostgreSQL is the source of truth for transactional state. Redis
must not become the authoritative store for inventory, payments, or orders, and
Kafka is used for asynchronous propagation after business data and its outbox
record commit together. The 50,000 RPS objective in [ARCHITECTURE.md](./ARCHITECTURE.md)
is a capacity target, not a measured property of the current implementation.

### 1. Architectural patterns

#### Modular monolith and feature modules

The codebase is one deployable NestJS application divided by business capability:
`orders`, `payments`, `reservations`, `table-sessions`, `messaging`, and `health`.
Infrastructure capabilities live in `database` and `redis`. `AppModule` is the
composition root that wires these modules together. This modular-monolith shape
keeps local transactions and deployments simple while leaving clear boundaries
that can be separated only when measurements justify the added operational cost.

Each feature follows a layered request path:

```text
Controller -> DTO validation -> Service/use case -> Database or adapter
```

Controllers own HTTP routing and transport input. Services coordinate business
rules and persistence. DTOs define runtime input validation. SQL and external
client details stay behind injectable infrastructure providers. Pure order rules,
including canonical idempotency fingerprints and integer-money calculation, are
kept in `order-policy.ts` so they can be tested without NestJS or a database.

The development-only users/products examples also demonstrate the repository
pattern: services depend on abstract repository tokens and modules bind those
tokens to in-memory adapters. Production features currently use `DatabaseService`
directly, so the repository/ports-and-adapters pattern is only partially adopted;
do not describe the whole application as hexagonal architecture.

#### Transactional consistency and concurrency control

Order reservation, payment confirmation, inventory movement, status changes, and
outbox writes use PostgreSQL transactions. `DatabaseService.transaction()` uses
serializable isolation and bounded retries for serialization failures and
deadlocks. Inventory rows are locked in database UUID order, and worker batches
use `FOR UPDATE SKIP LOCKED` so replicas can divide work without processing the
same locked row concurrently.

The API applies an idempotency-key pattern to order creation. A canonical request
fingerprint binds a key to the branch, table session, customer input, and item
selection. The database unique constraint is the final concurrency guard; the
service handles both normal and race-conflict replay paths. This preserves an
at-most-one logical order result for an unchanged request while rejecting a key
reused with different data.

#### Transactional outbox and event-driven integration

Business state and an `outbox_events` row commit in the same database transaction.
`OutboxPublisherService` locks unpublished rows, sends them to the configured
Kafka-compatible topic, then marks them published. The partition key is the branch
ID, which provides a useful locality key but does not guarantee a single global
order across publisher replicas.

Delivery is **at least once**, not exactly once. A broker acknowledgement followed
by a database commit failure can publish a duplicate. Every consumer must therefore
deduplicate the stable event ID and tolerate retries, delays, and out-of-order
events. Event contracts should remain versioned and backward compatible.

#### Background workers and lifecycle management

Reservation expiry and outbox publication run as bounded, non-overlapping batches
inside the API process. Nest lifecycle hooks start the loops and drain active work
during shutdown. This is suitable for the current modular deployment, but these
workers can later become separate deployments if database-pool pressure, scaling,
or failure isolation requires it. The same service code must not be enabled in both
API and worker deployments without preserving the database locking guarantees.

### 2. NestJS best-practice pattern

- Organize related controllers and providers into feature modules. Export only
  providers that form a deliberate module API. Nest modules are encapsulated by
  default; see the official [modules guidance](https://docs.nestjs.com/modules).
- Keep controllers thin. They should translate HTTP inputs and delegate business
  work to injectable providers, consistent with the official
  [controller](https://docs.nestjs.com/controllers) and
  [provider](https://docs.nestjs.com/providers) responsibilities.
- Prefer constructor injection so required dependencies are visible and testable.
  When injecting an abstraction, use a runtime class, string, or symbol token;
  TypeScript interfaces alone disappear at runtime.
- Use DTO classes plus the global `ValidationPipe`. This project transforms inputs,
  rejects non-whitelisted and unknown values instead of silently discarding them,
  and omits rejected values from validation errors. Domain invariants that
  depend on database state still belong in services and database constraints.
- Use Nest exceptions at the application boundary so expected failures map to
  intentional HTTP status codes. Do not expose database errors, stack traces,
  credentials, or tenant existence in public responses.
- Keep configuration access inside providers and fail during startup for unsafe or
  malformed security settings. New configuration should move toward one central,
  typed validation schema; the current validation is distributed across providers.
- Use lifecycle interfaces for owned resources and enable shutdown hooks. The
  database pool, Redis client, Kafka producer, and active batches must settle or
  close before termination. See Nest's [lifecycle guidance](https://docs.nestjs.com/fundamentals/lifecycle-events).
- Keep providers singleton-scoped unless request scope is genuinely required.
  Request-scoped providers add allocation and dependency-tree overhead to a
  high-throughput path.
- Preserve framework-independent tests for pure policies, provider tests for use
  cases, HTTP tests for validation/guards, PostgreSQL integration tests for locks
  and constraints, and end-to-end tests for the assembled application.
- Avoid circular module imports and service-locator access. Cross-feature behavior
  should pass through an exported provider or a durable event contract.
- Treat global modules as exceptions. `ConfigModule`, `DatabaseModule`, and
  `RedisModule` are currently global infrastructure; business feature providers
  should remain explicitly scoped to their modules.

### 3. Design principles

#### Correctness before throughput

Financial and inventory correctness is protected by database constraints, row
locks, serializable transactions, immutable order-item snapshots, and idempotent
write contracts. Prices and totals use integer satang rather than floating-point
currency. The database clock decides reservation/payment timing where races matter.
Optimizations must preserve these invariants and be proven with contention tests.

#### Single responsibility and separation of concerns

Controllers handle transport, services coordinate use cases, policy functions
hold pure rules, repositories/adapters handle external state, and modules compose
dependencies. New features should follow the same boundaries instead of placing
SQL, HTTP parsing, Kafka publication, and domain decisions in one method.

#### Dependency inversion and explicit contracts

Business services should depend on the narrowest useful contract. Abstract classes
or symbols are appropriate Nest injection tokens for repositories and external
gateways. Return explicit public view types rather than database rows. Never expose
private columns merely because a query already selected them.

#### Defense in depth and fail closed

Validation, business checks, unique/check/foreign-key constraints, tenant-scoped
relationships, and infrastructure policies protect different failure layers.
Missing webhook secrets and disabled demo routes fail closed. RLS being enabled is
only an additional boundary; policies and a non-owner application role are still
required before it provides tenant isolation.

#### Idempotency and immutable evidence

Every externally retried command needs a stable identity and documented replay
semantics. Payment transaction ID and received amount become immutable confirmation
evidence; changed retries require reconciliation. Events carry stable IDs so
consumers can deduplicate them. Audit-relevant history should be appended rather
than silently rewritten.

#### Bounded resource use and graceful degradation

HTTP bodies, order lines, quantities, monetary totals, database pool size, SQL
timeouts, retry counts, and worker batch sizes are bounded. Kafka failure leaves
events durably pending instead of rolling back completed customer transactions.
Future cache failure should fall back carefully to the source of truth without
creating a database stampede.

#### Measure before distributing

Prefer the modular monolith until load tests show a specific bottleneck. The daily
branch counter, database pool, per-item writes, worker transactions, Kafka outage
behavior, and hot branches are known measurement points. Splitting services does
not remove these consistency constraints and can add network and operational risk.

### 4. Networking and security

#### Network boundaries

In production, only the HTTPS ingress/load balancer should be publicly reachable.
The API, PostgreSQL, Redis, and Kafka-compatible broker belong on private networks
with the minimum permitted east-west paths. The API listens on `0.0.0.0` so it can
receive container traffic; this is not permission to expose its container port
directly to the internet. Local Docker Compose intentionally uses plaintext and
published dependency ports for developer convenience and is not a production
network design.

The expected production flow is:

1. A CDN/WAF or ingress terminates HTTPS, applies request-size and endpoint-aware
   rate limits, and forwards a trusted set of headers.
2. Stateless Fastify/NestJS replicas handle requests with a 64 KiB body limit and
   a 10-second request timeout.
3. Each replica uses a bounded PostgreSQL connection pool with short connection
   and statement timeouts. Total pool capacity must be budgeted across replicas.
4. The API connects to managed PostgreSQL with certificate verification enabled.
   Custom roots use `DATABASE_SSL_CA`; URL parameters cannot override this policy.
5. Kafka connections use TLS and SASL in managed environments. Credentials and
   webhook secrets come from a secret manager or injected environment, never Git.
6. `/api/health/live` checks the process, while `/api/health/ready` checks database
   connectivity and should control whether a replica receives traffic.

Parameterized SQL is required for all untrusted values. Public order UUIDs are
bearer capabilities and must be redacted from logs, analytics, referrers, and
shared caches. The interim KBank shared-token endpoint uses a fail-closed,
timing-safe comparison, but it must be replaced by the bank's official signature,
payload mapping, replay protection, and reconciliation workflow before production.

The following controls are still release requirements rather than implemented
guarantees:

- staff authentication, hierarchical role authorization, and branch/tenant checks;
- rate limiting and brute-force protection for public code/session/order routes;
- ingress HTTPS policy, WAF rules, trusted-proxy configuration, security headers,
  and an explicit CORS policy if browsers call the API across origins;
- fully configured PostgreSQL RLS policies and a least-privilege, non-owner runtime
  database role;
- secret rotation, network policies/firewalls, dependency scanning, centralized
  redacted logs, metrics, tracing, alerting, backups, and recovery drills;
- idempotent Kafka consumers, retry/dead-letter policy, topic access control,
  retention planning, and tested broker-outage behavior; and
- official KBank verification plus secure handling of reconciliation and refunds.

For Fastify, security headers should use the appropriate plugin and be registered
before routes. Rate limits should be enforced at the edge and, where identity or
business context matters, again in the application. See Nest's official
[Helmet](https://docs.nestjs.com/security/helmet),
[CORS](https://docs.nestjs.com/security/cors), and
[rate-limiting](https://docs.nestjs.com/security/rate-limiting) guidance.

### 5. Programming-language best practices

The implementation uses TypeScript targeting ES2023 with NodeNext module
resolution. `strict`, `strictNullChecks`, `isolatedModules`, consistent filename
casing, and `noFallthroughCasesInSwitch` are enabled. These compiler checks are
part of the contract and must not be bypassed with broad type assertions.

- Use `unknown` at untrusted boundaries and narrow it before access. Reserve `any`
  for isolated compatibility code with an explanation; the current lint exception
  should not be treated as permission for new untyped application logic.
- Give exported functions, public methods, DTO fields, and external response/event
  contracts explicit types. Prefer narrow unions for statuses and roles over
  arbitrary strings when the contract is stable.
- Remember that TypeScript types do not validate network input. Keep
  `class-validator` rules on DTO classes and database constraints underneath them.
- Use `readonly` for injected dependencies and values that should not be reassigned.
  Avoid mutating caller-owned DTOs; canonicalize into new values before sorting or
  hashing so retries remain deterministic.
- Model absence deliberately with optional fields or `null`, according to the wire
  and database contract. Do not use non-null assertions to hide an unproven state.
  Definite-assignment assertions are acceptable for fields populated by Nest's
  validation/transformation lifecycle.
- Keep asynchronous control flow explicit. `await` work that affects correctness,
  prefix intentional fire-and-forget calls with `void`, attach error handling, and
  drain owned promises during shutdown. Enable `no-floating-promises` as an error
  once the remaining warnings have been resolved.
- Narrow caught errors before reading properties or stacks. Preserve the initiating
  failure when rollback/cleanup also fails, and never log connection strings,
  tokens, customer phone numbers, or payment payloads.
- Use parameterized SQL with typed row interfaces. Keep transaction callbacks
  short, deterministic, and free of unrelated network I/O where possible. The
  current outbox publisher holds a transaction during broker I/O; this is a known
  trade-off that must be load-tested and may need redesign.
- Use runtime tokens for dependency injection abstractions because interfaces and
  type aliases are erased. Prefer abstract classes or `Symbol` tokens and bind them
  in the owning module.
- Prefer small pure functions for calculations, normalization, and policy rules.
  Test boundary values, concurrency behavior, error paths, and exhaustiveness—not
  only successful examples.
- Run `npm run lint:check`, `npm run typecheck`, tests, coverage, and the production
  build in CI. Formatting tools should produce deterministic changes, and lockfile
  updates should accompany dependency changes.

The TypeScript configuration is documented in the official
[TSConfig reference](https://www.typescriptlang.org/tsconfig/). Architecture and
language rules should evolve through reviewed changes, tests, and measured evidence;
README claims must be updated when implementation and production readiness change.

## Requirements

- Node.js 22 LTS+
- PostgreSQL 17+ (Azure Database for PostgreSQL Flexible Server for cloud development)
- A Kafka-compatible managed service for production
- Docker Desktop for the local container stack

## Configuration

```bash
cp .env.example .env
npm install
```

Use an Azure PostgreSQL connection string in `DATABASE_URL` and set `DATABASE_SSL=true` for Azure. Budget `DATABASE_POOL_SIZE` across all replicas, replace the example webhook token, and configure the Azure Kafka-compatible endpoint through the `KAFKA_*` variables. Never commit `.env` or bank credentials. See [Azure development database setup](infra/README.md) for the infrastructure definition and credential handling.

## Local development

Start Docker Desktop, then run:

```bash
docker compose up --build
```

The PostgreSQL image applies the files in `database/migrations/` when its data volume is first created. To migrate an empty PostgreSQL database directly:

```bash
DATABASE_URL='postgresql://...' npm run db:migrate
```

For Azure, the migration command uses `psql`, so configure its TLS verification
separately with `PGSSLMODE=verify-full` and `PGSSLROOTCERT` pointing to a trusted
root CA PEM file. The application's `DATABASE_SSL` settings apply to the Node.js
database client, not to `psql`.

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

These users/products routes are development examples. They return 404 unless
`NODE_ENV=development` and `ENABLE_DEMO_CRUD=true` are both configured. They are
always blocked in production. Data is held in memory and resets on restart.

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

`POST /api/orders` requires an `Idempotency-Key` header containing 1–128 visible
ASCII characters, without spaces. Retries must use the same table session and
request data; conflicting or expired replays return 409. Item ordering and UUID
letter case do not affect retry identity. Orders allow at most 100 distinct
products and 1,000 units per product; totals cannot exceed 2,147,483,647 satang.

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

Identical webhook retries acknowledge the recorded payment state without new
inventory changes or events. A changed amount or transaction ID after a recorded
confirmation returns 409 and requires reconciliation.

## Upgrading an existing database

Apply `database/migrations/002_order_request_fingerprint.sql` once before starting
the updated API. The `db:migrate` command initializes an **empty** database with
both migrations; do not rerun the initial schema on an existing database.
Docker initialization also only applies migrations when creating a new volume.

The new fingerprint column intentionally remains null on historical orders.
Their existing public links continue to work until expiry, but replaying their
old idempotency keys returns 409 because the original request cannot be verified.
Drain old application instances before deploying the new writer.

Production database connections should use `DATABASE_SSL=true` with a trusted
certificate. Set `DATABASE_SSL_CA` to a custom CA PEM if needed. Remove `ssl*`
and `uselibpqcompat` query parameters from `DATABASE_URL`; TLS is configured
through these explicit environment settings. `DATABASE_SSL=false` is for a
deliberately trusted local connection. Pool size must be an integer from 1–100.

### Health

```text
GET /api/health/live
GET /api/health/ready
```

## Verification

```bash
npm run check
# Requires TEST_DATABASE_URL pointing to a disposable PostgreSQL database:
npm run test:integration
```

See [TESTING.md](./TESTING.md) for the architecture assessment, test-case matrix,
database setup, smoke-load command, reproduced defects and remaining release gates.

## Planned slices

- Staff authentication (provider to be selected) and hierarchical staff authorization.
- Rotating table-code issuance.
- KBank QR generation, official webhook mapping, and reconciliation polling.
- Staff acceptance, kitchen display, substitutions, and manual partial refunds.
- Branch menu and daily-inventory administration endpoints.
- Promotions, WebSockets, Firebase push notifications, retention jobs, and reports.
- Bluetooth printing and offline synchronization (explicitly deferred).
- Cache, production orchestration, observability, and load testing.
