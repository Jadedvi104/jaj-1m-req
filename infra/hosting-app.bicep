targetScope = 'resourceGroup'
param location string = 'southeastasia'
param appName string = 'jaj-api-dev-sea'
param prefix string = 'jaj-dev-sea'
param registryName string = 'jajacrdevsea98a11462'
param vaultName string = 'jaj-kv-dev-sea-98a11462'
@description('Tested image identified by immutable sha256 digest.')
param image string
param kafkaBroker string = 'jaj-eh-dev-sea-98a11462.servicebus.windows.net:9093'
param pipelinePrincipalId string

resource environment 'Microsoft.App/managedEnvironments@2026-01-01' existing = { name: '${prefix}-env' }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = { name: '${prefix}-app' }
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = { name: registryName }
resource vault 'Microsoft.KeyVault/vaults@2025-05-01' existing = { name: vaultName }
resource app 'Microsoft.App/containerApps@2026-01-01' = {
  name: appName
  location: location
  tags: { project: 'jaj-1m-req', environment: 'development' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 3000, transport: 'auto', allowInsecure: false }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: [for name in ['database-url', 'kafka-password', 'webhook-token']: {
        name: name
        keyVaultUrl: '${vault.properties.vaultUri}secrets/${name}'
        identity: identity.id
      }]
    }
    template: {
      containers: [{
        name: 'api'
        image: image
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'PORT', value: '3000' }
          { name: 'NODE_ENV', value: 'production' }
          { name: 'ENABLE_DEMO_CRUD', value: 'false' }
          { name: 'DATABASE_URL', secretRef: 'database-url' }
          { name: 'DATABASE_SSL', value: 'true' }
          { name: 'DATABASE_POOL_SIZE', value: '5' }
          { name: 'KBANK_WEBHOOK_TOKEN', secretRef: 'webhook-token' }
          { name: 'KAFKA_BROKERS', value: kafkaBroker }
          { name: 'KAFKA_SSL', value: 'true' }
          { name: 'KAFKA_SASL_USERNAME', value: '$ConnectionString' }
          { name: 'KAFKA_SASL_PASSWORD', secretRef: 'kafka-password' }
          { name: 'KAFKA_ORDER_TOPIC', value: 'orders.v1' }
        ]
        probes: [
          { type: 'Startup', httpGet: { path: '/api/health/live', port: 3000, scheme: 'HTTP' }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 }
          { type: 'Liveness', httpGet: { path: '/api/health/live', port: 3000, scheme: 'HTTP' }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
          { type: 'Readiness', httpGet: { path: '/api/health/ready', port: 3000, scheme: 'HTTP' }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 }
        ]
      }]
      // Timers publish Kafka events and expire reservations without HTTP traffic.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
resource deployRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(app.id, pipelinePrincipalId, 'ContainerAppsContributor')
  scope: app
  properties: {
    principalId: pipelinePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '358470bc-b998-42bd-ab17-a7e34c199c0f')
  }
}
resource pushRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pipelinePrincipalId, 'AcrPush')
  scope: registry
  properties: {
    principalId: pipelinePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
  }
}
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output containerApp string = app.name
