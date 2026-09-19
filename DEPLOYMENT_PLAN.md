# Azure Test Deployment Plan

**Project:** Restaurant Ordering API (`jaj-1m-req`)  
**Target:** Existing Azure development stack used by the GitHub `testing` environment  
**Region:** Southeast Asia  
**Plan date:** 2026-09-17  
**Purpose:** Prove that a reviewed application revision can be deployed, exercised, observed, and rolled back safely. This plan does not certify production readiness or the 50,000-RPS architecture target.

## 1. Executive decision

Use the existing GitHub Actions path from the `testing` branch. Do not deploy an image built on a developer laptop and do not use the `main`/production path.

The test deployment is a **go** only after the entry criteria in this document are met. The existing Azure stack is suitable for a controlled functional test, but it is intentionally small and not production-grade:

- Azure Container Apps: one always-on Consumption replica, 0.25 vCPU, 0.5 GiB.
- Azure Database for PostgreSQL Flexible Server 17: `Standard_B1ms`, 32 GiB, seven-day local backups, no HA.
- Azure Event Hubs Kafka endpoint: Standard, one throughput unit, two partitions, 24-hour retention, producer-only credential.
- Private Azure Container Registry, Key Vault references, managed identity, GitHub OIDC, Log Analytics, VNet integration, NAT gateway, and fixed egress IP.
- Single-revision Container App deployment with immutable image digests.

The deployment can validate build integrity, Azure connectivity, HTTP behavior, PostgreSQL transactions, and Event Hubs publication. It cannot validate consumer behavior because no Kafka consumer is implemented, and it must not be presented as a production capacity, resilience, tenancy, or payment-security certification.

## 2. Objectives and success criteria

The deployment is successful only when all of the following are true:

- The exact commit deployed from `testing` passed lint, type checking, unit/API tests, coverage thresholds, PostgreSQL integration tests, production compilation, container build, and container smoke tests.
- GitHub authenticates to Azure through OIDC; no long-lived Azure credential is added to GitHub.
- The CI-produced Linux AMD64 image is pushed to ACR and the Container App is updated by immutable `sha256` digest.
- Azure reports the new revision ready within ten minutes.
- `/api/health/live` and `/api/health/ready` return HTTP 200 over HTTPS.
- Demo CRUD routes remain inaccessible in production mode.
- A controlled table-session/order test preserves inventory and idempotency invariants.
- A synthetic payment confirmation behaves correctly without contacting or representing the real bank.
- Required outbox events are acknowledged by Event Hubs and marked published in PostgreSQL.
- No secrets, customer data, access tokens, or database URLs appear in logs or artifacts.
- Error rate and latency remain inside the temporary test thresholds during bounded smoke load.
- The previous image digest and rollback procedure are recorded and can be executed by the deployment operator.
- Evidence is captured for every gate and a named approver signs off.

Recommended temporary test thresholds:

- Functional smoke: 100% expected responses; no unexpected 5xx responses.
- Bounded health load: error rate at or below 1%; p95 at or below 1,000 ms.
- Database readiness: no pool exhaustion, statement timeout surge, or sustained connection errors.
- Event publication: test outbox rows reach `published_at` within 60 seconds while Event Hubs is available.
- Recovery: a deliberately rolled-back image returns both health endpoints to green within 15 minutes.

These are test-environment thresholds, not final production SLOs.

## 3. Scope

### Included

- Application build and test on Node.js 22.
- Docker image creation and smoke validation.
- Deployment to the existing Azure Container App.
- PostgreSQL connectivity and application transaction validation.
- Event Hubs producer connectivity and outbox publication validation.
- Key Vault-backed runtime secrets and managed-identity access.
- Log and platform-metric review.
- Bounded smoke/load test.
- Application rollback rehearsal.

### Excluded

- Production deployment or enabling `AZURE_DEPLOY_PRODUCTION`.
- Destructive or repeat execution of the two existing SQL migrations.
- Real KBank transactions or claims of official signature verification.
- Production data migration.
- Kafka consumer validation; no consumer exists in this repository.
- Redis performance or failover validation; the Azure templates do not provision Redis and the current service connects lazily.
- 50,000-RPS proof, multi-zone resilience, HA database failover, or disaster-recovery certification.
- Public launch, staff/admin traffic, or tenant-isolation certification.

