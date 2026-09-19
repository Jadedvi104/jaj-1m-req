targetScope = 'resourceGroup'

@description('Deploy only into the dedicated staging resource group.')
param location string = 'southeastasia'
@description('Dedicated staging names; globally unique registry and vault names are required.')
param prefix string
param appName string
param registryName string
param vaultName string
@description('Staging Event Hubs Kafka endpoint, including :9093.')
param kafkaBroker string
@description('CI-verified immutable image digest accessible from the staging registry.')
param image string
@description('Principal ID of the separate GitHub staging deployment identity.')
param pipelinePrincipalId string
@secure()
param databaseUrl string
@secure()
param kafkaPassword string
@secure()
param webhookToken string

// First provision the foundation directly, allowlist its NAT address, seed the
// registry with the tested image, and apply migrations. This wrapper then
// reconciles the foundation and provisions the app; it does not migrate data.
module foundation 'hosting.bicep' = {
  name: 'staging-foundation'
  params: {
    location: location
    environmentTag: 'staging'
    prefix: prefix
    registryName: registryName
    vaultName: vaultName
    databaseUrl: databaseUrl
    kafkaPassword: kafkaPassword
    webhookToken: webhookToken
  }
}
module api 'hosting-app.bicep' = {
  name: 'staging-api'
  params: {
    location: location
    environmentTag: 'staging'
    appName: appName
    prefix: prefix
    registryName: registryName
    vaultName: vaultName
    kafkaBroker: kafkaBroker
    image: image
    pipelinePrincipalId: pipelinePrincipalId
  }
  dependsOn: [foundation]
}
output url string = api.outputs.url
output outboundAddress string = foundation.outputs.outboundAddress
