# Production setup and release

Prepared on 2026-09-20 for operator-managed Azure setup. **Production is not yet
provisioned or approved for customer traffic.** The local `.env` and `.env.local`
contain a `PRODUCTION_` section with proposed resource names, the existing tenant
and subscription IDs, and the supplied alert recipient. These files
are ignored by Git. Existing development settings are preserved.

## Capacity and cost

The prepared profile uses Southeast Asia (Singapore), two always-on API replicas
(each 0.5 vCPU / 1 GiB), a PostgreSQL 17 General Purpose D2s_v3 primary and
zone-redundant standby, 128 GiB storage per server, Standard Event Hubs, and a
Standard container registry. It is an initial availability profile, not proof of
the project's target request throughput.

Allow roughly **US$550–750/month** initially, before tax, traffic growth and
additional edge security. This is a planning allowance, not a quote or spending
cap. On 2026-09-20 the public Singapore retail meters were US$0.1175 per Dsv3
database vCore-hour (four billed vCores across primary and standby = US$343.10
per 730-hour month), US$0.138/GiB-month database storage, US$0.000034/vCPU-second
and US$0.000004/GiB-second for active Container Apps consumption. The two baseline
app replicas total about US$110.38/month if continuously active, before free grants.
Registry, broker, private endpoints, DNS, logs, backup overages and alerts add cost.
Idle billing, shared free allowances, workload, currency and contract affect totals.

A smaller single-instance/burstable profile could fit roughly US$100–200/month
at low traffic, but gives up automatic database failover and app redundancy.
It requires a separate capacity decision and changes to the template and release
policy; these templates deliberately implement the HA profile. Configure a
resource-group budget with 50/80/100% alerts to the operational email after choosing
a budget. Budget alerts do not stop resources or cap spending. App scaling can
reach four replicas; Event Hubs auto-inflation can reach four throughput units.