## 4. Current deployment baseline

The repository already provides:

- `.github/workflows/test.yml` for CI and environment dispatch.
- `.github/workflows/deploy.yml` for guarded Azure deployment.
- `scripts/ci/deploy-azure.sh` for immutable image publication, revision readiness, and HTTPS health checks.
- `scripts/ci/container-smoke.sh` for production-mode container verification against isolated PostgreSQL.
- `infra/hosting.bicep` and `infra/hosting-app.bicep` for hosting resources and the Container App.
- `infra/github-identity.bicep` for the GitHub `testing` environment OIDC identity.
- `infra/azure-postgresql.json` and `infra/azure-eventhubs.json` for data and messaging resources.
- `/api/health/live` and `/api/health/ready`; readiness currently checks PostgreSQL only.
- A non-root, multi-stage production image.
- Separate `restaurant` and `restaurant_test` databases.
- Key Vault secrets for the database URL, Event Hubs password, and webhook token.

Known current constraints:

- The working branch is `testing`, but the working tree has uncommitted documentation changes. Do not deploy until the intended commit is explicit.
- CD updates an existing app only; it does not provision infrastructure, alter secrets, or run migrations.
- There is no automatic application or database rollback.
- Container Apps uses Single revision mode and one replica. The update is readiness-gated but is not a canary rollout.
- The application runs the outbox publisher and reservation-expiry timer inside the API process, so scale-to-zero is not allowed.
- PostgreSQL is publicly addressed with firewall allowlisting, not private endpoint isolation.
- Reapplying the Event Hubs template can remove the hosted-app egress rule unless both developer and hosted IPs are preserved.
- RLS is enabled on several tables but policies and low-privilege tenant enforcement are not production-certified.
- The interim KBank adapter uses a shared token and is not equivalent to official bank signature verification.
- Outbox delivery is at least once and no idempotent downstream consumer is present.

## 5. Deployment topology

```text
GitHub testing branch
        |
        v
CI: checks -> PostgreSQL integration -> Docker build -> container smoke
        |
        v
Verified image artifact -> GitHub OIDC -> private ACR
        |
        v
Azure Container App (single revision, one replica, HTTPS)
        |                    |                    |
        v                    v                    v
Azure PostgreSQL        Azure Event Hubs      Log Analytics
TLS + firewall          Kafka producer        app/platform logs
        ^                    ^
        |                    |
        +---- fixed NAT egress address --------+

Runtime secrets: Azure Key Vault -> app managed identity -> Container App
```

## 6. Roles and decision authority

- **Release owner:** owns scope, commit selection, change window, go/no-go, and test report.
- **Deployment operator:** watches GitHub Actions and Azure revision state, records evidence, and performs rollback.
- **Database owner:** validates backup/PITR state, schema version, connection budget, and post-test reconciliation.
- **Application tester:** runs the approved functional and negative test cases using synthetic data.
- **Security approver:** confirms OIDC/RBAC, secret handling, network rules, and that the test does not expose unfinished admin/payment capabilities.
- **Incident lead:** has sole authority to declare rollback, database recovery, or test termination.

One person may fill several roles for a small test, but release owner and operator responsibilities must be explicit before deployment.

## 7. Entry criteria

### Source and change control

- [ ] Identify the exact commit intended for deployment.
- [ ] Review the current uncommitted `README.md` change and untracked `FRONTEND_NEXTJS_GUIDE.md`; commit them if intended or exclude them deliberately.
- [ ] Confirm the deployment commit is on `testing`, pushed to the remote, and contains no local-only files.
- [ ] Confirm required branch protection makes `Test and build` mandatory.
- [ ] Confirm no unrelated infrastructure or secret changes are bundled into the application release.
- [ ] Record the release owner, operator, test window, and rollback approver.

### Application quality

