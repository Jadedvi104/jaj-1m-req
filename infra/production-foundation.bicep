targetScope = 'resourceGroup'

@description('Dedicated production resource group only; never deploy over development.')
param location string = 'southeastasia'
@minLength(3)
@maxLength(18)
param prefix string = 'jaj-prod-sea'
@description('Globally unique production resource names; no development defaults.')
param registryName string
param vaultName string
param postgresName string
param eventHubNamespace string
@description('Approved operational alert recipient. No default recipient is assumed.')
param alertEmail string
@secure()
@minLength(20)
param postgresAdminPassword string
@secure()
@minLength(20)
param applicationDatabasePassword string
@secure()
@minLength(32)
param webhookAdapterToken string
@description('Capacity must be approved against the monthly budget before deployment.')
param postgresSku string = 'Standard_D2s_v3'
@minValue(32)
param storageGiB int = 128

var tags = { project: 'jaj-1m-req', environment: 'production' }
var pullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var secretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${prefix}-app'
  location: location
  tags: tags
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    // GitHub-hosted runners push with short-lived OIDC credentials.
    publicNetworkAccess: 'Enabled'
  }
}
resource imagePull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: pullRole
  }
}
resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.52.0.0/16'] }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.52.0.0/23'
          delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.52.2.0/24'
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.52.3.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}
resource databaseDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${prefix}.postgres.database.azure.com'
  location: 'global'
  tags: tags
}
resource databaseDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: databaseDns
  name: '${prefix}-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: postgresName
  location: location
  tags: tags
  sku: { name: postgresSku, tier: 'GeneralPurpose' }
  properties: {
    version: '17'
    createMode: 'Default'
    administratorLogin: 'jajadmin'
    administratorLoginPassword: postgresAdminPassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: storageGiB, type: 'Premium_LRS', autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 35, geoRedundantBackup: 'Enabled' }
    highAvailability: { mode: 'ZoneRedundant' }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: '${network.id}/subnets/postgres'
      privateDnsZoneArmResourceId: databaseDns.id
    }
  }
  dependsOn: [databaseDnsLink]
}
resource applicationDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: postgres
  name: 'restaurant'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: { value: 'pgcrypto', source: 'user-override' }
}
resource eventHub 'Microsoft.EventHub/namespaces@2026-01-01' = {
  name: eventHubNamespace
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Standard', capacity: 1 }
  properties: {
    kafkaEnabled: true
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    isAutoInflateEnabled: true
    maximumThroughputUnits: 4
    // The existing Kafka client uses SASL; only the topic Send key goes to the app.
    disableLocalAuth: false
  }
}
resource ordersTopic 'Microsoft.EventHub/namespaces/eventhubs@2026-01-01' = {
  parent: eventHub
  name: 'orders.v1'
  properties: {
    partitionCount: 12
    retentionDescription: { cleanupPolicy: 'Delete', retentionTimeInHours: 168 }
    status: 'Active'
  }
}
resource sendPolicy 'Microsoft.EventHub/namespaces/eventhubs/authorizationRules@2026-01-01' = {
  parent: ordersTopic
  name: 'orders-producer'
  properties: { rights: ['Send'] }
}
resource brokerDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.servicebus.windows.net'
  location: 'global'
  tags: tags
}
resource brokerDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: brokerDns
  name: '${prefix}-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}
resource brokerEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-eventhub'
  location: location
  tags: tags
  properties: {
    subnet: { id: '${network.id}/subnets/private-endpoints' }
    privateLinkServiceConnections: [{
      name: 'eventhub'
      properties: { privateLinkServiceId: eventHub.id, groupIds: ['namespace'] }
    }]
  }
}
resource brokerDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: brokerEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'eventhub', properties: { privateDnsZoneId: brokerDns.id } }] }
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
    accessPolicies: []
  }
}
// URL-encode credentials, keep them out of outputs, logs, and GitHub variables.
resource dbSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'database-url'
  properties: { value: 'postgresql://jaj_app:${uriComponent(applicationDatabasePassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/restaurant' }
}
resource kafkaSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'kafka-password'
  properties: { value: sendPolicy.listKeys().primaryConnectionString }
}
resource webhookSecret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' = {
  parent: vault
  name: 'webhook-token'
  properties: { value: webhookAdapterToken }
}
// The runtime identity can read only runtime secrets, never administrative credentials.
resource databaseSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dbSecret.id, appIdentity.id, 'SecretsUser')
  scope: dbSecret
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: secretsUserRole }
}
resource kafkaSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kafkaSecret.id, appIdentity.id, 'SecretsUser')
  scope: kafkaSecret
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: secretsUserRole }
}
resource webhookSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(webhookSecret.id, appIdentity.id, 'SecretsUser')
  scope: webhookSecret
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: secretsUserRole }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}
resource environment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    zoneRedundant: true
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: { infrastructureSubnetId: '${network.id}/subnets/container-apps', internal: false }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}
resource alerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'jaj-prod'
    enabled: true
    emailReceivers: [{ name: 'operations', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}
resource databaseAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for metric in [
  { name: 'cpu_percent', threshold: 80 }
  { name: 'storage_percent', threshold: 80 }
  { name: 'memory_percent', threshold: 90 }
]: {
  name: '${prefix}-${metric.name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Production PostgreSQL ${metric.name} needs attention.'
    severity: 2
    enabled: true
    scopes: [postgres.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{
        name: metric.name
        metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
        metricName: metric.name
        operator: 'GreaterThan'
        threshold: metric.threshold
        timeAggregation: 'Average'
        criterionType: 'StaticThresholdCriterion'
      }]
    }
    actions: [{ actionGroupId: alerts.id }]
  }
}]

output registryServer string = registry.properties.loginServer
output environmentName string = environment.name
output appIdentityName string = appIdentity.name
output databaseHost string = postgres.properties.fullyQualifiedDomainName
output kafkaBroker string = '${eventHub.name}.servicebus.windows.net:9093'
output vaultName string = vault.name
output actionGroupId string = alerts.id
output logWorkspaceId string = logs.id
