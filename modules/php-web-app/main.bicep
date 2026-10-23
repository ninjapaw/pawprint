metadata description = 'Linux PHP App Service with a system-assigned identity, HTTPS, disabled basic publishing, diagnostics, and a fail-closed Front Door service-tag plus profile-header origin restriction. No runtime roles or secrets are created.'

import { pawprintTags } from '../types.bicep'

@description('Globally unique application name.')
param appName string

@description('App Service plan name.')
param planName string

@description('Supported App Service region.')
param location string

@description('Front Door profile GUID; not its Azure resource ID.')
@minLength(36)
@maxLength(36)
param frontDoorId string

@description('Workspace receiving application and HTTP logs.')
param workspaceId string

@description('Supported PHP stack, checked by the consuming lifecycle preflight.')
@allowed(['8.4', '8.5'])
param phpVersion string = '8.4'

@description('Application settings. Never pass literal secrets; use Key Vault references if secrets are introduced.')
param appSettings { name: string, value: string }[] = []

@description('Pawprint ownership and expiry tags.')
param tags pawprintTags

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

resource app 'Microsoft.Web/sites@2025-03-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'PHP|${phpVersion}'
      alwaysOn: true
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      healthCheckPath: '/health.php'
      appSettings: appSettings
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: [
        {
          name: 'ThisFrontDoorOnly'
          ipAddress: 'AzureFrontDoor.Backend'
          tag: 'ServiceTag'
          action: 'Allow'
          priority: 100
          headers: {
            'x-azure-fdid': [frontDoorId]
          }
        }
      ]
      // The publishing endpoint remains Entra-authenticated, not a second public app route.
      scmIpSecurityRestrictionsUseMain: false
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
    }
  }
}

resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}

resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: app
  name: 'scm'
  properties: { allow: false }
}

resource logs 'Microsoft.Web/sites/config@2025-03-01' = {
  parent: app
  name: 'logs'
  properties: {
    applicationLogs: {
      fileSystem: { level: 'Information' }
    }
    httpLogs: {
      fileSystem: {
        enabled: true
        retentionInDays: 1
        retentionInMb: 25
      }
    }
    detailedErrorMessages: { enabled: false }
    failedRequestsTracing: { enabled: false }
  }
}

// Dedicated resource-specific tables require the newer diagnostic schema.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'pawprint-evidence'
  scope: app
  properties: {
    workspaceId: workspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output resourceId string = app.id
output hostName string = app.properties.defaultHostName
output principalId string = app.identity.principalId