- [ ] `npm ci` succeeds from the committed lockfile.
- [ ] `npm run check` succeeds, including the configured coverage thresholds.
- [ ] `npm run test:integration` succeeds against a disposable PostgreSQL 17 database.
- [ ] Linux AMD64 image build and `scripts/ci/container-smoke.sh` succeed.
- [ ] Workflow syntax and shell scripts are validated (`actionlint` and shell syntax check).
- [ ] Dependency and container vulnerability scans have no unaccepted critical findings. This is a recommended new gate; the existing workflow does not yet show one.
- [ ] The image starts as non-root and demo routes return 404 in production mode.

### Azure platform

- [ ] Correct subscription and resource group are selected: the current test target is `rg-jaj-dev-sea` in Southeast Asia.
- [ ] Container App exists, uses Single revision mode, contains the `api` container, and targets port 3000.
- [ ] ACR admin access is disabled; app identity has `AcrPull`; GitHub identity has only scoped `AcrPush` and Container App deployment access.
- [ ] GitHub environment is `testing`, its branch policy permits only `testing`, and OIDC subject/audience match the identity definition.
- [ ] `AZURE_DEPLOY_TESTING=true`; `AZURE_DEPLOY_PRODUCTION` remains unset or false.
- [ ] Key Vault is healthy, purge protection is enabled, and all three referenced secrets have enabled current versions.
- [ ] The Container App's managed identity can read only the required secrets.
- [ ] NAT public IP is unchanged and allowlisted in both PostgreSQL and Event Hubs.
- [ ] Event Hubs network rules preserve both the developer and hosted-app rules. Do not reapply the current template without preserving the hosted-app rule.
- [ ] Log Analytics has available daily quota and retention is acceptable for the test.

### Database and messaging

- [ ] Verify the target is `restaurant`, never `restaurant_test` for the hosted application.
- [ ] Verify migrations `001` and `002` are already represented in the schema. Do not run `npm run db:migrate` against the existing database.
- [ ] Confirm a restorable backup/PITR point and record its timestamp before any schema-affecting test.
- [ ] Confirm PostgreSQL connection count leaves headroom for one five-connection app pool plus operator access.
- [ ] Confirm TLS verification succeeds and no SSL flags are embedded in `DATABASE_URL`.
- [ ] Confirm Event Hubs `orders.v1` exists, has two partitions, and the app credential is Send-only.
- [ ] Record the current unpublished outbox count and oldest unpublished event age.

### Rollback readiness

- [ ] Record the current active revision and exact previous working image digest.
- [ ] Confirm the previous digest still exists in ACR and is pullable by the app identity.
- [ ] Confirm the operator can update the Container App but cannot broadly modify unrelated resources.
- [ ] Confirm any database change is backward-compatible with both current and candidate images.
- [ ] Agree on abort thresholds and the incident communication channel.

## 8. Pre-deployment procedure

Perform these actions in order:

1. Freeze the deployment commit and publish a short change summary covering API, schema, configuration, infrastructure, and dependency changes.
2. Review the diff from the last successful test deployment to the candidate commit.
3. Classify the release:
   - **Application-only:** use routine CI/CD.
   - **Configuration/secret change:** update Key Vault or Container App settings under separate change control, validate references, then deploy.
   - **Infrastructure change:** compile Bicep, run validation and `what-if`, review changes, and deploy infrastructure before application CD.
   - **Schema change:** stop; follow the database change process below before application deployment.
4. Capture the pre-deployment evidence pack:
   - active Container App revision and image digest;
   - health responses;
   - replica state and recent restart count;
   - PostgreSQL health, connections, backup/PITR status, and schema check;
   - Event Hubs availability and outbox backlog;
   - relevant alerts and unresolved incidents.
5. Prepare synthetic fixtures in a dedicated test branch/table/menu/inventory scope. Do not reuse real customer data or real bank transactions.
6. Announce the start of the test window and name the rollback decision maker.

## 9. Database change procedure

The current `db:migrate` command replays raw SQL files without a migration ledger and is unsafe for an already initialized database. For this test:

