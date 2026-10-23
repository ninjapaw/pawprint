metadata description = 'Optional metadata Reader grant on an explicitly approved resource group, never a subscription.'
targetScope = 'resourceGroup'

param principalId string
param assignmentSeed string

resource reader 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
}

resource assignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, assignmentSeed, reader.id, 'pawprint-observations')
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: reader.id
  }
}
