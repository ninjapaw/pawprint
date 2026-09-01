metadata description = 'Resource naming convention for the organisation. Naming is a contract: reaping, cost attribution and RBAC scoping all key off it, so it belongs in one place rather than in each repository\'s deployment config.'

targetScope = 'resourceGroup'

@description('Short project identifier in PascalCase, for example SentinelOptimizer. Used for the human-facing resource group name.')
@minLength(2)
@maxLength(24)
param projectName string

@description('Lower-case project slug, for example sentineloptimizer. Used for resource names that Azure requires to be lower case.')
@minLength(2)
@maxLength(24)
param projectSlug string

@description('Environment name.')
@allowed([
  'dev'
  'prod'
  'qa'
  'test'
])
param environmentName string

@description('Region token appended to names, for example CentralUS. This is presentation only; the deployment region comes from the location parameter of the resource being created.')
@minLength(2)
@maxLength(20)
param regionToken string = 'CentralUS'

@description('Organisation prefix.')
@minLength(1)
@maxLength(6)
param organisationPrefix string = 'NP'

// Production historically omits its environment token, so the convention keeps
// that shape rather than forcing a rename of resources that already exist.
var environmentSegment = environmentName == 'prod' ? '' : '${toUpper(substring(environmentName, 0, 1))}${substring(environmentName, 1)}-'
var environmentSlug = environmentName == 'prod' ? '' : '${environmentName}-'

var regionSlug = toLower(regionToken)
var prefixSlug = toLower(organisationPrefix)

output resourceGroupName string = '${organisationPrefix}-${projectName}-${environmentSegment}${regionToken}'
output staticWebAppName string = '${prefixSlug}-${projectSlug}-${environmentSlug}${regionSlug}'
output functionAppName string = '${prefixSlug}-${projectSlug}-api-${environmentSlug}${regionSlug}'
output appServiceName string = '${prefixSlug}-${projectSlug}-app-${environmentSlug}${regionSlug}'
output appServicePlanName string = '${prefixSlug}-${projectSlug}-plan-${environmentSlug}${regionSlug}'
output logAnalyticsName string = 'log-${prefixSlug}-${projectSlug}-${environmentSlug}${regionSlug}'
output applicationInsightsName string = 'appi-${prefixSlug}-${projectSlug}-${environmentSlug}${regionSlug}'
output managedIdentityName string = 'id-${prefixSlug}-${projectSlug}-${environmentSlug}${regionSlug}'

@description('Container registry name. Azure permits alphanumerics only, so separators are stripped rather than replaced.')
output containerRegistryName string = take(replace('${prefixSlug}${projectSlug}${environmentName}', '-', ''), 50)

@description('Key Vault name. Capped at 24 characters, which is the Azure limit and is shorter than most project slugs allow for.')
output keyVaultName string = take('${prefixSlug}-${projectSlug}-${environmentName}-kv', 24)

@description('Storage account name. Lower-case alphanumerics only, capped at 24 characters: 11 of project prefix plus the 13-character uniqueString salt that keeps the global namespace collision-free.')
output storageAccountName string = '${take(replace('${prefixSlug}${projectSlug}${environmentName}', '-', ''), 11)}${uniqueString(resourceGroup().id, projectSlug, environmentName)}'
