# Staging deployment preparation

The `staging` branch has an independent CI/CD path. This repository change does
not provision Azure resources, configure GitHub remotely, or enable deployment.
The existing `testing` environment continues to target the development app.

## Architecture and isolation

Use a dedicated staging resource group in Southeast Asia with its own Container
App, Container Apps environment, ACR, Key Vault, app identity, NAT address,
PostgreSQL server, and Event Hubs namespace. Use a separate GitHub deployment
identity. Do not copy development credentials or connect staging to development
or production databases/topics. Resource names must be globally unique where
Azure requires it; no names or URLs in this document represent deployed resources.

The initial app uses the existing conservative profile: one always-on replica,
0.25 vCPU, 0.5 GiB memory, and five database connections. Background outbox and
expiration timers run inside the API, so scaling to zero pauses processing.
This staging profile validates deployment behavior, not the 50,000 RPS target.
Redis is currently lazy and is not required by the ordering path; provision and
configure a staging cache before enabling features that use Redis.

Keep `NODE_ENV=production` and `ENABLE_DEMO_CRUD=false` in staging. The environment
name belongs in Azure tags and GitHub configuration, not in NODE_ENV. The shared
app template already configures verified database TLS, HTTPS ingress, health
probes, managed-identity image pulls, and Key Vault references.

## Provisioning order

Use an administrator identity for infrastructure setup. Run Azure deployment
what-if and review the target names and scope before applying each template.
Use ignored `infra/*.local.json` parameter files for secrets; never pass secrets
as literal shell arguments or commit them. Preserve existing secret values when
reapplying templates. Use only synthetic customer/payment data in staging.

1. Create the dedicated staging resource group and a separate deployment identity
   using `infra/github-identity.bicep`. Set `githubEnvironment=staging` and an
   explicit staging `identityName`; retain the repository's verified immutable
   owner/repository IDs. Save the returned client and principal IDs. The OIDC
   subject is `repo:Jadedvi104@29722893/jaj-1m-req@1348208947:environment:staging`.
2. Provision `infra/azure-postgresql.json` with an explicit staging `serverName`
   and `environmentTag=staging`. Its `restaurant` database is the staging app
   database because the server is separate. `restaurant_test` is disposable and
   must never be used by the hosted app. Create a dedicated app login and separate
   migration ownership. Verify grants/RLS using that actual app login.
3. Provision `infra/azure-eventhubs.json` with an explicit staging `namespaceName`,
   `environmentTag=staging`, and the approved operator IP. Use its staging-scoped
   Send credential and `orders.v1` topic. Never reuse the development connection
   string.
4. Provision `infra/hosting.bicep` with `environmentTag=staging` and explicit
   staging `prefix`, `registryName`, and `vaultName`. Supply the staging database
   URL, staging Kafka password, and a unique staging webhook token securely.
   Capture the foundation's static `outboundAddress`.
5. Allowlist that NAT address on the staging PostgreSQL server. Reapply the
   Event Hubs template with the NAT address in `additionalAllowedIps` (as /32),
   retaining the entire approved list on future updates. Do not open either
   service to all IPs. Allow time for managed-identity RBAC propagation.
6. Apply migrations 001 and 002 once to the empty staging app database using a
   migration identity. The current migration command has no ledger and must not
   be replayed on an initialized database. Keep future changes backward-compatible
   and record their application; CI does not perform live migrations.
7. Run the full CI gate on `staging`. Its verified Linux AMD64 image artifact is
   exported even while CD is disabled. Load that artifact and publish it to the
   staging registry using an authorized bootstrap identity. Record its immutable
   digest; do not build a different image for the initial deployment.
8. Deploy `infra/staging.bicep` with the same staging foundation parameters,
   `appName`, `kafkaBroker`, the verified image digest, and the staging deployment
   identity's `pipelinePrincipalId`. This creates the app and scopes deployment
   permissions to the staging app/registry. It does not provision the database,
   topic, identity, firewall rules, or schema. It requires steps 1–7 first.
9. Verify the first deployment and record non-secret resource identifiers in a
   new `infra/azure-staging.deployment.json`. Do not overwrite the development
   deployment metadata.

## GitHub activation

Create the GitHub environment `staging` and restrict deployment branches to the
exact branch `staging`. Add a required reviewer if staging releases need approval.
Require the `Test and build` status check in branch protection and use pull
requests for promotion: `dev` → `testing` → `staging` → `main`.

Set these environment-scoped variables from the verified staging deployment:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_ACR_NAME`
- `AZURE_CONTAINER_APP`
- `AZURE_CONTAINER_NAME` (`api` with the provided template)

Only after configuration and acceptance checks pass, set repository variable
`AZURE_DEPLOY_STAGING=true`. Leave it unset or false during preparation. Pushes
and manual workflow runs on staging then deploy only after the full CI gate.
Pull requests cannot deploy. Never point the staging variables at the development
or production app. The deployment workflow also rejects a staging target unless
the app carries the Azure tag `environment=staging`. The existing `setup-github.sh` configures testing only; do not
run it to configure staging.

GitHub environment branch policies and Azure federation are separate controls.
Confirm the active OIDC subject format before provisioning federation; Azure
matches the subject exactly. See [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc)
and [deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Release acceptance and rollback

- Confirm both `/api/health/live` and `/api/health/ready` return success.
- Confirm `/api/users` and `/api/products` return 404.
- With synthetic seeded records, create a table session and order, verify
  idempotent replay, and confirm payment using the staging-only adapter token.
- Verify inventory accounting and successful outbox publication in staging.
- Verify the hosted app cannot access development/production resources.
- Record image digest, revision, schema version, URL, and smoke-test results.

Readiness checks database connectivity, not schema compatibility or Kafka delivery.
The shared-token bank adapter remains interim; staging acceptance does not approve
real payment processing. CI container tests also do not verify a live broker.

The deployment workflow waits for the exact new revision and checks HTTPS health.
A failure stops the workflow but does not automatically roll back. Redeploy the
previous successful immutable image digest to the staging app, then repeat health
and business checks. Keep the prior digest in ACR and maintain database backward
compatibility. See [Azure revision behavior](https://learn.microsoft.com/en-us/azure/container-apps/revisions).

## Preparation validation (2026-09-20)

- `npm run check` passed: lint, TypeScript, 256 unit/API tests across 17 suites,
  coverage gates, and production build.
- Workflow YAML and infrastructure JSON parse successfully.
- 72 branch/event/environment/enablement combinations were checked, along with
  staging image artifact export and non-canceling deployment concurrency.
- Staging and GitHub identity Bicep templates compile. The local compiler emits
  BCP081 warnings for three existing Microsoft.Network resources using API
  version 2026-03-01; their properties still require Azure-side validation/what-if.
- No live Azure provisioning, GitHub environment setup, deployment, real-database
  integration tests, or container smoke test was performed during preparation.
  Those remain release gates; passing local checks is not deployment verification.