- If the candidate has no new migration, verify the expected schema and continue.
- If the candidate adds a migration, do not let application CD execute it automatically.
- Review the SQL for locks, rewrites, index-build duration, privilege changes, and compatibility with both old and new application versions.
- Take or verify a recovery point.
- Use a dedicated migration identity from a host that can reach PostgreSQL.
- Apply only the new migration once and record its checksum, operator, start/end time, and result in a temporary release ledger.
- Prefer expand-and-contract changes: add compatible structures first, deploy code, backfill separately, then remove old structures in a later release.
- Drain old writers when a change requires every new write to populate new data.
- Validate row counts, constraints, indexes, permissions, and application-role access before allowing application deployment.
- Never automatically delete or rewrite financial/order data to make a migration pass.

Before future unattended deployments, introduce a real migration tool/ledger and a controlled Azure migration job with concurrency locking.

## 10. Deployment execution

The preferred trigger is a reviewed merge or push to `testing`. The existing workflow then:

1. Checks out the immutable commit with persisted Git credentials disabled.
2. Installs dependencies using the lockfile.
3. Runs lint, strict type checking, coverage-gated tests, production build, and PostgreSQL integration tests.
4. Builds the Linux AMD64 image.
5. Starts the image against isolated PostgreSQL, applies migrations to that fresh database, checks live/ready endpoints, and verifies demo routes remain hidden.
6. Saves the exact verified image as a short-lived workflow artifact.
7. Enters the GitHub `testing` environment and obtains a short-lived Azure token through OIDC.
8. Loads, uniquely tags, and pushes the verified image to private ACR.
9. Resolves the ACR manifest and deploys the immutable digest, not the mutable tag.
10. Waits for the exact new Azure revision to report ready.
11. Calls both HTTPS health endpoints and records the image digest, revision, and URL in the workflow summary.

Operator rules:

- Do not bypass a failed CI stage.
- Do not rerun only CD with an unverified replacement image.
- Do not edit runtime secrets as part of troubleshooting unless the incident lead approves a separate change.
- Do not enable the production deployment flag.
- If an infrastructure change is needed, pause and run the reviewed Bicep path; routine CD is image-only.

## 11. Post-deployment validation

Run validation in layers. Stop immediately if an earlier layer fails.

### Layer 1: platform and health

- Confirm the deployed digest matches the successful CI artifact.
- Confirm the latest ready revision is the candidate revision and there are no crash loops.
- Verify HTTPS only; HTTP must not be accepted as an insecure path.
- Verify `/api/health/live` returns 200 independently of downstream checks.
- Verify `/api/health/ready` returns 200 and reports database readiness.
- Verify `/api/users` and `/api/products` return 404 in production mode.
- Inspect logs for startup errors, secret leakage, PostgreSQL TLS errors, Event Hubs authentication errors, and repeated restarts.

### Layer 2: controlled functional journey

Using synthetic fixtures only:

1. Create a table session using a valid test branch, table identity, and rotating code.
2. Create an order with a unique idempotency key and a small reserved quantity.
3. Repeat the identical request and confirm the same public order result is returned without duplicate inventory reservation.
4. Reuse the key with a changed payload and confirm the request fails as designed.
5. Read the public order status and exercise one allowed extension.
6. Submit a synthetic test-only payment confirmation using the configured shared token; do not call a real bank endpoint.
7. Repeat the identical confirmation and confirm it is idempotent.
8. Submit a changed transaction/amount and confirm conflict/reconciliation behavior without overwriting confirmed evidence.
9. Create a second pending test order and allow it to expire; verify inventory is released and order status changes.

Validate PostgreSQL invariants after the journey:

- inventory is never negative and reserved quantity reconciles;
- exactly one order exists for the idempotency identity;
- payment evidence was not overwritten;
- expected order/payment/expiry outbox events exist;
- no unrelated branch or customer rows changed.

### Layer 3: Event Hubs/outbox

- Confirm the publisher establishes its Kafka connection without logging credentials.
- Confirm test outbox rows receive `published_at` after broker acknowledgement.
- Confirm Event Hubs incoming request/message metrics increase for the test window.
- Record the test event IDs and verify stable IDs on any deliberate retry.
- Briefly test broker unavailability only in an approved window: events must remain unpublished and later recover. Do not perform this if it risks shared test users.
- Do not claim end-to-end event processing; there is no consumer to validate.

