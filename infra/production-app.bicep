targetScope = 'resourceGroup'
param location string = 'southeastasia'
param prefix string = 'jaj-prod-sea'
param appName string = 'jaj-api-prod-sea'
param registryName string
param vaultName string
param kafkaBroker string
@description('Exact image verified by CI, published to the production registry by digest.')
param image string
param pipelinePrincipalId string
@description('Keep false until payment, rate-limit, schema, restore, and application acceptance have passed.')
param externalIngress bool = false
@minValue(2)
@maxValue(10)
param maxReplicas int = 4

// Read-only configuration checks include production dependencies. Secret values
// remain protected by data-plane RBAC; the pipeline has no Key Vault secret role.
resource productionReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, pipelinePrincipalId, 'ProductionPreflightReader')
  properties: {
    principalId: pipelinePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  }
}

module app 'hosting-app.bicep' = {
  name: 'production-api'
  params: {
    location: location
    environmentTag: 'production'
    appName: appName
    prefix: prefix
    registryName: registryName
    vaultName: vaultName
    kafkaBroker: kafkaBroker
    image: image
    pipelinePrincipalId: pipelinePrincipalId
    cpu: '0.5'
    memory: '1Gi'
    minReplicas: 2
    maxReplicas: maxReplicas
    databasePoolSize: 10
    externalIngress: externalIngress
  }
}
output url string = app.outputs.url
output containerApp string = app.outputs.containerApp
