import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Parse dotenv as data: never source a file containing passwords as shell code.
const config = {
  ...parseEnv(readFileSync('.env', 'utf8')),
  ...parseEnv(readFileSync('.env.local', 'utf8')),
};
const phase = process.argv[2];
if (!['foundation', 'app'].includes(phase)) {
  throw new Error(
    'Usage: node scripts/prepare-production.mjs foundation|app [--check]',
  );
}
const value = (key) => {
  const result = config[`PRODUCTION_${key}`];
  if (!result || /^(REPLACE|TODO|<)/i.test(result))
    throw new Error(`Set PRODUCTION_${key} in .env.local first.`);
  return result;
};
const parameters = {
  location: value('AZURE_LOCATION'),
  prefix: value('AZURE_PREFIX'),
  registryName: value('AZURE_ACR_NAME'),
  vaultName: value('AZURE_KEY_VAULT'),
};
if (phase === 'foundation') {
  Object.assign(parameters, {
    resourceGroupName: value('AZURE_RESOURCE_GROUP'),
    postgresName: value('AZURE_PG_SERVER'),
    eventHubNamespace: value('AZURE_EVENTHUB_NAMESPACE'),
    alertEmail: value('ALERT_EMAIL'),
    postgresSku: value('AZURE_PG_SKU'),
    postgresAdminPassword: value('PG_ADMIN_PASSWORD'),
    applicationDatabasePassword: value('PG_APP_PASSWORD'),
    webhookAdapterToken: value('KBANK_WEBHOOK_TOKEN'),
  });
  if (
    parameters.postgresAdminPassword.length < 20 ||
    parameters.applicationDatabasePassword.length < 20 ||
    parameters.webhookAdapterToken.length < 32
  ) {
    throw new Error(
      'Database passwords require at least 20 characters; the adapter token requires at least 32.',
    );
  }
  if (
    parameters.postgresAdminPassword === parameters.applicationDatabasePassword
  )
    throw new Error('Use separate administrator and application passwords.');
} else {
  Object.assign(parameters, {
    appName: value('AZURE_CONTAINER_APP'),
    kafkaBroker: `${value('AZURE_EVENTHUB_NAMESPACE')}.servicebus.windows.net:9093`,
    image: value('IMAGE_DIGEST'),
    pipelinePrincipalId: value('AZURE_PIPELINE_PRINCIPAL_ID'),
    externalIngress: false,
    maxReplicas: 4,
  });
  const imagePrefix = `${parameters.registryName}.azurecr.io/jaj-api@sha256:`;
  if (
    !parameters.image.startsWith(imagePrefix) ||
    !/^[a-f0-9]{64}$/.test(parameters.image.slice(imagePrefix.length))
  ) {
    throw new Error(
      'PRODUCTION_IMAGE_DIGEST must be the verified jaj-api sha256 digest in the production registry.',
    );
  }
}
const output = {
  $schema:
    'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
  contentVersion: '1.0.0.0',
  parameters: Object.fromEntries(
    Object.entries(parameters).map(([key, item]) => [key, { value: item }]),
  ),
};
if (process.argv.includes('--check')) {
  console.log(
    `Production ${phase} parameters validated; no files or Azure resources changed.`,
  );
} else {
  const path = `infra/production-${phase}.parameters.local.json`;
  writeFileSync(path, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(
    `Wrote ${path}. This ignored file may contain secrets. No Azure resources changed.`,
  );
}
