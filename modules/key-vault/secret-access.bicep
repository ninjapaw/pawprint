metadata description = 'Grants a workload identity read access to named secrets in a shared vault, scoped to each secret rather than the vault. This is what makes the platform secret tier safe to share: a compromised workload identity reaches only the secrets it was named for.'

targetScope = 'resourceGroup'

@description('Name of the existing Key Vault holding the secrets.')
param keyVaultName string

@description('Secret names to grant on. Each secret must already exist; secret values are created and rotated out of band, not by this template.')
@minLength(1)
param secretNames string[]

@description('Principal ID of the identity being granted read access.')
param principalId string

@description('Principal type. Use ServicePrincipal for managed identities and app registrations.')
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
])
param principalType string = 'ServicePrincipal'

var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName

  resource secret 'secrets' existing = [
    for secretName in secretNames: {
      name: secretName
    }
  ]
}

resource scopedSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (secretName, index) in secretNames: {
    name: guid(keyVault::secret[index].id, principalId, secretsUserRoleId)
    scope: keyVault::secret[index]
    properties: {
      principalId: principalId
      principalType: principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
    }
  }
]

@description('Key Vault references the consuming service can place directly in its application settings.')
output secretReferences string[] = [
  for secretName in secretNames: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${secretName})'
]
