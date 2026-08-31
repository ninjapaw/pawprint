metadata description = 'RBAC-authorised Key Vault with audit logging. Serves both tiers of the secret model: a platform vault holding cross-cutting bootstrap secrets, and a workload vault whose lifetime is tied to the service that owns it.'

targetScope = 'resourceGroup'

@description('Globally unique Key Vault name.')
@minLength(3)
@maxLength(24)
param keyVaultName string

@description('Azure region for the Key Vault.')
param location string = resourceGroup().location

@description('Environment name, for example dev or prod.')
param environmentName string = 'dev'

@description('Application identifier recorded in tags. For the platform vault use the organisation slug rather than a service name.')
param application string

@description('Secret tier this vault serves. Platform vaults hold cross-cutting bootstrap secrets; workload vaults hold the runtime secrets of exactly one service.')
@allowed([
  'platform'
  'workload'
])
param tier string = 'workload'

@description('Key Vault SKU. Use premium only when HSM-backed keys are actually required; it bills per key.')
@allowed([
  'standard'
  'premium'
])
param skuName string = 'standard'

@description('Days a soft-deleted secret remains recoverable. Longer windows also mean the vault name stays reserved for longer after deletion.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 90

@description('Enable purge protection. Azure does not allow this to be turned off once enabled, and it blocks name reuse for the whole soft-delete window, so ephemeral or short-lived workload vaults should leave it off.')
param enablePurgeProtection bool = true

@description('Allow public network access. Disable only once private endpoints and VNet-integrated callers are in place, otherwise deployments lose their own access path.')
param allowPublicNetworkAccess bool = true

@description('Principal IDs granted Key Vault Secrets User across the whole vault. Prefer per-secret grants for anything sharing a platform vault.')
param secretsUserPrincipalIds string[] = []

@description('Principal IDs granted Key Vault Secrets Officer, which is the rotation role. Normally just the deployment identity.')
param secretsOfficerPrincipalIds string[] = []

@description('Log Analytics workspace resource ID that receives audit logs. A vault without audit logging cannot answer who read which secret.')
param logAnalyticsWorkspaceId string = ''

@description('Additional tags merged over the organisation baseline.')
param tags object = {}

var resourceTags = union({
  application: application
  component: 'keyvault'
  environment: environmentName
  owner: 'ninjapaw'
  managedBy: 'bicep'
  'secrets.tier': tier
}, tags)

var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: keyVaultName
  location: location
  tags: resourceTags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: skuName
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: enablePurgeProtection ? true : null
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in secretsUserPrincipalIds: {
    name: guid(keyVault.id, principalId, secretsUserRoleId)
    scope: keyVault
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
    }
  }
]

resource secretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in secretsOfficerPrincipalIds: {
    name: guid(keyVault.id, principalId, secretsOfficerRoleId)
    scope: keyVault
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficerRoleId)
    }
  }
]

// Azure ships no stable diagnosticSettings API newer than 2016-09-01, which
// predates the category list this vault needs.
#disable-next-line use-recent-api-versions
resource auditLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${keyVaultName}-audit'
  scope: keyVault
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'AuditEvent'
        enabled: true
      }
      {
        category: 'AzurePolicyEvaluationDetails'
        enabled: true
      }
    ]
    metrics: []
  }
}

output resourceId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output tier string = tier
