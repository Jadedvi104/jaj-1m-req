# Azure PostgreSQL development database

`azure-postgresql.json` defines a PostgreSQL 17 Flexible Server in Southeast Asia
(Singapore), with a Burstable Standard_B1ms instance, 32 GiB Premium SSD storage,
seven-day local backups, and no high-availability standby. These are development
settings, not a capacity plan for production traffic.

The template creates `restaurant` and a separate `restaurant_test` database and
allowlists the `pgcrypto` extension required by the schema migrations. The public
endpoint has no firewall rules in this template; add only the developer's approved
public IPv4 address before attempting a database connection. TLS remains enforced
by Azure's default configuration.

Deployment uses the Azure MCP `arm` router: create the resource group, run
`whatif_deployment`, inspect the result, then run `create_deployment` in Incremental
mode. Use `get_deployment_status` to verify completion. The server administrator
password is a `secureString` parameter supplied at deployment time.

Generated setup secrets are stored in the Git-ignored `.env.local` file with
owner-only permissions. It is not automatically loaded by this application's
configuration. Do not commit its contents. Application database credentials belong
in `.env`; retain `DATABASE_SSL=true` for Azure and leave SSL query parameters out
of `DATABASE_URL`. If the local trust store needs an additional Azure root CA,
provide its PEM content in `DATABASE_SSL_CA`.

Azure resources incur ongoing charges. Deleting the local template does not stop
or remove the server. Manage the server and its billing in the Azure portal.

## Current PostgreSQL setup

Provisioning and application setup are complete. Non-secret resource identifiers
are in `azure-postgresql.deployment.json`. The `developer-current-ip` firewall
rule allows the approved development network. `.env` now uses the `jaj_app`
login, verified TLS, and a pool size of five. Both migrations created 17 tables
in `restaurant`; all 22 integration tests passed against `restaurant_test`.

The development application role owns its tables, so PostgreSQL table-owner RLS
bypass still applies. This is not a verified production tenant-isolation model.
Use separate migration ownership and tested tenant policies before production.

For Azure integration tests, set `TEST_DATABASE_URL` to the separate
`restaurant_test` database and `TEST_DATABASE_SSL=true`. Supply
`TEST_DATABASE_SSL_CA` if a custom trusted root CA is needed. Never point this
suite at the application database.

## Azure Event Hubs for Kafka

`azure-eventhubs.json` defines a Standard namespace in Singapore with one
throughput unit, automatic capacity increases disabled, two partitions on
`orders.v1`, and 24-hour retention. The `orders-producer` policy grants only Send
access to that event hub. The `developerIp` deployment parameter restricts the
namespace firewall to one approved public IPv4 address. This capacity is for
initial development, not the project's production traffic target.

The deployment succeeded and application publication was verified. Resource
names and the test event ID are in `azure-eventhubs.deployment.json`. A clearly
marked `system.connectivity_test` event was sent by the real application outbox
publisher; its `published_at` field was set after broker acknowledgement. The
Kafka copy expires according to the topic's retention policy. The verification
process reported a socket reset during shutdown after successful delivery; this
test establishes connectivity and publication, not long-running reliability.

All five `KAFKA_*` settings are populated in the ignored `.env`. The SASL
username is the literal `$ConnectionString`; the password is the entire scoped
Azure connection string. Credentials were not added to these infrastructure
files. No Kafka consumer worker has been implemented by this setup.

Run the app locally with `npm run start:dev` to use the Azure settings in `.env`.
The existing Docker Compose stack explicitly uses local PostgreSQL and Redpanda;
it does not switch to these cloud settings automatically. Stop any existing
local app process before starting a new one.

When your public IP changes, update both the PostgreSQL `developer-current-ip`
firewall rule and the Event Hubs network rule. The hosted development app now has its own NAT egress firewall rule and
Key Vault references, described below.

Microsoft's retail API returned USD 0.03 per hour for the Standard throughput-unit
capacity meter in Singapore (USD 21.90 for 730 hours), plus usage and any other
applicable charges. This is a capacity estimate, not a guaranteed total bill.
Capture is not enabled. Pricing checked on 2026-09-08:
https://azure.microsoft.com/en-us/pricing/details/event-hubs/

## Development API hosting and CI/CD

The API is hosted in Azure Container Apps in Singapore. See `CI_CD.md` at the
repository root for the pipeline behavior and `azure-hosting.deployment.json`
for resource identifiers and its HTTPS URL. The `testing` GitHub environment
deploys this development app; no production app has been created.

`hosting.bicep` provisions the Consumption environment, Basic ACR, application
managed identity, Key Vault, 30-day Log Analytics workspace (1 GiB daily cap),
and a delegated subnet with a NAT gateway and static public IP. The vault uses
RBAC and purge protection. Its three secret inputs are secure parameters.
`hosting-app.bicep` provisions one replica (0.25 vCPU / 0.5 GiB), verified TLS,
health probes, Key Vault references, and deployment roles. `github-identity.bicep`
creates the separate OIDC identity in `rg-jaj-cicd-sea`.

These resources incur ongoing charges, including the NAT gateway and public IP
even when application traffic is idle. One replica stays running because the
application has background outbox and reservation timers. This is a development
configuration, not the million-request production capacity target.

The app egress IP is allowlisted in PostgreSQL as `hosted-app-egress` and added
to Event Hubs alongside the developer IP. Reapplying `azure-eventhubs.json` resets
its IP list to the developer address: re-add the hosted IP from the hosting
metadata before using the hosted app again. Keep the NAT IP allocated; update
both firewall rules if it changes. Neither service was opened to all Azure IPs.

To recreate or update infrastructure, compile the three Bicep files, run an Azure
resource-group deployment what-if, then deploy in Incremental mode. Deploy the
identity and foundation before the app. Supply `databaseUrl`, `kafkaPassword`,
and `webhookToken` to the foundation via an owner-only ignored parameter file.
Use the existing Key Vault values when updating; do not generate new values
unless intentionally rotating credentials. Supply the tested ACR digest as
`image` and the GitHub identity principal ID as `pipelinePrincipalId` to the app.
Do not commit parameter files containing credentials. Review the preview before
each infrastructure update. Routine CD only updates the container image.
