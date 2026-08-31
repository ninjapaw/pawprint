metadata description = 'Subscription-scope organisation baseline. Holds what is genuinely shared and long-lived: one Log Analytics workspace, the tier 0 Key Vault for cross-cutting bootstrap secrets, and optionally the DNS zones. Workload resources never go here; each service keeps its own resource group so its blast radius and its teardown stay its own.'

targetScope = 'subscription'

@description('Resource group holding the shared platform. One per environment, because dev and prod live in different subscriptions.')
@minLength(1)
@maxLength(90)
param resourceGroupName string

@description('Azure region.')
param location string = 'centralus'

@description('Environment name.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Shared Log Analytics workspace name.')
param logAnalyticsName string

@description('Shared Application Insights component name.')
param applicationInsightsName string

@description('Retention for the shared workspace. Longer than a scenario run needs, because this workspace also carries Key Vault audit logs.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 90

@description('Daily ingestion cap in GB. Shared workspaces are the one place an unbounded telemetry bill can appear, so the cap is on by default. -1 disables it.')
param dailyQuotaGb int = 5

@description('Deploy the tier 0 Key Vault. Leave this off until at least one secret genuinely needs to be shared by more than one repository.')
param deployPlatformKeyVault bool = false

@description('Tier 0 Key Vault name.')
@maxLength(24)
param keyVaultName string = ''

@description('Principal IDs granted Key Vault Secrets Officer on the tier 0 vault. This is the rotation role and should be the platform deployment identity only; workloads get per-secret grants instead.')
param keyVaultAdminPrincipalIds string[] = []

@description('Public DNS zones to host in Azure. Leave empty when DNS is hosted elsewhere, which is the current arrangement.')
param dnsZoneNames string[] = []

@description('Additional tags merged over the platform baseline.')
param additionalTags { *: string } = {}

var platformTags = union(
  {
    'platform.managed': 'true'
    'platform.environment': environmentName
    owner: 'ninjapaw'
    managedBy: 'bicep'
  },
  additionalTags
)

resource platformResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: platformTags
}

module monitoring 'org-monitoring.bicep' = {
  scope: platformResourceGroup
  params: {
    location: location
    workspaceName: logAnalyticsName
    applicationInsightsName: applicationInsightsName
    retentionInDays: retentionInDays
    dailyQuotaGb: dailyQuotaGb
    tags: platformTags
  }
}

module platformKeyVault '../modules/key-vault/main.bicep' = if (deployPlatformKeyVault) {
  scope: platformResourceGroup
  params: {
    keyVaultName: keyVaultName
    location: location
    environmentName: environmentName
    application: 'ninjapaws-platform'
    tier: 'platform'
    enablePurgeProtection: true
    secretsOfficerPrincipalIds: keyVaultAdminPrincipalIds
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
    tags: platformTags
  }
}

module dnsZones 'org-dns.bicep' = if (!empty(dnsZoneNames)) {
  scope: platformResourceGroup
  params: {
    zoneNames: dnsZoneNames
    tags: platformTags
  }
}

@description('Platform resource group name.')
output resourceGroupName string = platformResourceGroup.name

@description('Shared Log Analytics workspace resource id. Workload templates take this as a parameter rather than provisioning their own workspace.')
output logAnalyticsWorkspaceId string = monitoring.outputs.workspaceId

@description('Shared Application Insights connection string.')
output applicationInsightsConnectionString string = monitoring.outputs.applicationInsightsConnectionString

@description('Tier 0 Key Vault name, empty when it was not deployed.')
output platformKeyVaultName string = deployPlatformKeyVault ? platformKeyVault!.outputs.keyVaultName : ''

@description('Tier 0 Key Vault URI, empty when it was not deployed.')
output platformKeyVaultUri string = deployPlatformKeyVault ? platformKeyVault!.outputs.keyVaultUri : ''
