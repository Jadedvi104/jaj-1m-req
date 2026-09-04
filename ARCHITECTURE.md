# High-Throughput Architecture Plan

## Goal

Build the API toward a measured capacity of **50,000 HTTP requests per second** while preserving correctness, predictable tail latency, and graceful degradation.

This is a system-level target, not a NestJS setting. Before sizing infrastructure, the load profile must define:

- Read, create, update, and delete percentages.
- Cacheable request percentage.
- Typical and maximum payload sizes.
- Authentication and authorization cost.
- Required consistency and durability.
- Target p50, p95, and p99 latency.
- Steady-state and burst durations.
- Hot-key distribution.
- Database queries per endpoint.

## Current State

The current CRUD services store entities in process-local arrays. This is appropriate for a prototype, but not for production because:

- Data disappears when the process restarts.
- Each API replica would have different data.
- Horizontal scaling would produce inconsistent responses.
- Array searches become slower as data grows.
- There is no database, cache, connection management, messaging, or overload protection.

The first architectural requirement is therefore to make every API replica stateless and move durable state into PostgreSQL.

## Target Architecture

```text
Clients
  |
  v
CDN / WAF / rate limiting
  |
  v
Load balancer
  |
  v
Stateless NestJS + Fastify replicas
  |              |                  |
  |              |                  +--> Transactional outbox
  |              |                              |
  |              v                              v
  |        Supabase Postgres                  Kafka
  |        through bounded pools               |
  v                                             v
Distributed cache                     Consumer groups / workers
```

### Request path

1. The CDN or edge layer serves eligible cached responses and rejects abusive traffic.
2. A load balancer distributes remaining requests across stateless API replicas.
3. The API checks the distributed cache for hot reads.
4. Cache misses and mutations use PostgreSQL through bounded connection pools.
5. Mutations insert domain changes and outbox events in the same database transaction.
6. An outbox publisher sends committed events to Kafka.
7. Kafka consumers perform asynchronous side effects and update read models.

## API Layer

- Keep NestJS, but use the Fastify adapter after compatibility testing.
- Run one Node.js process per container and scale with multiple replicas.
- Keep sessions, entities, quotas, and idempotency records out of process memory.
- Add request validation and response serialization.
- Add explicit request, database, Kafka, and downstream timeouts.
- Add rate limiting, concurrency limits, backpressure, and load shedding.
- Support graceful shutdown and connection draining.
- Expose separate liveness and readiness endpoints.
- Avoid synchronous logging on the request path.

At 50,000 RPS, approximate active request concurrency is:

- 1,000 requests at 20 ms average latency.
- 2,500 requests at 50 ms average latency.
- 5,000 requests at 100 ms average latency.

All internal pools and queues must remain bounded at these concurrency levels.

## Supabase/PostgreSQL

PostgreSQL is the durable source of truth. It should not receive one or more expensive queries for every HTTP request at the target rate.

### Database rules

- Use appropriate composite and covering indexes based on measured queries.
- Use keyset pagination instead of large `OFFSET` scans.
- Keep transactions short.
- Batch compatible reads and writes.
- Prevent N+1 queries.
- Apply query and transaction timeouts.
- Monitor slow queries, locks, cache hit rate, connections, and replication lag.
- Use read models or replicas for read-heavy workloads where consistency allows it.

### Connection budget

The aggregate pool size must remain below the database connection allowance:

```text
API replicas * API pool size
  + worker connections
  + migration and administration connections
  + Supabase internal service connections
  <= available PostgreSQL connections
```

Start with a small pool per replica and tune from measurements. Increasing the number of API replicas must not silently exhaust PostgreSQL connections.

Choose direct, session-pooled, or transaction-pooled Supabase connections according to the deployment model. When using Supavisor transaction mode, disable prepared statements in the database client because that mode does not support them.

## Distributed Cache

Use Redis or a compatible managed cache to reduce database pressure.

Suitable uses include:

- Hot user and product reads.
- Negative caching for missing entities.
- Idempotency keys.
- Rate-limit and quota counters.
- Short-lived computed responses.
- Request coalescing to prevent cache stampedes.

Use versioned keys or invalidate entries only after a database transaction commits. The cache must not be the only durable copy of domain data.

Cache TTLs should include jitter so many keys do not expire simultaneously. Measure hit rate, evictions, memory, latency, and stampede behavior.

## Kafka and Reliable Events

Kafka is for asynchronous work, not ordinary synchronous CRUD reads.

