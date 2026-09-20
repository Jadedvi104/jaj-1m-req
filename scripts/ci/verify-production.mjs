import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { productionPolicy } from './production-policy.mjs';

const metadataPath = 'infra/azure-production.deployment.json';
if (!existsSync(metadataPath)) {
  throw new Error(
    'Production has not been recorded as deployed. Complete PRODUCTION.md before enabling production CD.',
  );
}
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const required = [
  'subscriptionId',
  'resourceGroup',
  'containerApp',
  'containerName',
  'managedEnvironment',
  'postgresServer',
  'eventHubNamespace',
  'keyVault',
  'registry',
];
if (
  metadata.environment !== 'production' ||
  required.some((key) => typeof metadata[key] !== 'string' || !metadata[key])
) {
  throw new Error(
    'Verified production deployment metadata is incomplete. See PRODUCTION.md.',
  );
}
for (const [key, expected] of Object.entries({
  AZURE_SUBSCRIPTION_ID: metadata.subscriptionId,
  AZURE_RESOURCE_GROUP: metadata.resourceGroup,
  AZURE_CONTAINER_APP: metadata.containerApp,
  AZURE_CONTAINER_NAME: metadata.containerName,
  AZURE_ACR_NAME: metadata.registry,
})) {
  if (process.env[key] !== expected)
    throw new Error(`Production metadata does not match ${key}`);
}
const types = {
  app: ['Microsoft.App/containerApps', metadata.containerApp],
  environment: [
    'Microsoft.App/managedEnvironments',
    metadata.managedEnvironment,
  ],
  database: [
    'Microsoft.DBforPostgreSQL/flexibleServers',
    metadata.postgresServer,
  ],
  broker: ['Microsoft.EventHub/namespaces', metadata.eventHubNamespace],
  vault: ['Microsoft.KeyVault/vaults', metadata.keyVault],
  registry: ['Microsoft.ContainerRegistry/registries', metadata.registry],
};
const resources = {};
for (const [key, [type, name]] of Object.entries(types)) {
  // Do not print returned resource configuration or call any secret-value API.
  resources[key] = JSON.parse(
    execFileSync(
      'az',
      [
        'resource',
        'show',
        '--ids',
        `/subscriptions/${metadata.subscriptionId}/resourceGroups/${metadata.resourceGroup}/providers/${type}/${name}`,
        '--output',
        'json',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    ),
  );
}
const errors = productionPolicy(resources, metadata.containerName);
if (errors.length) {
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}
console.log(
  'Production infrastructure policy passed. Business acceptance and backup restore evidence remain release prerequisites.',
);
