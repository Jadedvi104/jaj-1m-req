# CI/CD DevOps Handover and Operations Runbook

Maintained against the repository workflows on 2026-09-20.

Audience: DevOps/platform engineers, release operators, and database owners.
This is the repository runbook; provisioning steps for isolated staging are in
[STAGING.md](STAGING.md); production setup, local configuration and activation are
in [PRODUCTION.md](PRODUCTION.md). Follow the release procedure for routine deployments
and the troubleshooting playbook for failed runs.

The workflows target GitHub Actions and Azure Container Apps. Development hosting
is provisioned in Singapore and the GitHub testing environment is configured.
Pushes to testing deploy after CI passes. Production deployment remains disabled.
CD updates existing apps; infrastructure and runtime secrets are managed separately.

## Navigation

- [Branch flow](#branch-flow) and [CI gates](#what-ci-verifies)
- [Azure prerequisites](#one-time-azure-prerequisites) and [identity/access setup](#github--azure-authentication)
- [Database migrations](#database-migrations)
- [Ownership and access](#devops-ownership-and-access)
- [Environment handover status](#environment-handover-status)
- [Release procedure](#release-procedure)
- [Troubleshooting playbook](#troubleshooting-playbook)
- [Emergency rollback](#emergency-rollback-procedure)
- [Operations and handover checklist](#routine-operations-and-handover-checklist)

## Branch flow

- Pull requests run checks without Azure credentials or deployments.
- Pushes to `dev`, `testing`, `staging`, `main`, and `codex/**` run CI.
- `testing` deploys to the GitHub `testing` environment when the repository
  variable `AZURE_DEPLOY_TESTING` is exactly `true`.
- `staging` deploys to the separate GitHub `staging` environment only when
  `AZURE_DEPLOY_STAGING` is exactly `true`; see [STAGING.md](STAGING.md) for setup.
- `main` deploys to the GitHub `production` environment when the repository
  variable `AZURE_DEPLOY_PRODUCTION` is exactly `true`.
- Actions → Quality checks → Run workflow reruns the pipeline for a selected
  branch. The same branch restrictions and enablement flags still apply.

Promote changes by merging `dev` → `testing` → `staging` → `main`. A main deployment tests
and builds its own merge commit; it does not assume that testing and main have
identical contents. Each deployment uses its own CI-verified image artifact.
Configure branch rules to require the `Test and build` check before merging.

## What CI verifies

Before application checks, CI validates workflow syntax/expressions with actionlint,
checks all CI shell scripts with Bash and ShellCheck, and runs deployment regression
tests using fake GitHub/Azure/Docker commands. These tests exercise stale releases,
branch restrictions, image mismatch, rollout failure/timeout, and HTTP checks without
cloud credentials. The actionlint download is pinned to version 1.7.12 and a SHA-256
checksum in `scripts/ci/validate.sh`; update both together when upgrading it.

CI then runs `npm ci`, a high-severity production dependency audit, lint, TypeScript checks,
unit/API tests with coverage thresholds, production compilation, and all PostgreSQL
integration tests against a temporary PostgreSQL 17 service. The integration gate
includes the assembled Fastify customer journey from table-session creation through
order lookup/extension and an authenticated payment callback, with database and
outbox assertions. No Azure credentials are required.

CI then builds the Linux AMD64 Docker image and starts it against another
isolated PostgreSQL database with the migrations applied. The pipeline rejects
fixable critical vulnerabilities found in the built image, then checks liveness,
database readiness, and that the demo users/products routes return 404 in
production mode. These container checks disable Kafka; they do not test broker
publication. Both temporary containers and their network are removed on exit.

Coverage is retained for 14 days. On testing/staging/main, the exact verified Docker
image is retained for three days and passed to CD in the same workflow run.
CI also passes the verified Docker image ID as a job output; CD rejects a loaded
image that does not match before pushing or updating the app.
If a delayed deployment outlives the artifact, rerun the full pipeline.
Actions are pinned to commits. Keep these pins updated deliberately.
Dependabot checks npm, GitHub Actions, and the Docker base image weekly and opens
updates against `dev`; pinned Action updates still require CI and review.

## One-time Azure prerequisites

Development hosting was provisioned on 2026-09-11. Resource identifiers, the live
URL, fixed outbound IP, and GitHub variables are in
`infra/azure-hosting.deployment.json`. The development app uses the existing
`restaurant` database and `orders.v1` topic. The instructions below describe the
configured components and prerequisites for any additional environment.

For each deployment environment, provision:

1. An Azure Container Registry with admin access disabled. Use the standard RBAC
   registry permission mode for the role names below.
2. A Container Apps environment and Container App with a named application
   container. Configure Single revision mode, HTTPS ingress targeting port 3000,
   and HTTP probes on `/api/health/live` (startup/liveness) and
   `/api/health/ready` (readiness). The workflow requires Single mode and an
   ingress hostname reachable from its GitHub-hosted runner.
3. A managed identity for the app with `AcrPull` scoped to its registry, configured
   as the registry authentication identity. No registry admin password is needed.
4. Runtime settings: `NODE_ENV=production`, `ENABLE_DEMO_CRUD=false`, `PORT=3000`,
   `DATABASE_SSL=true`, an appropriate bounded `DATABASE_POOL_SIZE`, and the
   application's database, webhook, and Kafka configuration from `.env.example`.
   Store secret values in Azure Key Vault and reference them from Container Apps
   secrets with managed identity access. Never store `.env` in Git or artifacts.
5. Network access from the hosted application to PostgreSQL and Event Hubs. The
   current developer-IP firewall rules do not allow hosted app traffic. Arrange
   private networking or approved stable outbound addresses before activation;
   do not open the services to the internet as a workaround.

For the small development server, start with one app replica and pool size five.
The background outbox/expiry timers need at least one running replica to process
work without incoming HTTP traffic; scaling to zero pauses them. Provision
separate application databases and Kafka resources/credentials for testing and
production. The CI-only `restaurant_test` database is not a staging app database.
The existing development resources are not a production capacity or isolation
plan; see `infra/README.md` and `SECURITY_AUDIT.md` before enabling production CD.

## GitHub → Azure authentication

Use separate Entra applications/service principals or user-assigned identities
for testing, staging, and production, with federated credentials:

- Issuer: `https://token.actions.githubusercontent.com`
- Audience: `api://AzureADTokenExchange`
- Testing subject: `repo:Jadedvi104@29722893/jaj-1m-req@1348208947:environment:testing`
- Staging subject: `repo:Jadedvi104@29722893/jaj-1m-req@1348208947:environment:staging`
- Production subject: `repo:Jadedvi104@29722893/jaj-1m-req@1348208947:environment:production`

This repository uses GitHub's immutable default subject format, which includes
the owner and repository numeric IDs. Azure matches issuer, audience, and subject
case-sensitively; the older name-only subject does not authenticate this repository.
Verify the active GitHub setting with
`gh api repos/Jadedvi104/jaj-1m-req/actions/oidc/customization/sub` before creating
another environment identity.

Grant each deployment identity `AcrPush` and `Reader` on its registry and
`Container Apps Contributor` on only its target app. Provisioning and assigning
roles remain separate administrator operations. The pipeline does not need
subscription Owner access or a stored Azure client secret.

Production additionally needs Reader on its dedicated resource group for the
infrastructure preflight in `scripts/ci/verify-production.mjs`. This grants
configuration reads, not Key Vault secret values. `infra/production-app.bicep`
assigns it. The preflight requires a verified `infra/azure-production.deployment.json`
and checks isolation, HA, backups, TLS, replica/connection limits and managed
identity secret references before publishing a release image.

`AcrPush` does not grant `Microsoft.ContainerRegistry/registries/read`. The
workflow uses control-plane reads through `az acr show` and registry discovery,
so the registry-scoped `Reader` assignment is also required. If CI reports this
specific authorization failure, verify the environment's target and deployment
principal, apply that registry-scoped assignment using an authorized administrator,
allow RBAC propagation, then rerun the job for a fresh OIDC login. Do not grant
subscription-wide Contributor to solve a registry-read failure.
See [Microsoft's registry role reference](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-roles).

In GitHub Settings → Environments, create `testing`, `staging`, and `production`. Restrict
allowed deployment branches to `testing`, `staging`, and `main`, respectively. Set a required
reviewer for production if releases should need human approval. Configure these
protections before enabling deployment; workflow YAML does not create them.

Set these **environment variables** in each GitHub environment:

- `AZURE_CLIENT_ID`: its federated deployment identity client ID.
- `AZURE_TENANT_ID`: Entra tenant ID.
- `AZURE_SUBSCRIPTION_ID`: target subscription ID.
- `AZURE_RESOURCE_GROUP`: resource group containing the app.
- `AZURE_ACR_NAME`: registry resource name, without `.azurecr.io`.
- `AZURE_CONTAINER_APP`: existing Container App name.
- `AZURE_CONTAINER_NAME`: exact application container name inside that app.

The existing development subscription is
`98a11462-0668-4f32-9f32-47ff6f92ca35`, tenant
`9ab9e1f3-824b-450f-86b6-3ff3326147bc`. These IDs are not passwords.

Finally set the **repository variables** `AZURE_DEPLOY_TESTING=true`,
`AZURE_DEPLOY_STAGING=true`, and `AZURE_DEPLOY_PRODUCTION=true` only after each
respective environment is configured and verified. Leave any unready environment flag
unset or `false` to keep that deployment disabled. These flags must be repository
variables because they are evaluated before entering a GitHub environment.

Repository admin access is needed for environment configuration and branch
rules. Confirm the active operator account has the required permissions; local Git
credentials and GitHub CLI identities can differ. No credentials belong in Git. `scripts/ci/setup-github.sh` can repeat the setup
with an admin GitHub login and an Azure login allowed to update the testing
deployment identity. It computes the immutable GitHub subject from the repository
API, updates only the `github-testing` federated credential, preserves existing
environment review settings, and does not change production. The development
environment deploys automatically; no required reviewer was added. Configure
production approval separately when provisioning it.

## Database migrations

CD deliberately does not replay `npm run db:migrate`: the existing SQL files
create types/tables and alter columns without a migration ledger, so replaying
them on the current database would fail. The two current migrations are already
applied to the existing development `restaurant` database.

Before deploying a schema change, apply only the new migration once, with a
backup and a database migration identity, from a host that can reach the target
database. Use backward-compatible schema changes so the prior image still works
while a new revision starts. Set up a migration ledger and a controlled migration
job before adopting unattended schema deployments. Integration tests and the
container smoke test apply all migrations to fresh disposable databases only.

## Deployment verification and rollback

CD signs in using OIDC and validates the target before downloading the image from
the current successful CI run,
pushes a unique commit/run tag to ACR, and updates only the configured container
image using its immutable digest. Runtime secrets and configuration stay in
Azure. It waits for that exact new revision to become ready, then checks both
HTTPS health endpoints. The job summary records the digest, revision, and URL.

Deployment rechecks that the run commit is the current destination branch tip
after queue/approval waits and immediately before the app update. A superseded
release fails; run CI for the current tip instead. This prevents an old rerun from
silently rolling back a newer release. Concurrency still serializes deployments
per environment; a branch advancing after the final check is handled by its next
pipeline run. See [GitHub concurrency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

Each rollout uses a unique `ci-RUN_ID-RUN_ATTEMPT` revision suffix, verifies the
ready revision contains the intended digest, and checks that hosted demo routes
return 404. The summary records the previous ready revision and its actual image
even on a deployment failure. Failure diagnostics select only revision names and
health/provisioning states; runtime configuration and secrets are not dumped.

The readiness route verifies PostgreSQL connectivity, not schema compatibility
or Kafka delivery. Verify an application transaction and Kafka publication when
first enabling an environment. Do not treat a green health probe as a complete
production acceptance test.

A failed update/readiness check fails the workflow. There is no automatic database
or application rollback. In Single revision mode Azure gates traffic on revision
readiness; HTTP smoke failure after a rollout still needs investigation. To roll
back, use the Azure portal to deploy the last successful image digest from the
previous workflow summary to the same container. Confirm both health endpoints
and application behavior. Keep that image in ACR; artifact retention is separate
from registry retention. Database changes need their own compatible recovery plan.

## Local checks

```sh
npm ci
npm run check
node --test scripts/ci/*.test.mjs
bash scripts/ci/validate.sh
docker build --platform linux/amd64 -t jaj-api:ci .
bash scripts/ci/container-smoke.sh
```

Run `npm run test:integration` with a separate disposable `TEST_DATABASE_URL` and
`TEST_DATABASE_SSL=false` for a local PostgreSQL service. For workflow changes,
install actionlint and ShellCheck locally and run `bash scripts/ci/validate.sh`.
The validator can download the pinned actionlint build on Linux AMD64; ShellCheck
must be on PATH (it is preinstalled on the GitHub Ubuntu runner).

References: [Azure OIDC authentication](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect),
[Container Apps deployments](https://learn.microsoft.com/en-us/azure/container-apps/github-actions),
[GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments).

## DevOps ownership and access

Assign named owners and a backup owner in the team's service catalog before
production activation. This repository does not identify an on-call contact.

- **DevOps/platform:** Azure resources, environment variables, OIDC federation,
  least-privilege role assignments, network rules, image retention, deployment,
  monitoring, and rollback execution.
- **Application team:** application changes, test failures, API acceptance,
  backward-compatible schema changes, and payment/Kafka behavior.
- **Database owner:** migration review/application, backup verification, restore
  procedures, database grants, and tenant-isolation checks.
- **Release owner:** approval to promote, acceptance evidence, and incident
  coordination. Record the approver in the release ticket.

Operators need GitHub repository access suitable for the operation: Actions write
access to dispatch/rerun workflows, and administrative access to configure
protected environments and branch rules. Azure read access is sufficient for
inspection; role assignments require an authorized RBAC administrator. Routine
CD uses the dedicated environment identity, not an operator's administrator role.

For operator work, use GitHub CLI, Azure CLI with Container Apps support, and
Bicep. Local image verification also needs Docker, Node.js 22, npm, and access to
a disposable PostgreSQL instance. Authenticate interactively or through approved
organization tooling; do not copy tokens into tickets, logs, or this document.

## Environment handover status

As of this handover, repository configuration and the last verified external
state must be distinguished:

- **Development/testing:** checked-in hosting metadata identifies the deployed
  development app. The `testing` branch uses the GitHub `testing` environment.
- **Staging:** CI/CD and infrastructure templates are prepared for separate
  resources. Provisioning and activation are not verified by this handover.
  Follow [STAGING.md](STAGING.md); do not reuse the development app or credentials.
- **Production:** no production deployment has been verified in this work.
  Leave deployment disabled until its infrastructure, protections, and release
  acceptance have been established.
- **Registry incident:** the testing identity's registry-scoped Reader assignment
  was added during troubleshooting. [Run 35459609806](https://github.com/Jadedvi104/jaj-1m-req/actions/runs/35459609806)
  subsequently passed both CI and testing deployment for commit
  `b6ac3f72018ea9fe3f799aa4f9e4dc6aecfaebea`. Read-only verification on 2026-09-20
  confirmed ready revision `jaj-api-dev-sea--0000001` and a successful database
  readiness response. This verifies the existing pipeline; it is not a hosted
  execution of the new safeguards in this working tree.
- **GitHub administration:** the active CLI account reports READ access. Only
  the testing environment was visible during inspection; variable reads returned
  403 and branch-protection inspection returned 404. Staging/production activation
  and required-check configuration need verification with an administrator login.

Confirm live values at takeover. Documentation and deployment metadata are not a
substitute for checking the target environment, current revision, and latest run.

## Release procedure

### 1. Prepare the release

1. Confirm the destination branch and GitHub environment, and use a reviewed PR
   following the promotion flow above. Confirm the exact commit to release.
2. Review application, infrastructure, configuration, and database changes
   separately. Routine CD only updates an image; it will not apply the other three.
3. Record the currently healthy revision and image digest as the rollback target.
   Verify the digest remains available in the correct registry.
4. For schema changes, have the database owner verify backups, compatibility with
   the previous image, and the migration record. Apply the approved migration
   before deploying code that requires it.
5. Check the environment's seven Azure variables, branch restriction, approval
   policy, and repository enablement flag. For staging, verify the target app
   has the tag `environment=staging`.
6. Confirm database/broker network access and the app's access to Key Vault and
   ACR. Retain at least one replica while background timers remain in the API.

### 2. Run and observe the pipeline

Merge the approved PR, or select **Actions → Quality checks → Run workflow** and
choose the intended branch. The reusable Deploy to Azure workflow is called by
Quality checks; it is not the manual entry point.

From an authenticated operator terminal, an explicit staging dispatch is:

```sh
gh workflow run test.yml --repo Jadedvi104/jaj-1m-req --ref staging
gh run list --repo Jadedvi104/jaj-1m-req --branch staging --limit 5
```

Confirm the commit and run ID before inspecting or rerunning. With `RUN_ID` set
to that verified run:

```sh
gh run view "$RUN_ID" --repo Jadedvi104/jaj-1m-req
gh run view "$RUN_ID" --repo Jadedvi104/jaj-1m-req --log-failed
```

The test job has a 20-minute timeout and CD a 25-minute timeout. CD serializes
releases per environment and waits up to 60 polling intervals of 10 seconds for
the exact revision to become ready, plus command execution time. The final HTTP
checks retry transient failures. Do not dispatch repeated releases while
investigating an unhealthy revision.

If deployment failed because of a corrected external permission/configuration
issue and the image artifact still exists, rerun failed jobs for the same commit:

```sh
gh run rerun "$RUN_ID" --repo Jadedvi104/jaj-1m-req --failed
```

This can deploy the application; it is not a read-only troubleshooting command.
The commit must still be the destination branch tip; superseded runs are rejected.
If the image artifact expired, rerun all jobs for that run instead. To release a
new commit, start a new full pipeline. Never bypass a failed CI gate by manually
building and deploying a replacement image.

### 3. Accept the deployment

Copy the deployed revision, image digest, and URL from the job summary into the
release ticket. Set `APP_URL` to that verified HTTPS URL, then check:

```sh
curl --fail --silent --show-error --connect-timeout 10 --max-time 20 "$APP_URL/api/health/live"
curl --fail --silent --show-error --connect-timeout 10 --max-time 20 "$APP_URL/api/health/ready"
```

Verify demo users/products endpoints return 404. With approved synthetic fixtures,
exercise session creation, order creation and idempotent replay, order lookup,
reservation extension, and the staging payment callback. Confirm inventory
accounting and successful outbox publication. Coordinate fixtures and payment
callbacks with the application owner; do not use real customer payments for smoke
tests. For production, agree a safe verification transaction before release.

Check startup/dependency errors and available latency/error metrics. If required
telemetry or business verification is unavailable, record the gap rather than
marking it passed. A ready revision and green workflow alone do not establish
payment correctness, Kafka delivery, tenant isolation, or capacity.

## Troubleshooting playbook

### Registry read authorization failure

**Symptom:** `Microsoft.ContainerRegistry/registries/read` is denied during
**Verify deployment target**, even though Azure login succeeded.

The reported incident used testing identity object ID
`f52c3391-e2f6-48bc-bf03-69c1a7ec7a32`, targeting registry
`jajacrdevsea98a11462` in `rg-jaj-dev-sea`. Its `AcrPush` assignment was present;
registry-scoped Reader was missing. Do not substitute this testing identity for
a staging identity.

Set `ACR_SCOPE` to the full resource ID of the verified target registry and
`DEPLOY_PRINCIPAL_ID` to the deployment identity's **object/principal ID**, not
its client ID. Inspect effective assignments with an authorized account:

```sh
az role assignment list --scope "$ACR_SCOPE" --include-inherited \
  --query "[?principalId=='$DEPLOY_PRINCIPAL_ID'].{role:roleDefinitionName,scope:scope}" \
  --output table
```

Expect registry-scoped `AcrPush` plus `Reader` for the current standard-RBAC
registry design. Prefer reconciling `infra/hosting-app.bicep` after reviewing its
what-if, keeping the same app image and existing configuration. That template
uses deterministic assignment names; ad-hoc assignments with different names
can conflict with later infrastructure deployments. Do not rerun the entire app
template with defaults against another environment.

The live testing Reader assignment was aligned to template identifier
`775586cf-547f-5a2c-89d2-b6bbc088df18`. Allow RBAC propagation and rerun the failed
job to obtain a fresh login. Do not broaden access to subscription Contributor.
If the failure persists, verify the principal, registry scope, registry permission
mode, and any deny assignments. ABAC-enabled registries require a separately
reviewed repository-role model; do not assume AcrPush applies there.

### OIDC login failure

Check issuer, audience, exact environment subject, and the selected client ID.
Verify the GitHub environment and Azure identity refer to the same environment.
Inspect federation without retrieving credentials:

```sh
az identity federated-credential list \
  --resource-group "$IDENTITY_RESOURCE_GROUP" \
  --identity-name "$IDENTITY_NAME" \
  --query '[].{name:name,issuer:issuer,subject:subject,audiences:audiences}'
```

Do not replace OIDC with a committed client secret. Route identity or branch-policy
changes to the platform administrator.

### Deployment skipped or missing variables

Confirm the run is not a pull request, its branch matches the environment, and
the relevant `AZURE_DEPLOY_*` repository variable is the exact string `true`.
Deployment target variables belong to the GitHub environment. Environment approval
or branch restrictions can also prevent deployment from starting. Do not remove
protections to make an unexpected branch deploy.

### Staging target-tag rejection

Verify staging variables point to the separate staging app. Do not retag the
shared development app as staging to bypass this guard. Finish isolated provisioning
and correct the environment variables.

### Registry push or image-pull failure

Distinguish the pipeline identity from the application identity. Push uses the
pipeline's registry roles; startup image pull uses the app identity's `AcrPull`
and its configured registry reference. Check the registry permission mode,
network access, exact image digest, and role propagation. Registry administrator
credentials are not required by this design.

### Revision fails to become ready

Check the new revision, container startup, Key Vault references, TLS configuration,
database reachability, and whether required schema changes are applied. Configured
Kafka connects during module initialization, so broker authentication/network
failure can also prevent startup. Inspect system and application logs, treating
log output as potentially sensitive:

```sh
az containerapp revision list --name "$AZURE_CONTAINER_APP" \
  --resource-group "$AZURE_RESOURCE_GROUP" --output table
az containerapp logs show --name "$AZURE_CONTAINER_APP" \
  --resource-group "$AZURE_RESOURCE_GROUP" --type system --tail 50
az containerapp logs show --name "$AZURE_CONTAINER_APP" \
  --resource-group "$AZURE_RESOURCE_GROUP" --type console --tail 50
```

If logs select the prior healthy revision, use the portal or explicitly select
the failed revision/replica. The readiness endpoint only checks database
connectivity; missing tables may require business-path verification to detect.

### Healthy HTTP, but no events or expired reservations

Check that one replica remains running, Kafka is configured, and broker
credentials/firewalls permit access. Inspect outbox backlog and expiration delay
with the application/database owner. The publisher is at-least-once; consumers
must deduplicate. Do not delete unpublished outbox rows to clear an alert.

### Missing artifact, audit failure, or migration error

- **Expired image artifact:** rerun the complete pipeline. GitHub artifact
  retention and ACR retention are separate policies.
- **Dependency/image vulnerability gate:** have the application owner update and
  test the affected dependency or base image. Do not silently disable scanning.
- **Existing table/type during migration:** stop; the initial migrations are not
  replay-safe. Verify the migration record and apply only approved unapplied SQL.
- **Database connectivity after infrastructure update:** verify the NAT address
  remains allowlisted in both PostgreSQL and Event Hubs. Reapplying the Event
  Hubs template must retain the complete `additionalAllowedIps` list.

## Emergency rollback procedure

1. Freeze promotions and set the affected repository deployment flag to `false`.
   This stops future eligible jobs; it does not cancel a deployment already
   running. Inspect and coordinate active/queued jobs before proceeding.
2. Select the prior successful digest from the release record. Verify it belongs
   to the target environment and is compatible with the current schema.
3. Record the failing revision and preserve logs for diagnosis.
4. Set `ROLLBACK_IMAGE` to the full verified `registry/jaj-api@sha256:...` value.
   With the environment's app variables set, deploy it using an authorized identity:

```sh
az containerapp update --name "$AZURE_CONTAINER_APP" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --container-name "$AZURE_CONTAINER_NAME" \
  --image "$ROLLBACK_IMAGE" \
  --query properties.latestRevisionName --output tsv
```

5. Wait for that returned revision to match `latestReadyRevisionName`, then repeat
   both health checks and the agreed business acceptance checks. A successful CLI
   response alone does not prove recovery.
6. Record incident, revision, digest, results, and schema compatibility. Re-enable
   deployment only after the release owner approves resumption.

Application rollback does not reverse database changes. Database restore or
forward repair requires the database owner's recovery plan and explicit handling
of writes that occurred after the backup. Never restore a shared database merely
to undo an application image deployment.

## Routine operations and handover checklist

Review dependency/action/base-image updates, available application metrics,
PostgreSQL connection usage, storage/backups, outbox backlog, Kafka capacity, and
Azure costs regularly. The initial profile is intentionally small and not a
production capacity guarantee. NAT and always-on resources incur costs while idle.

Rotate credentials through the approved secret process and Key Vault. Verify the
app has picked up the new secret version; restart/revise it when required by the
secret-reference strategy, and repeat connectivity checks before retiring the old
credential. Do not rotate credentials by rerunning templates with generated values.

Keep successful image digests needed for rollback out of registry cleanup. Test
backup restoration in an isolated environment and record the observed recovery
time; this repository does not establish an RPO/RTO or alert thresholds.

Before accepting operational ownership, record:

- [ ] Named platform, application, database, and release owners, with escalation contacts.
- [ ] Environment inventory, exact branch mapping, current revision, URL, and digest.
- [ ] GitHub environment restrictions, reviewers, required checks, and enablement flags.
- [ ] Separate identities, OIDC subjects, registry/app/vault permissions, and network rules.
- [ ] Migration history, backup evidence, restore procedure, and schema compatibility.
- [ ] Successful full CI run and target-environment release acceptance evidence.
- [ ] Tested rollback path and retained prior image.
- [ ] Monitoring ownership, alert thresholds, recovery objectives, and cost review cadence.
- [ ] Staging isolation and production readiness gaps explicitly accepted or resolved.

A release record should include environment, commit, PR/run URL, approval,
image digest, new/prior revision, schema changes, acceptance results, operator,
and rollback outcome if applicable. Keep credentials and customer data out of it.