Good event-driven workloads include:

- Audit and analytics events.
- Notifications and email.
- Search indexing.
- External integrations.
- Materialized read models.
- Expensive post-write processing.

### Transactional outbox

Do not write PostgreSQL and publish to Kafka as two unrelated operations. A crash between them can lose an event.

Instead, one PostgreSQL transaction must:

1. Apply the domain mutation.
2. Insert an outbox record.

An independent publisher reads committed outbox records and sends them to Kafka. Consumers must be idempotent because retries and duplicate delivery are expected in an at-least-once system.

Partition events by the domain key whose ordering matters, such as `userId` or `productId`. Consumer parallelism is limited by the topic partition count, so partition counts must be planned from required throughput and future scaling needs.

Track producer latency, publish failures, under-replicated partitions, consumer lag, retry volume, and dead-letter volume.

## Docker and Runtime Platform

Docker packages the services but does not provide production scaling by itself. Deploy the containers through an orchestrator or managed container platform with:

- Load balancing and multiple replicas.
- CPU and memory requests and limits.
- Horizontal autoscaling.
- Startup, readiness, and liveness probes.
- Rolling deployments.
- Graceful termination.
- Secret management.
- Multi-zone placement.
- Central metrics, logs, and distributed traces.

The application image should use a multi-stage build, run as a non-root user, contain only production dependencies, and have a read-only filesystem where practical.

## Observability and SLOs

Record at minimum:

- Request rate, success rate, and error rate by route.
- p50, p95, and p99 request latency.
- Node.js CPU, memory, garbage collection, and event-loop lag.
- Active requests and rejected requests.
- Database query latency, pool wait time, connections, lock waits, and errors.
- Cache hit rate, latency, memory, and evictions.
- Kafka producer latency and error rate.
- Kafka consumer lag, processing latency, retries, and failures.

Propagate a correlation or trace ID from the HTTP request through database operations, outbox records, Kafka messages, and consumers.

## Delivery Plan

### Phase 1: define and baseline

- Define the workload and latency/error SLOs.
- Add a production-shaped dataset.
- Benchmark the current empty endpoint and CRUD endpoints.
- Establish metrics and distributed tracing.

### Phase 2: durable stateless API

- Add PostgreSQL schema migrations.
- Replace in-memory services with repository-backed services.
- Add DTO validation, idempotency, pagination, and error mapping.
- Switch to Fastify after functional and performance verification.
- Add health checks and graceful shutdown.

### Phase 3: cache and query efficiency

- Add indexes based on query plans.
- Add Redis caching for proven hot reads.
- Add invalidation and stampede protection.
- Re-run load tests and identify the next saturation point.

### Phase 4: Kafka and background work

- Add the outbox table and publisher.
- Create versioned event schemas.
- Add keyed topics and idempotent consumers.
- Add retry topics or bounded retries and dead-letter handling.
- Test duplicate, delayed, and out-of-order delivery behavior.

### Phase 5: container deployment

- Add production Dockerfiles and local Docker Compose dependencies.
- Configure resource limits and probes.
- Deploy multiple API and worker replicas.
- Add autoscaling and failure-domain distribution.

### Phase 6: capacity proof

- Ramp load gradually instead of jumping directly to 50k RPS.
- Test cache-hit, cache-miss, read, write, and mixed scenarios separately.
- Test realistic authentication and payload sizes.
- Run steady-state, burst, soak, and failure tests.
- Record the saturation point for every subsystem.
- Confirm recovery after PostgreSQL, Kafka, cache, container, and zone failures.

## Acceptance Criteria

The 50k RPS goal is achieved only when a production-equivalent environment demonstrates:

- At least 50,000 requests per second for the agreed duration and workload mix.
- p95 and p99 latency within the declared SLO.
- Error rate within the declared SLO.
- No lost committed database writes.
- No lost required domain events.
- Duplicate events handled without duplicated business effects.
- No unbounded queues, pools, or memory growth.
- Stable database connections and lock behavior.
- Bounded Kafka consumer lag with documented recovery time.
- Graceful degradation during dependency failures.
- Documented infrastructure cost per million successful requests.

## References

- [NestJS performance with Fastify](https://docs.nestjs.com/techniques/performance)
- [Supabase: connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: connection management](https://supabase.com/docs/guides/database/connection-management)
- [Apache Kafka documentation](https://kafka.apache.org/documentation/)
- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Node.js cluster documentation](https://nodejs.org/api/cluster.html)
