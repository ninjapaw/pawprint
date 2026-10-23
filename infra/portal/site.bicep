metadata description = 'Existing PawPrint static site, with optional SWA-only workforce federation identity.'

param siteName string
param location string
param environmentName string
param siteSkuName string
param authIdentityResourceIds array = []

module site 'br/public:avm/res/web/static-site:0.9.5' = {
  name: 'static-site-${uniqueString(resourceGroup().id, siteName)}'
  params: {
    name: siteName
    location: location
    allowConfigFileUpdates: true
    enableTelemetry: false
    sku: siteSkuName
    stagingEnvironmentPolicy: 'Disabled'
    managedIdentities: empty(authIdentityResourceIds) ? null : {
      userAssignedResourceIds: authIdentityResourceIds
    }
    tags: {
      application: 'pawprint-portal'
      component: 'web'
      environment: environmentName
      owner: 'ninjapaw'
      managedBy: 'bicep'
      'azd-service-name': 'web'
      'platform.managed': 'true'
      purpose: 'deployment-status'
    }
  }
}

output resourceId string = site.outputs.resourceId
output defaultHostname string = site.outputs.defaultHostname
output siteUrl string = 'https://${site.outputs.defaultHostname}'
