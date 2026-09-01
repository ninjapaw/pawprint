metadata description = 'Pawprint deployment portal Static Web App. The hosted build is read-only; authenticated administrative actions remain in the loopback controller.'

targetScope = 'resourceGroup'

@description('Globally unique Static Web App name.')
param siteName string

@description('Azure region used for Static Web App resource metadata.')
param location string = resourceGroup().location

@description('Deployment environment.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Static Web Apps plan. Standard is required for the linked authenticated Functions backend.')
@allowed([
  'Free'
  'Standard'
])
param siteSkuName string = 'Standard'

@description('Function App name for hosted administration.')
param functionAppName string

@description('Key Vault name for the dedicated GitHub App private key.')
param keyVaultName string

@description('Existing shared Log Analytics workspace name.')
param logAnalyticsName string

@description('Existing shared Application Insights resource name.')
param applicationInsightsName string

@description('GitHub App ID. Leave blank until the dedicated app is installed.')
param githubAppId string = ''

@description('GitHub App installation ID. Leave blank until the dedicated app is installed.')
param githubAppInstallationId string = ''

@description('Enable dispatch after the GitHub App key and IDs are configured.')
param githubAppEnabled bool = false

@description('Object ID of the narrow GitHub OIDC identity used for Function code publication.')
param deploymentPrincipalId string

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: logAnalyticsName
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

module portal '../../modules/static-site/main.bicep' = {
  name: 'pawprint-portal'
  params: {
    siteName: siteName
    location: location
    environmentName: environmentName
    application: 'pawprint-portal'
    siteSkuName: siteSkuName
    stagingEnvironmentPolicy: 'Disabled'
    tags: {
      'platform.managed': 'true'
      purpose: 'deployment-status'
    }
  }
}

module api './api.bicep' = {
  name: 'pawprint-portal-api'
  params: {
    functionAppName: functionAppName
    location: location
    environmentName: environmentName
    keyVaultName: keyVaultName
    githubAppId: githubAppId
    githubAppInstallationId: githubAppInstallationId
    githubAppEnabled: githubAppEnabled
    deploymentPrincipalId: deploymentPrincipalId
    applicationInsightsConnectionString: applicationInsights.properties.ConnectionString
    logAnalyticsWorkspaceId: workspace.id
  }
}

module keyVault '../../modules/key-vault/main.bicep' = {
  name: 'pawprint-portal-keyvault'
  params: {
    keyVaultName: keyVaultName
    location: location
    environmentName: environmentName
    application: 'pawprint-portal'
    tier: 'workload'
    enablePurgeProtection: true
    secretsUserPrincipalIds: [api.outputs.managedIdentityPrincipalId]
    logAnalyticsWorkspaceId: workspace.id
    tags: {
      'platform.managed': 'true'
    }
  }
}

resource staticSite 'Microsoft.Web/staticSites@2025-03-01' existing = {
  name: siteName
}

resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2025-03-01' = {
  parent: staticSite
  name: 'production'
  properties: {
    backendResourceId: api.outputs.functionAppId
    region: location
  }
  dependsOn: [portal]
}

output resourceId string = portal.outputs.resourceId
output defaultHostname string = portal.outputs.defaultHostname
output siteUrl string = portal.outputs.siteUrl
output functionAppName string = api.outputs.functionAppName
output functionAppUrl string = api.outputs.functionAppUrl
output keyVaultName string = keyVault.outputs.keyVaultName
