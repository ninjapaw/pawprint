using './org.bicep'

param resourceGroupName = 'NP-Platform-CentralUS'
param location = 'centralus'
param environmentName = 'prod'
param logAnalyticsName = 'log-np-platform-centralus'
param applicationInsightsName = 'appi-np-platform-centralus'
param retentionInDays = 90
param dailyQuotaGb = 5

// Off until a secret is genuinely needed by more than one repository. Until
// then every service keeps its secrets in its own workload vault.
param deployPlatformKeyVault = false
param keyVaultName = 'np-platform-kv'
param keyVaultAdminPrincipalIds = []

// DNS is hosted externally today; adding zones here would move authority.
param dnsZoneNames = []