### Layer 4: negative and security checks

- Invalid/malformed UUIDs and oversized or unknown DTO fields are rejected.
- Missing or blank webhook authentication fails closed.
- Expired public access cannot extend an order.
- Demo/admin-like routes remain hidden.
- Responses and logs do not expose database connection strings, Key Vault URIs with credentials, webhook tokens, Kafka passwords, stack traces, or public order capabilities.
- Basic rate-limit/brute-force protection is not yet implemented; keep the environment controlled and record this as an open public-exposure gate.

### Layer 5: bounded load smoke

Use `test/load/smoke.mjs` only as a bounded regression smoke, not a capacity proof.

- Start with concurrency 1 for 60 seconds against `/api/health/live` and `/api/health/ready`.
- Increase to 5, then 10 concurrent clients for five minutes each if the prior stage is healthy.
- Use at most 1% error rate and 1,000 ms p95 as the temporary stop thresholds.
- Watch Container App CPU/memory/restarts, response p50/p95/p99, PostgreSQL connections and latency, and Log Analytics ingestion.
- Stop if memory grows continuously, database pool waits/errors appear, readiness flaps, Event Hubs backlog grows unexpectedly, or any dependency is destabilized.
- Run write-load tests only after a repeatable fixture/reset process exists. Health-route load does not establish business-endpoint capacity.

## 12. Observability and alerts

During the test, keep a single dashboard/view covering:

- Container App revision, replica health, restarts, CPU, memory, and request count.
- HTTP status rate and latency by route where available.
- Application errors grouped by correlation ID or revision.
- PostgreSQL active/max connections, CPU, storage, query latency, locks, failed connections, and backup status.
- Event Hubs incoming requests/messages, server errors, throttling, and throughput-unit utilization.
- Outbox unpublished count and oldest-event age from PostgreSQL.
- NAT/firewall connection errors.

Immediate alert/abort conditions:

- health endpoints fail for more than two consecutive checks;
- candidate revision crash-loops or never becomes ready within ten minutes;
- unexpected HTTP 5xx rate exceeds 1% for five minutes;
- PostgreSQL approaches its safe connection budget or shows sustained lock/timeout errors;
- unpublished outbox age exceeds five minutes while Event Hubs is expected healthy;
- any credential or customer-sensitive value appears in logs;
- inventory, payment, or idempotency invariants fail.

Recommended near-term improvements before broader testing:

- structured JSON logs with revision, request ID, route, status, duration, and safe domain identifiers;
- OpenTelemetry traces across HTTP, PostgreSQL, and Kafka publication;
- custom metrics for DB pool wait, outbox backlog/age, publisher failures, expiry batch duration, and rejected requests;
- actionable Azure Monitor alerts routed to an owned channel;
- readiness components for every dependency required to serve traffic, while keeping liveness process-only.

## 13. Rollback plan

### Application rollback triggers

- Candidate revision does not become ready within ten minutes.
- HTTPS health fails after rollout.
- Unexpected 5xx rate exceeds the abort threshold.
- Functional, security, inventory, payment, or idempotency checks fail.
- Outbox publication stops or creates an unsafe backlog.
- Resource exhaustion, crash loops, or material log leakage occurs.

### Application rollback procedure

1. Stop further tests and announce rollback.
2. Capture the failing revision, image digest, timestamps, logs, metrics, and test correlation IDs.
3. Update the same Container App container to the previously recorded working digest in ACR.
4. Wait for that rollback revision to become the latest ready revision.
5. Verify live and ready endpoints over HTTPS.
6. Repeat a minimal read-only smoke check and verify the outbox/reservation workers resume.
7. Reconcile any synthetic orders, reserved inventory, payments, and unpublished events created during the failed window.
8. Keep the failed image and evidence until the incident review is complete.

Do not rebuild an old commit to roll back; use the previously verified immutable digest.

### Database recovery rules

