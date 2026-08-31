metadata description = 'Azure Static Web App with an optional DNS-validated custom domain. Wraps the Azure Verified Module so every site in the organisation gets the same TLS, staging and tagging posture without each repository restating it.'

targetScope = 'resourceGroup'

@description('Globally unique Static Web App name.')
@minLength(2)
@maxLength(40)
param siteName string

@description('Azure region for the Static Web App resource metadata. Static Web Apps serve from a global edge regardless of this value.')
param location string = resourceGroup().location

@description('Environment name, for example dev or prod.')
param environmentName string = 'dev'

@description('Application identifier recorded in tags, for example ninjapaws-hq.')
param application string

@description('Static Web Apps plan. Free is correct until a Standard-only feature is actually required; Standard bills per app per month.')
@allowed([
  'Free'
  'Standard'
])
param siteSkuName string = 'Free'

@description('DNS-validated custom domain, for example dev.example.com. Leave blank until the TXT record exists at the DNS provider, otherwise the deployment blocks on validation.')
param customDomainName string = ''

@description('Allow the site to serve an updated staticwebapp.config.json from the deployed artefact.')
param allowConfigFileUpdates bool = true

@description('Whether pull request builds get their own staging environment.')
@allowed([
  'Enabled'
  'Disabled'
])
param stagingEnvironmentPolicy string = 'Enabled'

@description('Additional tags merged over the organisation baseline.')
param tags object = {}

var resourceTags = union({
  application: application
  component: 'web'
  environment: environmentName
  owner: 'ninjapaw'
  managedBy: 'bicep'
  'azd-service-name': 'web'
}, tags)

module staticSite 'br/public:avm/res/web/static-site:0.9.5' = {
  name: 'static-site-${uniqueString(resourceGroup().id, siteName)}'
  params: {
    name: siteName
    location: location
    allowConfigFileUpdates: allowConfigFileUpdates
    enableTelemetry: false
    sku: siteSkuName
    stagingEnvironmentPolicy: stagingEnvironmentPolicy
    tags: resourceTags
  }
}

resource site 'Microsoft.Web/staticSites@2025-03-01' existing = {
  name: siteName
}

resource customDomain 'Microsoft.Web/staticSites/customDomains@2025-03-01' = if (!empty(customDomainName)) {
  parent: site
  name: customDomainName
  properties: {
    validationMethod: 'dns-txt-token'
  }
  dependsOn: [
    staticSite
  ]
}

output resourceId string = staticSite.outputs.resourceId
output defaultHostname string = staticSite.outputs.defaultHostname
output defaultUrl string = 'https://${staticSite.outputs.defaultHostname}'
output siteUrl string = empty(customDomainName) ? 'https://${staticSite.outputs.defaultHostname}' : 'https://${customDomainName}'
output customDomainResourceId string = empty(customDomainName) ? '' : customDomain.id
