# Staff Engineering Review and Improvement Plan

Reviewed: 2026-09-05

## Assessment

This is a promising NestJS prototype with good transaction design, but it needs correctness and operational improvements before production scaling. Keep the modular monolith and prioritize API contracts, persistence, concurrency, and meaningful tests.

Preserve the feature-based modules, thin controllers, parameterized SQL, integer money values, database inventory constraints, transaction retries, and transactional outbox.

This review supersedes the earlier review in this file. Application source was unchanged during the review. Concurrency and throughput findings are based on code inspection, not database integration or load tests.

## Verified baseline

- All 8 unit tests across 4 suites pass (`npm test -- --runInBand`).
- Type checking (`tsc --noEmit --incremental false`) fails because the local installation cannot resolve the declared `redis` dependency.
- Non-mutating ESLint reports 25 errors, all associated with unresolved Redis types.
- The end-to-end suite fails before executing tests because Redis cannot be imported.
- Direct execution of the production ValidationPipe against valid product and user payloads returns HTTP 400.
- Current tests do not cover ordering, payments, reservation expiration, or outbox delivery.

The Redis failures describe the local dependency installation; they do not establish that the dependency is missing from package.json. Restore a reproducible installation before diagnosing remaining build or test failures. No current coverage or throughput result was measured.

## 1. Repair API contracts and persistence — highest priority

Evidence: `src/main.ts`, `src/products/dto/*.ts`, `src/users/dto/*.ts`, `src/common/crud.service.ts`, and `src/app.module.ts`.

