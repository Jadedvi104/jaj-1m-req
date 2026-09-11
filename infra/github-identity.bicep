targetScope = 'resourceGroup'
param location string = 'southeastasia'
param identityName string = 'jaj-github-testing'
param repository string = 'Jadedvi104/jaj-1m-req'
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: { project: 'jaj-1m-req', environment: 'development', purpose: 'github-deployment' }
}
resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = {
  parent: identity
  name: 'github-testing'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${repository}:environment:testing'
    audiences: ['api://AzureADTokenExchange']
  }
}
output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
