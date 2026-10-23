using './org.bicep'

param resourceGroupName = 'NP-Platform-Dev-CentralUS'
param location = 'centralus'
param environmentName = 'dev'
param logAnalyticsName = 'log-np-platform-dev-centralus'
param applicationInsightsName = 'appi-np-platform-dev-centralus'
param retentionInDays = 30
param dailyQuotaGb = 2

// Off until a secret is genuinely needed by more than one repository. Until
// then every service keeps its secrets in its own workload vault.
param deployPlatformKeyVault = false
param keyVaultName = 'np-platform-dev-kv'
param keyVaultAdminPrincipalIds = []

// Explicit billable opt-in. Keep off unless a separate development inventory is intended.
param deployEasm = false
param easmWorkspaceName = 'easm-np-platform-dev-centralus'
param easmLocation = 'centralus'
param easmAccessBindings = []
param easmBudget = null
param easmProtectFromDeletion = false

// DNS is hosted externally today; adding zones here would move authority.
param dnsZoneNames = []
