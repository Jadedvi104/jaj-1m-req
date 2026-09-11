targetScope = 'resourceGroup'

@description('Small development hosting; no production capacity assumptions.')
param location string = 'southeastasia'
param prefix string = 'jaj-dev-sea'
param registryName string = 'jajacrdevsea98a11462'
param vaultName string = 'jaj-kv-dev-sea-98a11462'
@secure()
param databaseUrl string
@secure()
param kafkaPassword string
@secure()
param webhookToken string

var tags = { project: 'jaj-1m-req', environment: 'development' }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${prefix}-app'
  location: location
  tags: tags
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    // Secret reads require Entra RBAC. No credentials appear in outputs.
    accessPolicies: []
  }
}
resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, 'SecretsUser')
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}
resource dbSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'database-url'
  properties: { value: databaseUrl }
}
resource kafkaSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'kafka-password'
  properties: { value: kafkaPassword }
}
resource webhookSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'webhook-token'
  properties: { value: webhookToken }
}
resource outboundIp 'Microsoft.Network/publicIPAddresses@2026-03-01' = {
  name: '${prefix}-egress'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}
resource nat 'Microsoft.Network/natGateways@2026-03-01' = {
  name: '${prefix}-nat'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [{ id: outboundIp.id }]
  }
}
resource network 'Microsoft.Network/virtualNetworks@2026-03-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [{
      name: 'container-apps'
      properties: {
        addressPrefix: '10.42.0.0/27'
        natGateway: { id: nat.id }
        delegations: [{
          name: 'container-apps'
          properties: { serviceName: 'Microsoft.App/environments' }
        }]
      }
    }]
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}
resource environment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    zoneRedundant: false
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: {
      infrastructureSubnetId: '${network.id}/subnets/container-apps'
      internal: false
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}
output registry string = registry.name
output registryServer string = registry.properties.loginServer
output environmentName string = environment.name
output identityName string = identity.name
output vault string = vault.name
output outboundAddress string = outboundIp.properties.ipAddress
