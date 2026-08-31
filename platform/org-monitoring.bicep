metadata description = 'Long-lived shared monitoring for the platform resource group. Deliberately separate from modules/monitoring, which is tagged and tuned for ephemeral scenario runs and caps retention accordingly.'

targetScope = 'resourceGroup'

@description('Azure region.')
param location string = resourceGroup().location

@description('Log Analytics workspace name.')
param workspaceName string

@description('Application Insights component name.')
param applicationInsightsName string

@description('Retention in days.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 90

@description('Daily ingestion cap in GB. -1 disables the cap.')
param dailyQuotaGb int = 5

@description('Tags applied to both resources.')
param tags { *: string }

var moduleTags = union(tags, { component: 'monitoring' })

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  tags: moduleTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  tags: moduleTags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output applicationInsightsId string = applicationInsights.id
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
