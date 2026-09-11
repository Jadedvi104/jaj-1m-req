# CI/CD

The workflows target GitHub Actions and Azure Container Apps. Development hosting
is provisioned in Singapore and the GitHub testing environment is configured.
Pushes to testing deploy after CI passes. Production deployment remains disabled.
CD updates existing apps; infrastructure and runtime secrets are managed separately.

## Branch flow

- Pull requests run checks without Azure credentials or deployments.
- Pushes to `dev`, `testing`, `main`, and `codex/**` run CI.
- `testing` deploys to the GitHub `testing` environment when the repository
  variable `AZURE_DEPLOY_TESTING` is exactly `true`.
- `main` deploys to the GitHub `production` environment when the repository
  variable `AZURE_DEPLOY_PRODUCTION` is exactly `true`.
- Actions → Quality checks → Run workflow reruns the pipeline for a selected
  branch. The same branch restrictions and enablement flags still apply.

Promote changes by merging `dev` → `testing` → `main`. A main deployment tests
and builds its own merge commit; it does not assume that testing and main have
identical contents. Each deployment uses its own CI-verified image artifact.
Configure branch rules to require the `Test and build` check before merging.

## What CI verifies

`npm ci`, lint, TypeScript checks, unit/API tests with coverage thresholds,
production compilation, and all PostgreSQL integration tests against a temporary
PostgreSQL 17 service. No Azure credentials are required.

CI then builds the Linux AMD64 Docker image and starts it against another
isolated PostgreSQL database with the migrations applied. It checks liveness,
database readiness, and that the demo users/products routes return 404 in
production mode. These container checks disable Kafka; they do not test broker
publication. Both temporary containers and their network are removed on exit.

Coverage is retained for 14 days. On testing/main, the exact verified Docker
image is retained for three days and passed to CD in the same workflow run.
If a delayed deployment outlives the artifact, rerun the full pipeline.
Actions are pinned to commits. Keep these pins updated deliberately.

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
for testing and production, with federated credentials:

- Issuer: `https://token.actions.githubusercontent.com`
- Audience: `api://AzureADTokenExchange`
- Testing subject: `repo:Jadedvi104/jaj-1m-req:environment:testing`
- Production subject: `repo:Jadedvi104/jaj-1m-req:environment:production`

Grant each deployment identity `AcrPush` on its registry and
`Container Apps Contributor` on only its target app. Provisioning and assigning
roles remain separate administrator operations. The pipeline does not need
subscription Owner access or a stored Azure client secret.

In GitHub Settings → Environments, create `testing` and `production`. Restrict
allowed deployment branches to `testing` and `main`, respectively. Set a required
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

Finally set the **repository variables** `AZURE_DEPLOY_TESTING=true` and, only
when production is configured, `AZURE_DEPLOY_PRODUCTION=true`. Leave either
unset or `false` to keep that deployment disabled. These flags must be repository
variables because they are evaluated before entering a GitHub environment.

Repository admin access is needed for environment configuration and branch
rules. The default local GitHub CLI account `jaj-ai` has READ access, but the
repository Git credential has ADMIN access and was used to configure testing.
No credentials are committed. `scripts/ci/setup-github.sh` can repeat the setup
with an admin GitHub login. It preserves existing review settings and does not
change production. The development environment deploys automatically; no required
reviewer was added. Configure production approval separately when provisioning it.

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

CD downloads the image from the current successful CI run, signs in using OIDC,
pushes a unique commit/run tag to ACR, and updates only the configured container
image using its immutable digest. Runtime secrets and configuration stay in
Azure. It waits for that exact new revision to become ready, then checks both
HTTPS health endpoints. The job summary records the digest, revision, and URL.

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
docker build --platform linux/amd64 -t jaj-api:ci .
bash scripts/ci/container-smoke.sh
```

Run `npm run test:integration` with a separate disposable `TEST_DATABASE_URL` and
`TEST_DATABASE_SSL=false` for a local PostgreSQL service. For workflow changes,
run `actionlint` and `bash -n scripts/ci/*.sh` as well.

References: [Azure OIDC authentication](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect),
[Container Apps deployments](https://learn.microsoft.com/en-us/azure/container-apps/github-actions),
[GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments).
