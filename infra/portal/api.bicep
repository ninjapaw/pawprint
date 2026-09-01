metadata description = 'Azure Functions backend for authenticated Pawprint portal administration.'

targetScope = 'resourceGroup'

@description('Globally unique Function App name.')
param functionAppName string

@description('Azure region for the Function App resources.')
param location string = resourceGroup().location

@description('Deployment environment.')
param environmentName string = 'dev'

@description('Key Vault containing the GitHub App private key.')
param keyVaultName string

@description('GitHub App identifier. Leave blank until a dedicated app is installed.')
param githubAppId string = ''

@description('GitHub App installation identifier. Leave blank until a dedicated app is installed.')
param githubAppInstallationId string = ''

@description('Enable hosted workflow dispatch only after all GitHub App settings and the private key exist.')
param githubAppEnabled bool = false

@description('Existing Application Insights connection string.')
@secure()
param applicationInsightsConnectionString string

@description('Existing Log Analytics workspace resource ID.')
param logAnalyticsWorkspaceId string

@description('Object ID of the GitHub OIDC identity used only for Function code publication.')
param deploymentPrincipalId string

var tags = {
  application: 'pawprint-portal'
  component: 'api'
  environment: environmentName
  managedBy: 'bicep'
  owner: 'ninjapaw'
  'platform.managed': 'true'
}
var storageAccountName = take('st${uniqueString(resourceGroup().id, functionAppName)}', 24)
var deploymentContainerName = 'function-releases'
var githubAppSettings = githubAppEnabled ? [
  {
    name: 'GITHUB_APP_ENABLED'
    value: 'true'
  }
  {
    name: 'GITHUB_APP_ID'
    value: githubAppId
  }
  {
    name: 'GITHUB_APP_INSTALLATION_ID'
    value: githubAppInstallationId
  }
  {
    name: 'GITHUB_APP_PRIVATE_KEY'
    value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=github-app-private-key)'
  }
] : [
  {
    name: 'GITHUB_APP_ENABLED'
    value: 'false'
  }
]

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageAccountName
  location: location
  tags: union(tags, {
    // MCAPS policy otherwise disables the endpoint. Function runtime and One
    // Deploy need this route; data access still requires Entra RBAC because
    // shared keys and anonymous blob access remain disabled.
    SecurityControl: 'Ignore'
  })
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: deploymentContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource flexPlan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: '${functionAppName}-plan'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2025-03-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    clientAffinityEnabled: false
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    serverFarmId: flexPlan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storageAccount.properties.primaryEndpoints.blob}${deploymentContainer.name}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      runtime: {
        name: 'node'
        version: '22'
      }
      scaleAndConcurrency: {
        instanceMemoryMB: 512
        maximumInstanceCount: 40
        alwaysReady: []
      }
    }
    siteConfig: {
      appSettings: concat([
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storageAccount.name
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR'
          value: 'true'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsightsConnectionString
        }
        {
          name: 'PORTAL_ALLOWED_ORIGIN'
          value: 'https://jolly-desert-067886210.3.azurestaticapps.net'
        }
      ], githubAppSettings)
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
    }
  }
}

resource storageBlobDataOwner 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
}

resource storageQueueDataContributor 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
}

resource storageTableDataContributor 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
}

resource blobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, storageBlobDataOwner.id)
  scope: storageAccount
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataOwner.id
  }
}

resource queueRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, storageQueueDataContributor.id)
  scope: storageAccount
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageQueueDataContributor.id
  }
}

resource tableRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, storageTableDataContributor.id)
  scope: storageAccount
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageTableDataContributor.id
  }
}

resource websiteContributor 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'de139f84-1756-47ae-9be6-808fbbe84772'
}

resource deploymentWebsiteRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(functionApp.id, deploymentPrincipalId, websiteContributor.id)
  scope: functionApp
  properties: {
    principalId: deploymentPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: websiteContributor.id
  }
}

// Azure ships no stable diagnostic settings API newer than this preview version.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'pawprint-portal-function-diagnostics'
  scope: functionApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

output functionAppId string = functionApp.id
output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output managedIdentityPrincipalId string = functionApp.identity.principalId
output storageAccountName string = storageAccount.name
