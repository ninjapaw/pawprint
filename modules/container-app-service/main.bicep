metadata description = 'Linux container on App Service, pulling from a registry with a user-assigned managed identity. Generalised from the Cloud Security Dojo scenario: the Azure Container Registry is optional so scenarios can pull public images from GHCR instead, and application settings are supplied by the caller rather than hardcoded.'

@description('Azure region.')
param location string = resourceGroup().location

@description('App Service name. Also seeds the plan and identity names.')
param appServiceName string

@description('App Service Plan name.')
param appServicePlanName string = '${appServiceName}-plan'

@description('App Service Plan SKU. B1 is the cheapest tier supporting alwaysOn.')
param appServicePlanSku string = 'B1'

@description('Tags applied to every resource in this module.')
param tags object = {}

@description('Provision an Azure Container Registry. Set false to pull from a public registry such as GHCR, which avoids the registry cost and provisioning time.')
param deployContainerRegistry bool = true

@description('Container registry name. Hyphens are stripped because ACR names are alphanumeric only.')
param containerRegistryName string = ''

@description('Fully qualified image reference when deployContainerRegistry is false, for example ghcr.io/owner/image:tag.')
param externalImageReference string = ''

@description('Image repository name, used when deployContainerRegistry is true.')
param imageName string = ''

@description('Image tag, used when deployContainerRegistry is true. Prefer an immutable tag or digest over latest.')
param imageTag string = 'latest'

@description('Port the container listens on.')
param containerPort int = 80

@description('Path probed for container health.')
param healthCheckPath string = '/health'

@description('Application settings supplied by the caller. Scenario-specific values belong in the scenario manifest, never hardcoded here.')
param appSettings object = {}

var registryName = replace(containerRegistryName, '-', '')
var identityName = '${appServiceName}-identity'
// Built-in AcrPull role definition.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

var baseAppSettings = {
  WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'false'
  WEBSITES_PORT: string(containerPort)
}

// Only start-time-known values may drive a for-expression, so caller settings
// are projected here and runtime-resolved registry settings are appended after.
var declaredAppSettings = [
  for setting in items(union(baseAppSettings, appSettings)): {
    name: setting.key
    value: string(setting.value)
  }
]

var registryAppSettings = deployContainerRegistry
  ? [
      {
        name: 'DOCKER_REGISTRY_SERVER_URL'
        value: 'https://${containerRegistry!.properties.loginServer}'
      }
    ]
  : []

var imageReference = deployContainerRegistry
  ? '${containerRegistry!.properties.loginServer}/${imageName}:${imageTag}'
  : externalImageReference

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = if (deployContainerRegistry) {
  name: registryName
  location: location
  tags: union(tags, { component: 'registry' })
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
  }
}

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: union(tags, { component: 'identity' })
}

// Scoped to the registry, not the resource group, so the identity can pull
// images and nothing more.
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployContainerRegistry) {
  scope: containerRegistry
  name: guid(containerRegistry.id, managedIdentity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  tags: union(tags, { component: 'plan' })
  kind: 'linux'
  sku: {
    name: appServicePlanSku
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

resource appService 'Microsoft.Web/sites@2023-01-01' = {
  name: appServiceName
  location: location
  tags: union(tags, { component: 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${imageReference}'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: healthCheckPath
      acrUseManagedIdentityCreds: deployContainerRegistry
      acrUserManagedIdentityID: deployContainerRegistry ? managedIdentity.properties.clientId : null
      appSettings: concat(declaredAppSettings, registryAppSettings)
    }
  }
  dependsOn: [
    acrPull
  ]
}

@description('Public HTTPS endpoint.')
output appServiceUrl string = 'https://${appService.properties.defaultHostName}'

@description('App Service resource id.')
output appServiceId string = appService.id

@description('App Service name.')
output appServiceName string = appService.name

@description('Registry login server, empty when no registry was provisioned.')
output containerRegistryLoginServer string = deployContainerRegistry ? containerRegistry!.properties.loginServer : ''

@description('Registry resource id, empty when no registry was provisioned.')
output containerRegistryId string = deployContainerRegistry ? containerRegistry!.id : ''

@description('User-assigned managed identity resource id.')
output managedIdentityId string = managedIdentity.id

@description('User-assigned managed identity principal id.')
output managedIdentityPrincipalId string = managedIdentity.properties.principalId

@description('Image reference the site is configured to run.')
output imageReference string = imageReference
