metadata description = 'Defender for Cloud DevOps connector shell. Provider authorization remains an explicit guided step because it requires consent in the external DevOps service.'

targetScope = 'resourceGroup'

@description('Connector resource name.')
param name string

@description('Azure region for the connector metadata.')
param location string = resourceGroup().location

@description('External DevOps provider represented by the connector.')
@allowed([
  'Github'
  'AzureDevOps'
  'GitLab'
])
param environmentName string

@description('Stable provider hierarchy identifier. Generate once and retain it in repository-owned configuration.')
param hierarchyIdentifier string

@description('Additional resource tags.')
param tags object = {}

var providerConfiguration = environmentName == 'Github'
  ? {
      environmentData: {
        environmentType: 'GithubScope'
      }
      offerings: [
        {
          offeringType: 'CspmMonitorGithub'
        }
      ]
    }
  : environmentName == 'AzureDevOps'
    ? {
        environmentData: {
          environmentType: 'AzureDevOpsScope'
        }
        offerings: [
          {
            offeringType: 'CspmMonitorAzureDevOps'
          }
        ]
      }
    : {
        environmentData: {
          environmentType: 'GitlabScope'
        }
        offerings: [
          {
            offeringType: 'CspmMonitorGitLab'
          }
        ]
      }

resource connector 'Microsoft.Security/securityConnectors@2024-08-01-preview' = {
  name: name
  location: location
  tags: union({
    managedBy: 'bicep'
    provider: environmentName
  }, tags)
  properties: union({
    environmentName: environmentName
    hierarchyIdentifier: hierarchyIdentifier
  }, providerConfiguration)
}

output resourceId string = connector.id
output connectorName string = connector.name
output provider string = environmentName
