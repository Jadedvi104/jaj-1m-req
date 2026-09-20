targetScope = 'resourceGroup'
param location string = 'southeastasia'
@allowed(['development', 'staging', 'production'])
param environmentTag string = 'development'
param appName string = 'jaj-api-dev-sea'
param prefix string = 'jaj-dev-sea'
param registryName string = 'jajacrdevsea98a11462'
param vaultName string = 'jaj-kv-dev-sea-98a11462'
@description('Tested image identified by immutable sha256 digest.')
param image string
param kafkaBroker string = 'jaj-eh-dev-sea-98a11462.servicebus.windows.net:9093'
param pipelinePrincipalId string
@description('Keep at least one replica for background timers; production uses at least two.')
@minValue(1)
param minReplicas int = 1
@minValue(1)
param maxReplicas int = 1
@allowed(['0.25', '0.5', '1', '2'])
param cpu string = '0.25'
param memory string = '0.5Gi'
@minValue(1)
@maxValue(100)
param databasePoolSize int = 5
@description('Production starts with environment-only ingress until launch acceptance.')
param externalIngress bool = true

resource environment 'Microsoft.App/managedEnvironments@2026-01-01' existing = { name: '${prefix}-env' }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = { name: '${prefix}-app' }
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = { name: registryName }
resource vault 'Microsoft.KeyVault/vaults@2025-05-01' existing = { name: vaultName }
resource app 'Microsoft.App/containerApps@2026-01-01' = {
  name: appName
  location: location
  tags: { project: 'jaj-1m-req', environment: environmentTag }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: externalIngress, targetPort: 3000, transport: 'auto', allowInsecure: false }
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
        resources: { cpu: json(cpu), memory: memory }
        env: [
          { name: 'PORT', value: '3000' }
          { name: 'NODE_ENV', value: 'production' }
          { name: 'ENABLE_DEMO_CRUD', value: 'false' }
          { name: 'DATABASE_URL', secretRef: 'database-url' }
          { name: 'DATABASE_SSL', value: 'true' }
          { name: 'DATABASE_POOL_SIZE', value: string(databasePoolSize) }
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
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
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
// AcrPush grants image push/pull, not the control-plane registry reads used
// by az acr show/login in the deployment workflow. Keep Reader registry-scoped.
resource registryReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pipelinePrincipalId, 'Reader')
  scope: registry
  properties: {
    principalId: pipelinePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  }
}
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output containerApp string = app.name