Product and user DTOs lack validation decorators. The existing global ValidationPipe enables whitelist and forbidNonWhitelisted, so valid payload properties are rejected. The fix is DTO validation, not adding another global pipe. See [NestJS validation](https://docs.nestjs.com/techniques/validation).

Users and products also use process-local arrays. Data disappears on restart, differs across replicas, and uses process-local numeric IDs. Products created here are disconnected from the PostgreSQL catalog used by ordering.

Actions:

- Decide whether these routes are demonstration code or real product features.
- Remove demonstration routes from the production module, or implement database-backed, tenant-scoped feature services.
- Add create/update DTO validation and bounded collection pagination.
- Align product identifiers and pricing with the ordering schema.
- Require staff authentication and branch authorization for administrative mutations.

Acceptance: valid requests succeed, invalid requests fail predictably, and records remain consistent across restarts and replicas.

## 2. Strengthen transaction and idempotency correctness

Evidence: `src/orders/orders.service.ts`, `src/orders/dto/create-order.dto.ts`, `src/payments/payments.service.ts`, and `src/reservations/reservation-expirer.service.ts`.

An existing idempotency key returns an order without verifying that the request payload matches. Reusing a key with different items silently returns the original result.

Inventory locks are acquired in client-supplied item order. Concurrent carts containing the same products in opposite orders can deadlock. Retries help, but consistent lock ordering reduces avoidable contention. See [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html).

Actions:

- Store a canonical request fingerprint with the idempotency key and reject conflicting reuse.
- Scope replay access appropriately to the ordering session.
- Acquire inventory locks in a deterministic order across reservation, payment, and expiration paths.
- Bound item count, quantity, and monetary totals, including database integer limits.
- Test concurrent orders, duplicate submissions, and payment-versus-expiration races against real PostgreSQL.

Acceptance: retries never create extra orders, inventory never becomes negative or oversold, and conflicting key reuse returns a clear error.

## 3. Make background processing operationally reliable

Evidence: `src/messaging/outbox-publisher.service.ts`, `src/reservations/reservation-expirer.service.ts`, and `src/database/database.service.ts`.

The outbox publisher waits for Kafka inside a database transaction, retaining connections and locks during broker delays. A successful send followed by a failed database commit can cause duplicate delivery. The attempts field increments only after successful publication; failure information is not persisted.

Actions:

- Preserve explicit at-least-once delivery and require consumer deduplication by event ID. Kafka producer idempotence does not make the database-to-broker handoff atomic.
- Introduce short database claims with leases, publish outside the claim transaction, and acknowledge afterward. Include lease ownership, expiry, and crash recovery in the design.
- Persist failed attempts, retry timing, and diagnostic information.
- Define whether per-order event ordering is required and enforce it across concurrent publishers.
- Prevent overlapping expiration runs and await active work during shutdown.
- Allow API and worker processes to scale independently.

Acceptance: broker outages do not exhaust API database capacity, retries remain observable, and worker restarts do not lose events.

## 4. Refactor around business responsibilities

Evidence: `src/orders/orders.service.ts`, `src/payments/payments.service.ts`, `src/common/crud.service.ts`, and `tsconfig.json`.

OrdersService combines session validation, pricing, inventory locking, numbering, persistence, payment initialization, event creation, and response mapping. Outbox insertion is duplicated across several services.

Extract focused collaborators for inventory reservation/release, order persistence, pricing and state rules, typed outbox writing, and response mapping. Keep transaction ownership in the application service and pass the same transaction into collaborators. Avoid generic abstractions that obscure business rules.

For TypeScript:

- Progressively enable strict checking and unchecked indexed-access checks.
- Replace status strings with explicit unions.
- Use query-specific row types: MenuRow currently describes fields that some queries never return.
- Prefer explicit select lists to SELECT *.
- Define stable response types independently of database rows.

Acceptance: domain rules can be tested independently, query result types match selected fields, and related writes retain one transaction boundary.

## 5. Close framework and deployment gaps

Evidence: `src/database/database.service.ts`, `src/app.module.ts`, `src/main.ts`, `test/app.e2e-spec.ts`, `src/payments/payments.controller.ts`, and `database/migrations/001_initial_schema.sql`.

Database TLS certificate verification is disabled. Configuration lacks comprehensive startup validation. The end-to-end test uses the default adapter and omits the production prefix and validation configuration.

Actions:

- Validate database, Kafka, webhook, and numeric settings at startup.
- Verify database certificates using the deployment's trusted CA.
- Add a pool error listener and pool saturation metrics. See [node-postgres pooling](https://node-postgres.com/features/pooling).
- Share application setup between production and end-to-end tests: Fastify, prefix, and validation settings.
- Introduce versioned migrations with execution history; the existing command applies the initial schema directly.
- Complete provider-specific payment verification before accepting real payments; the README correctly identifies the shared-token adapter as interim.
- Add rate limits to public session and order endpoints.
- Separate non-mutating lint/check commands from fix commands and run checks in CI.

The schema enables RLS but defines no policies. Ordinary roles face default denial, while privileged roles can bypass it. Enabled RLS alone does not establish tenant isolation. Verify the actual runtime role and test tenant boundaries. See [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

Health endpoints and shutdown hooks already exist. Extend their behavior where needed rather than treating them as missing. See [NestJS lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events).

Acceptance: invalid configuration fails startup, HTTP tests reproduce production behavior, migrations are repeatable, and tenant isolation is tested with the real application role.

## 6. Measure scalability before changing architecture

Evidence: `ARCHITECTURE.md`, `src/orders/orders.service.ts`, `database/migrations/001_initial_schema.sql`, and worker services.

The documented 50,000 requests-per-second target remains unverified. Likely pressure points are:

- Multiple sequential database calls per order item.
- A shared daily counter row for each branch.
- Inventory contention on popular products.
- Missing order_items(order_id) indexing for payment and expiration lookups.
- Workers sharing database pools with HTTP traffic.

Batch database operations where practical and validate candidate indexes using execution plans. Budget database connections across replicas and workers. Instrument pool wait time, transaction retries, lock waits, expiration delay, and outbox age.

Benchmark realistic read/write mixes and hot branches separately. Define latency percentiles, error budgets, test duration, and correctness checks before declaring the capacity target achieved. Revisit numbering requirements if the branch counter becomes a measured bottleneck.

Acceptance: a production-equivalent sustained load test meets the agreed workload and latency/error targets while preserving inventory, payment, and event-delivery invariants.

## Delivery sequence

1. Restore confidence: reproducible dependency installation, working DTOs, production-equivalent HTTP tests, and CI checks.
2. Protect business invariants: idempotency, authorization, transaction concurrency tests, and payment verification.
3. Improve maintainability: focused services, typed events, strict TypeScript, and migrations.
4. Prove capacity: worker isolation, query optimization, observability, and sustained load tests.

Start with the first phase and use its tests to protect subsequent changes. Avoid a framework rewrite or microservice split until measured requirements justify the additional operational complexity.