- Prefer an application rollback when schema changes are backward-compatible.
- Prefer a forward-fix migration for non-destructive schema defects.
- Do not run ad hoc down SQL against financial/order tables.
- Restore from backup/PITR only under incident-lead and database-owner approval, after defining the recovery point and data-loss window.
- Reconcile PostgreSQL state with outbox/Event Hubs publication before reopening tests; restoring the database alone can reintroduce already-published events.

## 14. Test completion and evidence

The release owner records:

- commit SHA, workflow run, CI result, coverage result, and image digest;
- previous and new Container App revisions;
- pre/post health responses and timestamps;
- functional test IDs and expected/actual outcomes;
- PostgreSQL invariant queries and result summaries;
- Event Hubs metrics and outbox publication evidence;
- load-smoke configuration and JSON output;
- relevant logs/metrics screenshots or exports;
- rollback rehearsal result;
- deviations, accepted risks, owners, and due dates.

The deployment is closed as one of:

- **Pass:** every required gate passed and evidence is complete.
- **Pass with accepted limitations:** functional deployment passed, but explicitly excluded capabilities remain open.
- **Failed and rolled back:** previous digest restored and data reconciled.
- **Aborted before deployment:** an entry criterion failed; no Azure application change was made.

## 15. Recommended implementation backlog

Before promoting this pattern toward production:

1. Add a migration ledger and locked, auditable migration job.
2. Add automatic rollback or multiple-revision traffic control after a post-deployment smoke failure.
3. Add SBOM generation, dependency/container scanning, and image signing/attestation.
4. Add reproducible test-fixture creation and cleanup for deployed functional tests.
5. Add OpenTelemetry, structured logs, domain metrics, dashboards, and alerts.
6. Persist outbox failure attempts/last error and alert on backlog age.
7. Implement idempotent Kafka consumers and validate duplicates, reordering, and recovery.
8. Implement official KBank signature verification and reconciliation.
9. Implement staff authentication, branch/tenant authorization, and tested RLS policies using a non-owner application role.
10. Add ingress WAF/rate limiting and protect bearer-style public order capabilities from logs, referrers, and caches.
11. Move PostgreSQL and Event Hubs toward private networking for production.
12. Separate API traffic from background workers before independent scaling.
13. Provision and test managed Redis only when a real cache/session use case is enabled.
14. Add multi-replica, zone, backup/restore, failover, soak, and capacity tests in a production-shaped environment.

## 16. Go/no-go checklist

The release owner must answer **yes** to every item before deployment:

- [ ] Is the exact commit reviewed, clean, and pushed to `testing`?
- [ ] Did every CI and container gate pass for that commit?
- [ ] Are Azure target, OIDC identity, Key Vault references, and network allowlists verified?
- [ ] Is the database schema compatible and is a recovery point confirmed?
- [ ] Is the previous immutable image digest recorded and available?
- [ ] Are synthetic fixtures and non-destructive test cases ready?
- [ ] Are monitoring views open and abort thresholds agreed?
- [ ] Is a rollback operator present for the full test window?
- [ ] Is production deployment still disabled?
- [ ] Are all known limitations accepted in writing for this test only?

If any answer is **no**, postpone the deployment rather than bypassing the gate.

## 17. Suggested schedule

- **T-2 business days:** freeze scope, review changes, assign roles, verify Azure and backup state.
- **T-1 business day:** run full CI, review vulnerability results, create fixtures, rehearse rollback inputs.
- **T-30 minutes:** capture baseline evidence, confirm no incident/maintenance conflict, announce start.
- **T0:** merge/push the approved commit to `testing` and observe the pipeline.
- **T+15 minutes:** finish platform and health validation.
- **T+45 minutes:** finish functional, database, and Event Hubs validation.
- **T+75 minutes:** finish bounded load smoke and observability review.
- **T+90 minutes:** rehearse rollback if this is the first deployment of the process, then redeploy the approved candidate if required.
- **T+1 business day:** review logs/metrics, close evidence, and create backlog items for every deviation.

## 18. Final recommendation

Proceed with a controlled test deployment through the existing `testing` workflow after the working tree is made intentional and all entry gates pass. Keep the environment private/controlled, use synthetic data, do not run existing migrations again, and treat the result as a deployment-path validation—not production approval.
