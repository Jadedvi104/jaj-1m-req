// Evaluate only control-plane configuration. This is not a business acceptance test.
export function productionPolicy(
  { app, environment, database, broker, vault, registry },
  containerName,
) {
  const errors = [];
  const require = (condition, message) => {
    if (!condition) errors.push(message);
  };
  for (const [name, resource] of Object.entries({
    app,
    environment,
    database,
    broker,
    vault,
    registry,
  })) {
    require(resource?.tags?.environment ===
      'production', `${name} must be tagged environment=production`);
  }
  const configuration = app?.properties?.configuration;
  const template = app?.properties?.template;
  const container = template?.containers?.find(
    (item) => item.name === containerName,
  );
  const settings = Object.fromEntries(
    (container?.env ?? []).map((item) => [item.name, item]),
  );
  require(Boolean(container), 'Configured API container is missing');
  require(configuration?.activeRevisionsMode ===
    'Single', 'Single revision mode is required');
  require(configuration?.ingress?.allowInsecure ===
    false, 'HTTPS-only ingress is required');
  require(configuration?.ingress?.targetPort ===
    3000, 'Ingress must target port 3000');
  require(configuration?.ingress?.external ===
    true, 'Public release ingress is not enabled; complete launch acceptance first');
  require(settings.NODE_ENV?.value ===
    'production', 'NODE_ENV must be production');
  require(settings.ENABLE_DEMO_CRUD?.value ===
    'false', 'Demo CRUD must be disabled');
  require(settings.DATABASE_SSL?.value ===
    'true', 'Database TLS must be enabled');
  require(settings.KAFKA_SSL?.value === 'true', 'Kafka TLS must be enabled');
  const pool = Number(settings.DATABASE_POOL_SIZE?.value);
  const maximum = template?.scale?.maxReplicas;
  require(template?.scale?.minReplicas >=
    2, 'At least two always-on replicas are required');
  require(Number.isInteger(maximum) &&
    maximum >= template?.scale?.minReplicas, 'Replica bounds are invalid');
  require(Number.isInteger(pool) &&
    pool > 0 &&
    pool * maximum <=
      100, 'App connection budget must be between 1 and 100 total connections');
  require(app?.properties?.managedEnvironmentId?.toLowerCase() ===
    environment?.id?.toLowerCase(), 'App uses the wrong managed environment');
  require(environment?.properties?.zoneRedundant ===
    true, 'Container Apps environment must be zone redundant');
  require(Boolean(
    environment?.properties?.vnetConfiguration?.infrastructureSubnetId,
  ), 'Container Apps environment must use the production VNet');
  require(database?.properties?.network?.publicNetworkAccess ===
    'Disabled', 'PostgreSQL public access must be disabled');
  require(Boolean(
    database?.properties?.network?.delegatedSubnetResourceId,
  ), 'PostgreSQL must use private VNet integration');
  require(database?.properties?.highAvailability?.mode ===
    'ZoneRedundant', 'PostgreSQL zone-redundant HA is required');
  require(database?.properties?.backup?.backupRetentionDays >=
    35, 'PostgreSQL needs 35-day backup retention');
  require(database?.properties?.backup?.geoRedundantBackup ===
    'Enabled', 'PostgreSQL geo-redundant backup must be enabled');
  require(database?.properties?.storage?.autoGrow ===
    'Enabled', 'PostgreSQL storage auto-growth must be enabled');
  require(broker?.properties?.publicNetworkAccess ===
    'Disabled', 'Event Hubs public access must be disabled');
  require(settings.KAFKA_BROKERS?.value ===
    `${broker?.name}.servicebus.windows.net:9093`, 'Kafka must target the production namespace');
  require(vault?.properties?.enablePurgeProtection ===
    true, 'Key Vault purge protection is required');
  require(vault?.properties?.enableRbacAuthorization ===
    true, 'Key Vault RBAC is required');
  require(registry?.properties?.adminUserEnabled ===
    false, 'Registry admin credentials must be disabled');
  require(registry?.properties?.anonymousPullEnabled ===
    false, 'Anonymous image pulls must be disabled');
  const identities = Object.keys(
    app?.identity?.userAssignedIdentities ?? {},
  ).map((id) => id.toLowerCase());
  require(identities.length >
    0, 'App must have a user-assigned managed identity');
  const registryIdentity = configuration?.registries?.find(
    (item) => item.server === registry?.properties?.loginServer,
  )?.identity;
  require(identities.includes(
    registryIdentity?.toLowerCase(),
  ), 'Image pulls must use the assigned identity');
  for (const name of [
    'DATABASE_URL',
    'KAFKA_SASL_PASSWORD',
    'KBANK_WEBHOOK_TOKEN',
  ]) {
    const setting = settings[name];
    const secret = configuration?.secrets?.find(
      (item) => item.name === setting?.secretRef,
    );
    require(Boolean(setting?.secretRef) &&
      !setting?.value &&
      Boolean(vault?.properties?.vaultUri) &&
      secret?.keyVaultUrl?.startsWith(`${vault.properties.vaultUri}secrets/`) &&
      identities.includes(
        secret?.identity?.toLowerCase(),
      ), `${name} must reference the production vault through managed identity`);
  }
  return errors;
}