Verify the estimate in the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/),
[PostgreSQL pricing](https://azure.microsoft.com/pricing/details/postgresql/flexible-server/),
[Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/),
and [Event Hubs pricing](https://azure.microsoft.com/pricing/details/event-hubs/).

## Local configuration

Edit the `PRODUCTION_` block in `.env.local`. It overrides the same block in `.env`.
On a fresh clone, copy the production keys from `.env.example` into those ignored files.
Choose unique production administrator/application passwords (at least 20
characters each) and an independent adapter token (at least 32 characters).
Use quoted dotenv values when a secret contains `#`, spaces or quotes. Do not
reuse development credentials. Never source these files as shell scripts or
paste their contents into logs. The preparation script parses them as data.

Leave client ID, pipeline principal ID and image digest blank until the identity
and verified image exist. Resource names are proposals; Azure availability has
not been reserved. The custom domain is blank: the default Azure hostname is
the initial choice. No GitHub access token or Azure client secret is required;
the release workflow uses OIDC.

```sh
node scripts/prepare-production.mjs foundation --check
node scripts/prepare-production.mjs foundation
```

The second command writes `infra/production-foundation.parameters.local.json`,
ignored by Git and readable only by the file owner. It contains secrets. Neither
command contacts Azure. The templates do not read `.env` automatically, and
changing a local deployment flag does not change GitHub's repository variables.

## Azure provisioning order

Use an administrator with resource provisioning and role-assignment permissions.
Confirm the active subscription is `98a11462-0668-4f32-9f32-47ff6f92ca35`.
Register required resource providers, including `Microsoft.Insights`, before
deployment. The templates create only the dedicated production resource group.

1. Review and deploy the foundation:

   ```sh
   az deployment sub what-if --subscription 98a11462-0668-4f32-9f32-47ff6f92ca35 --location southeastasia --name jaj-production-foundation --template-file infra/production.bicep --parameters @infra/production-foundation.parameters.local.json
   az deployment sub create --subscription 98a11462-0668-4f32-9f32-47ff6f92ca35 --location southeastasia --name jaj-production-foundation --template-file infra/production.bicep --parameters @infra/production-foundation.parameters.local.json --output none
   ```

   The foundation provisions private PostgreSQL and Event Hubs networking,
   private DNS, a zone-redundant Container Apps environment, runtime managed
   identity, ACR, Key Vault runtime secrets, 90-day log retention and database
   CPU/memory/storage alerts. The registry is publicly reachable with authenticated
   OIDC pushes; Key Vault is publicly reachable with RBAC. Runtime identity access
   is limited to its three secrets. No database administrator credential is
   placed in the app or the vault. Preserve passwords on subsequent deployments.

2. Create a separate production deployment identity with
   `infra/github-identity.bicep` in the production group. Set an explicit identity
   name such as `jaj-prod-sea-github` and `githubEnvironment=production`. Verify
   the repository's active OIDC subject format as described in [CI_CD.md](CI_CD.md).
   The previously verified subject is
   `repo:Jadedvi104@29722893/jaj-1m-req@1348208947:environment:production`.
   Save the returned client ID and principal ID in the corresponding local
   `PRODUCTION_AZURE_CLIENT_ID` and `PRODUCTION_AZURE_PIPELINE_PRINCIPAL_ID` keys.

3. Bootstrap the empty `restaurant` database from a trusted runner with access
   to the production VNet. The public GitHub runner and ordinary Cloud Shell
   cannot reach this private database. Apply migrations 001 and 002 once under
   a separate migration owner, create `jaj_app` with the matching application
   password, and verify its grants and row policies. **This repository does not
   yet supply a tested production role/policy bootstrap or migration ledger.**
   The initial schema enables RLS without policies; making `jaj_app` the table
   owner bypasses that protection and is not a substitute. Resolve and test this
   application/database requirement before proceeding; connectivity-only health
   checks will not detect missing tables or insufficient runtime permissions.

4. Run Quality checks on the candidate release with production CD disabled.
   Use its `deployment-image-<commit SHA>` artifact within three days. As an
   authorized bootstrap operator, load `image.tar`, verify its Docker image ID
   against CI output, authenticate to the production registry, tag/push the
   loaded image as `jaj-api:<commit SHA>`, and obtain its immutable digest.
   Record `PRODUCTION_IMAGE_DIGEST` as
   `REGISTRY.azurecr.io/jaj-api@sha256:...`. Do not rebuild the bootstrap image.

5. Prepare and review the app parameters:

   ```sh
   node scripts/prepare-production.mjs app
   az deployment group what-if --subscription 98a11462-0668-4f32-9f32-47ff6f92ca35 --resource-group rg-jaj-prod-sea --template-file infra/production-app.bicep --parameters @infra/production-app.parameters.local.json
   az deployment group create --subscription 98a11462-0668-4f32-9f32-47ff6f92ca35 --resource-group rg-jaj-prod-sea --template-file infra/production-app.bicep --parameters @infra/production-app.parameters.local.json --output none
   ```

   Initial ingress is restricted to the Container Apps environment. The app
   template grants the pipeline Reader on the production group for configuration
   checks, Container Apps Contributor on the app, and AcrPush/Reader on the
   registry. It does not grant Key Vault data access. Allow RBAC propagation
   before retrying a first startup that cannot resolve secrets or pull images.

## Launch acceptance

Before enabling public ingress, complete the following from the private environment
and record results in the release PR:

- Test the customer journey with the actual non-owner app database role, including
  cross-branch denial, idempotency, inventory accounting and payment processing.
- Implement/verify the real KBank adapter against the bank's production contract.
  The current shared-token callback is an interim adapter, not bank signature
  verification or payment reconciliation. Obtain production credentials separately.
- Add and test abuse/rate controls on public session/order/payment entry points.
  The current request size limit does not implement rate limiting.
- Verify live Kafka publication and a recovering outbox; CI's container smoke
  test does not verify the broker. Verify the downstream order consumer exists.
- Restore a backup into a separate server and verify orders, payments and
  inventory; record measured recovery time and recovery point. Never restore
  over the primary for this exercise.
- Load-test the agreed launch traffic and tune replica count and database pool
  budget together. Defaults are two to four replicas and ten connections each;
  the release gate caps app connections at 100.
- Test the alert email, add API availability/error and outbox-backlog monitoring,
  configure the chosen cost budget, and rehearse image rollback in [CI_CD.md](CI_CD.md).

Once accepted, set `externalIngress=true` in the ignored app parameter file,
review/apply the app deployment again, and verify HTTPS `/api/health/live` and
`/api/health/ready` succeed while `/api/users` and `/api/products` return 404.
Re-running the preparation script resets ingress to restricted, by design.

## GitHub activation and the final click

1. In repository Settings → Environments, create `production`, permit only `main`
   and add a required release reviewer if the repository's plan supports it.
   Keep the main ruleset requiring `Test and build` and pull-request review.
2. Set production **environment variables** from the local `PRODUCTION_` keys,
   removing only that prefix: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_ACR_NAME`,
   `AZURE_CONTAINER_APP`, and `AZURE_CONTAINER_NAME`. Do not upload either dotenv
   file to GitHub or Container Apps. The runtime secrets already use Key Vault.
3. Copy `infra/azure-production.deployment.example.json` to
   `infra/azure-production.deployment.json`, fill it with the **actual verified**
   deployed names, and commit that non-secret record through the normal PR flow.
   The release gate fails closed when this record is absent or disagrees with
   GitHub/Azure. It also checks private dependencies, HA, backups, TLS and managed
   identity secret references. It does not replace the acceptance evidence above.
4. Merge reviewed setup changes through testing/staging into `main`. Only after
   acceptance, set the **repository variable** `AZURE_DEPLOY_PRODUCTION=true`.
   A value in `.env.local` does not activate deployment.
5. Actions → **Quality checks** → **Run workflow** → branch **main** is the routine
   release action. CI verifies the image; a configured production reviewer then
   approves the deployment. The pipeline deploys that exact artifact, rejects a
   superseded commit, and checks the resulting revision and HTTPS health.

No production resources, GitHub settings, or release flags were changed by this
preparation. Until the manual steps and application prerequisites above are
complete, this is a setup handover, not a one-click live production environment.

## Preparation verification

Both production Bicep entry points compile without warnings. Workflow validation,
ShellCheck and all 45 deployment/preparation policy tests pass. The shared staging
template also compiles, with its three pre-existing Network API type warnings.
No live Azure validation, what-if, production acceptance, or restore exercise has
been run for these production templates. Compilation is not service-side validation.
