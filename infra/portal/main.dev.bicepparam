using './main.bicep'

param siteName = 'np-pawprint-dev-centralus'
param location = 'centralus'
param environmentName = 'dev'
param siteSkuName = 'Standard'
param functionAppName = 'np-pawprint-api-dev-centralus'
param keyVaultName = 'np-pawprint-dev-kv'
param logAnalyticsName = 'log-np-platform-dev-centralus'
param applicationInsightsName = 'appi-np-platform-dev-centralus'
param deploymentPrincipalId = 'ac820ea5-9dea-4dc1-b842-f6aacdfda6fb'
param githubAppEnabled = false
