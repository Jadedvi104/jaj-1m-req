# QA analysis and test strategy

Reviewed 2026-09-05, starting with `ARCHITECTURE.md`, followed by every source module, the migration, bootstrap, dependency configuration, existing tests, Dockerfile and Compose stack.

## Architecture as implemented

The architecture document is a target roadmap, not an accurate inventory of completed features. The running application uses NestJS/Fastify with `/api`, a 64 KiB body limit and strict DTO validation. PostgreSQL stores restaurant orders. Redis is lazily connected but is not used by the order flow. Users and products CRUD endpoints still use independent process-local arrays; the products endpoint does **not** administer the PostgreSQL restaurant menu.

The restaurant flow is table presence validation → session → serializable order transaction → inventory reservation, item snapshots, payment and outbox insertion. PostgreSQL transactions retry serialization/deadlock failures up to three times. Payment confirmation locks payment/order records and either sells reserved inventory or flags the payment for review. The expiry worker releases reservations every ten seconds. The publisher polls outbox records every 250 ms and sends keyed Kafka messages before marking them published. Delivery is at least once; no consumer is implemented.

## Test commands

### Local verification results

- 140 unit/DTO/HTTP cases passed across 13 suites.
- 19 real PostgreSQL 17 integration cases passed, using an isolated local cluster and generated schemas.
- Combined unit/HTTP coverage: 99.18% statements, 84.23% branches, 98.91% functions and 99.27% lines.
- Nonmutating ESLint, full TypeScript checks and the production build passed.
- A clean `npm ci` succeeded with the repaired lockfile.
- The smoke runner was verified against a locally launched production build: health requests passed, and a deliberately nonexistent route correctly failed its error-rate threshold. This was a one-second harness check, not a benchmark or capacity result.

Use Node.js 22+ and `npm ci`.

| Command | Purpose / dependency |
| --- | --- |
| `npm test -- --runInBand` | Unit and DTO tests; external services mocked |
| `npm run test:e2e -- --runInBand` | Real Fastify HTTP routes, controllers and domain services; database mocked and background workers disabled |
| `npm run test:coverage` | Combined unit + HTTP coverage, with enforced thresholds |
| `npm run test:integration` | Real PostgreSQL 17 migration, constraints, transactions and competing requests |
| `npm run test:load` | Configurable bounded HTTP GET smoke load against an explicitly supplied origin |
| `npm run check` | Nonmutating lint, full TypeScript check including tests, combined tests/coverage, production build |

`test:coverage` excludes only the process-launching `main.ts` and test files from application coverage. Shared bootstrap configuration is covered through the HTTP suite. Coverage is not evidence of distributed correctness or production capacity. Thresholds are 85% statements/lines/functions and 80% branches. Integration is separate so an absent database cannot produce a misleading green skipped suite.

### PostgreSQL integration setup

Supply a **dedicated disposable database**, never a production database. The suite deliberately requires `TEST_DATABASE_URL` and does not fall back to `DATABASE_URL`. It creates a randomized schema, applies the real migration, resets its fixtures between cases, closes application pools and drops the schema afterwards. The database role needs schema and extension creation privileges. Do not run concurrent suites against the same database if `pgcrypto` has not already been installed. TLS can be selected with `TEST_DATABASE_SSL=true`.

