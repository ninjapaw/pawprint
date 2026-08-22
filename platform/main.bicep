metadata description = 'Subscription-scope platform baseline: the run resource group, the Pawprint tag schema including the expiry stamp that makes reaping possible, and shared monitoring. Deploy this first, then deploy the scenario into the resource group it returns.'

targetScope = 'subscription'

@description('Resource group that will hold everything this run creates. One group per run is the blast-radius boundary.')
param resourceGroupName string

@description('Azure region.')
param location string

@description('Environment name, for example dev or prod.')
param environmentName string

@description('Run identifier, recorded in tags so deployed resources can be traced back to their pawprint.')
param runId string

@description('Scenario identifier, empty for a plain deployment.')
param scenarioId string = ''

@description('Hours until the run expires. Reaping is driven by the pawprint.expiresAt tag this computes.')
@minValue(1)
@maxValue(168)
param ttlHours int = 8

@description('Deploy shared monitoring into the resource group.')
param deployMonitoring bool = true

@description('Additional tags merged over the Pawprint schema.')
param additionalTags object = {}

@description('Run start time. Leave at the default; it exists so expiry can be computed at deployment time.')
param runTimestamp string = utcNow()

var expiresAt = dateTimeAdd(runTimestamp, 'PT${ttlHours}H')

// Reapers and cost reports key off these tags, so they are applied to the
// resource group and inherited by every module.
var pawprintTags = union(
  {
    'pawprint.managed': 'true'
    'pawprint.runId': runId
    'pawprint.environment': environmentName
    'pawprint.startedAt': runTimestamp
    'pawprint.expiresAt': expiresAt
    'pawprint.ttlHours': string(ttlHours)
  },
  empty(scenarioId) ? {} : { 'pawprint.scenario': scenarioId },
  additionalTags
)

resource runResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: pawprintTags
}

module monitoring '../modules/monitoring/main.bicep' = if (deployMonitoring) {
  scope: runResourceGroup
  name: 'pawprint-monitoring'
  params: {
    location: location
    workspaceName: 'log-${take(replace(resourceGroupName, '_', '-'), 55)}'
    applicationInsightsName: 'appi-${take(replace(resourceGroupName, '_', '-'), 54)}'
    tags: pawprintTags
  }
}

@description('Resource group the scenario should deploy into.')
output resourceGroupName string = runResourceGroup.name

@description('Resource group resource id.')
output resourceGroupId string = runResourceGroup.id

@description('Tag set the scenario must apply to its own resources.')
output tags object = pawprintTags

@description('Instant at which this run expires and its resources become eligible for reaping.')
output expiresAt string = expiresAt

@description('Log Analytics workspace id, empty when monitoring was not deployed.')
output logAnalyticsWorkspaceId string = deployMonitoring ? monitoring!.outputs.workspaceId : ''
