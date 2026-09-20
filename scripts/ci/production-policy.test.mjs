import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionPolicy } from './production-policy.mjs';

function fixture() {
  const identity =
    '/subscriptions/sub/resourceGroups/prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/api';
  const resources = {
    app: {
      identity: { userAssignedIdentities: { [identity]: {} } },
      properties: {
        managedEnvironmentId: '/environments/prod',
        configuration: {
          activeRevisionsMode: 'Single',
          ingress: { allowInsecure: false, targetPort: 3000, external: true },
          registries: [{ server: 'prod.azurecr.io', identity }],
          secrets: ['database', 'kafka', 'webhook'].map((name) => ({
            name,
            identity,
            keyVaultUrl: `https://prod.vault.azure.net/secrets/${name}`,
          })),
        },
        template: {
          scale: { minReplicas: 2, maxReplicas: 4 },
          containers: [
            {
              name: 'api',
              env: [
                ...Object.entries({
                  NODE_ENV: 'production',
                  ENABLE_DEMO_CRUD: 'false',
                  DATABASE_SSL: 'true',
                  KAFKA_SSL: 'true',
                  DATABASE_POOL_SIZE: '10',
                  KAFKA_BROKERS: 'prod.servicebus.windows.net:9093',
                }).map(([name, value]) => ({ name, value })),
                { name: 'DATABASE_URL', secretRef: 'database' },
                { name: 'KAFKA_SASL_PASSWORD', secretRef: 'kafka' },
                { name: 'KBANK_WEBHOOK_TOKEN', secretRef: 'webhook' },
              ],
            },
          ],
        },
      },
    },
    environment: {
      id: '/environments/prod',
      properties: {
        zoneRedundant: true,
        vnetConfiguration: { infrastructureSubnetId: '/subnets/apps' },
      },
    },
    database: {
      properties: {
        network: {
          publicNetworkAccess: 'Disabled',
          delegatedSubnetResourceId: '/subnets/postgres',
        },
        highAvailability: { mode: 'ZoneRedundant' },
        backup: { backupRetentionDays: 35, geoRedundantBackup: 'Enabled' },
        storage: { autoGrow: 'Enabled' },
      },
    },
    broker: { name: 'prod', properties: { publicNetworkAccess: 'Disabled' } },
    vault: {
      properties: {
        enablePurgeProtection: true,
        enableRbacAuthorization: true,
        vaultUri: 'https://prod.vault.azure.net/',
      },
    },
    registry: {
      properties: {
        adminUserEnabled: false,
        anonymousPullEnabled: false,
        loginServer: 'prod.azurecr.io',
      },
    },
  };
  for (const resource of Object.values(resources))
    resource.tags = { environment: 'production' };
  return resources;
}

test('accepts the isolated HA profile', () =>
  assert.deepEqual(productionPolicy(fixture(), 'api'), []));
const scenarios = [
  [
    'wrong environment',
    (r) => {
      r.database.tags.environment = 'development';
    },
    /tagged/,
  ],
  [
    'public database',
    (r) => {
      r.database.properties.network.publicNetworkAccess = 'Enabled';
    },
    /PostgreSQL public/,
  ],
  [
    'public broker',
    (r) => {
      r.broker.properties.publicNetworkAccess = 'Enabled';
    },
    /Event Hubs public/,
  ],
  [
    'database without HA',
    (r) => {
      r.database.properties.highAvailability.mode = 'Disabled';
    },
    /HA/,
  ],
  [
    'short backup retention',
    (r) => {
      r.database.properties.backup.backupRetentionDays = 7;
    },
    /35-day/,
  ],
  [
    'missing geo backup',
    (r) => {
      r.database.properties.backup.geoRedundantBackup = 'Disabled';
    },
    /geo-redundant/,
  ],
  [
    'nonredundant app environment',
    (r) => {
      r.environment.properties.zoneRedundant = false;
    },
    /zone redundant/,
  ],
  [
    'single app replica',
    (r) => {
      r.app.properties.template.scale.minReplicas = 1;
    },
    /two always-on/,
  ],
  [
    'connection exhaustion',
    (r) => {
      r.app.properties.template.scale.maxReplicas = 11;
    },
    /connection budget/,
  ],
  [
    'wrong environment id',
    (r) => {
      r.app.properties.managedEnvironmentId = '/environments/dev';
    },
    /wrong managed/,
  ],
  [
    'ingress still restricted',
    (r) => {
      r.app.properties.configuration.ingress.external = false;
    },
    /launch acceptance/,
  ],
  [
    'insecure ingress',
    (r) => {
      r.app.properties.configuration.ingress.allowInsecure = true;
    },
    /HTTPS/,
  ],
  [
    'wrong broker',
    (r) => {
      r.broker.name = 'dev';
    },
    /production namespace/,
  ],
  [
    'plaintext secret',
    (r) => {
      r.app.properties.template.containers[0].env.find(
        (e) => e.name === 'DATABASE_URL',
      ).value = 'secret';
    },
    /DATABASE_URL must reference/,
  ],
  [
    'foreign vault',
    (r) => {
      r.app.properties.configuration.secrets[0].keyVaultUrl =
        'https://other.vault.azure.net/secrets/database';
    },
    /DATABASE_URL must reference/,
  ],
  [
    'unassigned secret identity',
    (r) => {
      r.app.properties.configuration.secrets[0].identity = '/other-identity';
    },
    /DATABASE_URL must reference/,
  ],
  [
    'registry password auth',
    (r) => {
      delete r.app.properties.configuration.registries[0].identity;
    },
    /Image pulls/,
  ],
  [
    'registry admin enabled',
    (r) => {
      r.registry.properties.adminUserEnabled = true;
    },
    /Registry admin/,
  ],
  [
    'demo routes enabled',
    (r) => {
      r.app.properties.template.containers[0].env.find(
        (e) => e.name === 'ENABLE_DEMO_CRUD',
      ).value = 'true';
    },
    /Demo CRUD/,
  ],
];
for (const [name, change, message] of scenarios) {
  test(`rejects ${name}`, () => {
    const resources = fixture();
    change(resources);
    assert.match(productionPolicy(resources, 'api').join('\n'), message);
  });
}
test('missing resources fail closed without crashing', () => {
  assert.ok(productionPolicy({}, 'api').length > 10);
});