PowerShell example:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://qa:qa_test_only@localhost:5432/restaurant_test'
$env:TEST_DATABASE_SSL = 'false'
npm run test:integration
```

The GitHub Actions workflow provisions PostgreSQL 17 and runs both `check` and integration tests. No application credentials are required. Workflow execution on GitHub is separate from local verification.

### Smoke load

```powershell
$env:LOAD_BASE_URL = 'http://127.0.0.1:3000'
$env:LOAD_PATHS = '/api/health/live,/api/health/ready'
$env:LOAD_CONCURRENCY = '10'
$env:LOAD_DURATION_SECONDS = '10'
$env:LOAD_MAX_ERROR_RATE = '0.01'
$env:LOAD_MAX_P95_MS = '1000'
npm run test:load
```

The script performs GET requests only, bounds concurrent requests, times out individual requests after five seconds, bounds latency samples to 100,000, reports status counts, throughput and latency percentiles, and exits nonzero when thresholds fail. These defaults are smoke-test settings, **not agreed product SLOs**. Use public order paths only with seeded, unexpired references. A closed-loop single-machine generator cannot prove 50,000 RPS and underreports the impact of queued demand during saturation.

## Traceable automated test cases

Each test has an executable descriptive name. Parameterized cases exercise separate inputs.

| IDs | Scope and scenarios | Expected outcome | Implementation |
| --- | --- | --- | --- |
| HTTP-01 | Root prefix, unknown route | `/api` responds; unprefixed root 404 | `test/app.e2e-spec.ts` |
| HTTP-02 | Liveness/readiness, database outage | Liveness independent; readiness 503 without secrets | HTTP suite |
| CRUD-01 | Create/list/read/PATCH/delete users and products | Correct responses and preserved omitted fields | HTTP suite, feature unit tests |
| CRUD-02 | Unknown/malformed IDs and properties | 404/400; input cannot inject fields | HTTP suite |
| CRUD-03 | Returned object mutation, deletion isolation, ID reuse | No mutation through returned copies; IDs increase | `src/common/crud.service.spec.ts` |
| VAL-01 | Required fields, invalid types, lengths at/over limits, null updates | Valid boundary accepted; malformed input rejected | `src/common/validation.spec.ts`, HTTP suite |
| VAL-02 | Empty/nested items, fractional/zero quantities, forged prices | 400 before transaction starts | DTO and HTTP suites |
| VAL-03 | Malformed JSON, payload over 64 KiB | 400/413 | HTTP suite |
| SESSION-01 | Valid code, wrong branch/code, expired code/session, inactive table | Session issued only for eligible table; invalid input rejected | Session unit tests, PostgreSQL suite |
| ORDER-01 | Missing key, repeated product IDs | Rejected before mutations | Order unit tests, HTTP suite |
| ORDER-02 | Base, size and zero-size pricing, item snapshots | Integer totals and persisted snapshot values | Order unit tests, PostgreSQL suite |
| ORDER-03 | Unavailable menu/product/size, sold/reserved stock, exact remaining stock | No overselling; eligible boundary succeeds | Order unit tests, PostgreSQL suite |
| ORDER-04 | Multi-item failure and outbox insertion failure | No partial stock, order, counter, payment or event | PostgreSQL suite |
| ORDER-05 | Existing key, simultaneous same key, unrelated uniqueness error | One order; unrelated error propagated | Order unit tests, PostgreSQL suite |
| ORDER-06 | Concurrent distinct orders | Unique sequential daily display numbers | PostgreSQL suite |
| ORDER-07 | Public lookup and expired public access | Public view excludes private fields; expired access 404 | Unit, HTTP and PostgreSQL suites |
| ORDER-08 | Extension eligibility and concurrent extensions | Exactly one five-minute extension | Unit, HTTP and PostgreSQL suites |
| PAY-01 | Missing/wrong/equal-length-wrong token | 401 before payment processing | HTTP suite |
| PAY-02 | Unknown payment, exact amount, duplicate provider confirmation | 404 or one stock conversion and paid event | Payment unit and PostgreSQL suites |
| PAY-03 | Under/over/zero payment amount | Review required, no stock sale | Payment unit and PostgreSQL suites |
| PAY-04 | Expired/equal-deadline/ineligible order | Review required, no second fulfillment | Payment unit and PostgreSQL suites |
| PAY-05 | Another transaction for confirmed payment; same transaction across orders | Rejected; transaction rollback preserves stock | Payment unit and PostgreSQL suites |
| EXP-01 | Empty batch, multiple orders, repeated expiration | Release once and persist expiry event | Expirer unit and PostgreSQL suites |
| EXP-02 | Payment/expiry contention | No negative stock or double sale | PostgreSQL suite |
| EXP-03 | Timer lifecycle and dependency failure | Timer stops; failed batch logged and later recovery possible | Expirer unit tests |
| DB-01 | Commit, rollback, failed commit, pool exhaustion | Work/error propagated; client released | Database unit tests |
| DB-02 | Serialization/deadlock retries and exhaustion | Retries bounded at three; eventual success or failure | Database unit tests |
| DB-03 | Inventory check constraints, cross-branch table and cross-corporation menu | Invalid state rejected by PostgreSQL | PostgreSQL suite |
| MSG-01 | Disabled Kafka, empty batch, keyed envelope/headers | Durable records retained or correct message produced | Publisher unit tests |
| MSG-02 | Send failure, retry, overlapping ticks, shutdown | No failed-send acknowledgement; no overlapping local send; timer stopped | Publisher unit tests |
| CACHE-01 | Lazy/ready connection, shared concurrent connection, failed-connect retry | One connection attempt per contention window; later recovery | Redis unit tests |
| CACHE-02 | Missing key, set with/without TTL, delete, command failure, shutdown | Correct forwarding/results/errors and cleanup | Redis unit tests |

## Defects reproduced and fixed

1. Users/products DTOs lacked decorators. Production whitelisting rejected valid create/update bodies. Added validation rules and boundary regressions. Current limits: user name 100, email 254; product name 200, description 2,000; nonnegative numeric price. These are explicit API validation defaults, not newly inferred restaurant menu requirements.
2. Transformed update DTOs contain undefined omitted fields. Spreading them into stored entities erased other fields. Shared CRUD updates now ignore undefined properties; full HTTP lifecycles verify preservation.
3. The order business-date query used `day` as an implicit alias. PostgreSQL 17 rejected it with SQLSTATE 42601. Explicit `AS day` restores order creation; real integration cases cover it.
4. Expiry outbox SQL inferred incompatible UUID/text types for `$1`, rolling back the entire expiry transaction. Explicit UUID casting restores release and event insertion; repeated expiration and payment-race tests cover it.
5. Clean installation failed because the lockfile omitted `real-require@0.2.0`. Repaired the lockfile without changing declared dependency versions.

## Remaining findings and release gates

These are outstanding concerns, not behaviors certified by the passing tests:

| Priority | Finding / architectural gap | Required follow-up |
| --- | --- | --- |
| High | Users/products data is process-local and unrelated to restaurant catalog tables; APIs lack staff authentication | Define intended public/admin surface, durable repositories and authorization before multi-replica use |
| High | No staff authorization or production KBank signature verification | Implement real bank verification and staff role/tenant checks; add forgery, replay and cross-tenant authorization tests |
| High | Idempotency keys are not bound to a request digest | Specify response for reuse with a different cart/customer; reject conflicting payloads if required |
| High | Repeated mismatched/late payment notifications emit repeated review events; consumers are absent | Define review deduplication and implement idempotent consumers before claiming duplicate side-effect safety |
| High | RLS is enabled on some tables but there are no policies; some auxiliary tables have no RLS; tests use a privileged role | Test the actual deployment role and denied cross-tenant reads/writes. Foreign-key tests do not prove authorization |
| Medium | `orders.table_session_id` does not have a composite branch/table foreign key | Service checks cover normal creation, but direct writes can violate session ownership; consider a stronger schema constraint |
| Medium | Outbox send occurs inside a retryable DB transaction; commit loss can resend | Verify broker disconnect/restart and crash-after-send behavior with a real consumer and stable event IDs |
| Medium | Publisher shutdown does not wait for an in-flight batch; expiry ticks can overlap | Test SIGTERM during work and define drain deadlines; confirm no committed event loss and bounded connections |
| Medium | Outbox failure attempts/last_error are not persisted; only successful attempts increment | Add durable retry observability and alerting |
| Medium | Empty webhook token configuration is not rejected at startup | Validate nonempty production secrets and configuration |
| Medium | Order item count/key length/maximum money are not bounded by domain DTO rules; whitespace-only names are accepted | Define business limits and add upper-bound/overflow cases when agreed |
| Medium | Database SSL disables certificate verification; pool settings are not validated | Harden deployment configuration and verify TLS trust and connection budgets |
| Capacity gate | No cache path, load shedding, metrics/traces, deployed replica strategy or consumers | Do not treat functional coverage as architectural completion |

### Nonfunctional acceptance cases requiring a production-shaped environment

| IDs | Scenario | Evidence required |
| --- | --- | --- |
| PERF-01 | Baseline, gradual ramps, read/write/mixed/hot-key profiles with representative dataset and authentication | Successful RPS, error rate, p50/p95/p99, workload definition, CPU/memory/event-loop and pool metrics |
| PERF-02 | Sustained 50,000 RPS, bursts and soak | Agreed duration and SLOs met; bounded memory/queues/lag, no lost writes/events, infrastructure cost per million successes |
| FAIL-01 | Kill API during commit; restart database; exhaust pool; restore dependencies | Atomic state, bounded failures, recovery time, no lost committed writes |
| FAIL-02 | Broker unavailable, disconnect after send, duplicate/reordered events | Outbox backlog/recovery, stable IDs, idempotent side effects; real consumer required |
| FAIL-03 | SIGTERM and rolling deployment under traffic | In-flight work drained or retried; readiness removal; pool/client cleanup |
| SEC-01 | Actual low-privilege DB role, staff roles and cross-tenant access | Denied reads/writes across all tenant-owned tables, not merely FK integrity |
| OPS-01 | Build/run Docker image as non-root; Compose startup and network connectivity | Image starts and serves ready/live endpoints; logs contain no secrets |
| OPS-02 | Backup/restore and migration rollout | Restored orders, payments, stock and unpublished events reconcile |

Docker/real Kafka, actual bank integration, real Redis failover, deployment-role authorization, backup/restore, and 50k-RPS capacity are not validated by the local automated results. Keep these gates open until the corresponding environment and missing features exist.
