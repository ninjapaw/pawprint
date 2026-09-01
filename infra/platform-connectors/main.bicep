metadata description = 'Subscription-scope desired state for Pawprint-managed Defender for Cloud DevOps connector shells. External provider authorization remains independent and is never reset by this deployment.'

targetScope = 'subscription'

type devOpsConnector = {
  name: string
  resourceGroup: string
  location: string
  environmentName: 'Github' | 'AzureDevOps' | 'GitLab'
  hierarchyIdentifier: string
}

@description('Existing or new DevOps connector shells to converge. Authorization is managed separately in the provider.')
param connectors devOpsConnector[] = []

resource connectorResourceGroups 'Microsoft.Resources/resourceGroups@2025-04-01' existing = [for connector in connectors: {
  name: connector.resourceGroup
}]

module devOpsConnectors '../../modules/defender-devops-connector/main.bicep' = [for (connector, index) in connectors: {
  name: 'defender-devops-${uniqueString(connector.resourceGroup, connector.name)}'
  scope: connectorResourceGroups[index]
  params: {
    name: connector.name
    location: connector.location
    environmentName: connector.environmentName
    hierarchyIdentifier: connector.hierarchyIdentifier
    tags: {
      application: 'pawprint-platform'
      managedBy: 'bicep'
      purpose: 'defender-devops-connector'
    }
  }
}]

output connectorResourceIds string[] = [for (connector, index) in connectors: devOpsConnectors[index].outputs.resourceId]
