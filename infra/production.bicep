targetScope = 'subscription'

param location string = 'southeastasia'
param resourceGroupName string = 'rg-jaj-prod-sea'
param prefix string = 'jaj-prod-sea'
param registryName string
param vaultName string
param postgresName string
param eventHubNamespace string
param alertEmail string
@secure()
param postgresAdminPassword string
@secure()
param applicationDatabasePassword string
@secure()
param webhookAdapterToken string
param postgresSku string = 'Standard_D2s_v3'

resource productionGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: { project: 'jaj-1m-req', environment: 'production' }
}
module foundation 'production-foundation.bicep' = {
  name: 'production-foundation'
  scope: productionGroup
  params: {
    location: location
    prefix: prefix
    registryName: registryName
    vaultName: vaultName
    postgresName: postgresName
    eventHubNamespace: eventHubNamespace
    alertEmail: alertEmail
    postgresAdminPassword: postgresAdminPassword
    applicationDatabasePassword: applicationDatabasePassword
    webhookAdapterToken: webhookAdapterToken
    postgresSku: postgresSku
  }
}
output resourceGroup string = productionGroup.name
output registryServer string = foundation.outputs.registryServer
output environmentName string = foundation.outputs.environmentName
output databaseHost string = foundation.outputs.databaseHost
output kafkaBroker string = foundation.outputs.kafkaBroker
output vaultName string = foundation.outputs.vaultName
