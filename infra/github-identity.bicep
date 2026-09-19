targetScope = 'resourceGroup'
param location string = 'southeastasia'
param identityName string = 'jaj-github-testing'
@allowed(['testing', 'staging', 'production'])
param githubEnvironment string = 'testing'
@description('GitHub repository owner login. Preserve the exact case emitted in OIDC claims.')
param repositoryOwner string = 'Jadedvi104'
@description('Immutable GitHub repository owner numeric ID.')
param repositoryOwnerId string = '29722893'
param repositoryName string = 'jaj-1m-req'
@description('Immutable GitHub repository numeric ID.')
param repositoryId string = '1348208947'

var immutableRepository = '${repositoryOwner}@${repositoryOwnerId}/${repositoryName}@${repositoryId}'
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: { project: 'jaj-1m-req', environment: githubEnvironment, purpose: 'github-deployment' }
}
resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = {
  parent: identity
  name: 'github-${githubEnvironment}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${immutableRepository}:environment:${githubEnvironment}'
    audiences: ['api://AzureADTokenExchange']
  }
}
output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
output subject string = federation.properties.subject
