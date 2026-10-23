metadata description = 'Long-lived shared Defender EASM workspace with optional scoped access, resource-filtered budget alerts, and deletion protection. Discovery configuration uses the separately authenticated EASM data plane.'

targetScope = 'resourceGroup'

@export()
type easmAccessBinding = {
  @minLength(36)
  @maxLength(36)
  principalId: string
  principalType: 'User' | 'Group' | 'ServicePrincipal'
  role: 'Reader' | 'Contributor'
}

@export()
type easmBudgetConfig = {
  @minValue(1)
  monthlyAmount: int
  @minLength(1)
  contactEmails: string[]
  startDate: string
}

@description('Defender EASM workspace name.')
@minLength(1)
param workspaceName string

@description('Approved EASM data-residency region. Verify Microsoft.Easm workspace availability in the target subscription before deploying.')
param location string = resourceGroup().location

@description('Shared platform tags, not ephemeral scenario ownership or expiry tags.')
param tags { *: string }

@description('Optional Reader/Contributor grants scoped only to this workspace. Omission does not revoke existing grants.')
param accessBindings easmAccessBinding[] = []

@description('Optional monthly Cost budget in the subscription billing currency, filtered to this workspace. Alerts are not a spending stop.')
param budgetConfig easmBudgetConfig?

@description('Optional CanNotDelete lock on this workspace. Creating/removing locks needs separately approved authorization permissions.')
param protectFromDeletion bool = false

var roleDefinitionIds = {
  Reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  Contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
}

// EASM currently exposes only preview ARM APIs; this is the latest workspace API.
#disable-next-line use-recent-api-versions
resource workspace 'Microsoft.Easm/workspaces@2023-04-01-preview' = {
  name: workspaceName
  location: location
  tags: union(tags, { component: 'easm' })
  properties: {}
}

resource access 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for binding in accessBindings: {
    name: guid(toLower(workspace.id), toLower(binding.principalId), roleDefinitionIds[binding.role])
    scope: workspace
    properties: {
      principalId: binding.principalId
      principalType: binding.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionIds[binding.role])
      description: 'Pawprint-managed EASM ${binding.role} access.'
    }
  }
]

resource budget 'Microsoft.Consumption/budgets@2026-06-01' = if (budgetConfig != null) {
  name: 'pawprint-easm-monthly'
  properties: {
    amount: budgetConfig!.monthlyAmount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetConfig!.startDate
    }
    filter: {
      dimensions: {
        name: 'ResourceId'
        operator: 'In'
        values: [workspace.id]
      }
    }
    notifications: {
      Actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: budgetConfig!.contactEmails
      }
      Actual100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: budgetConfig!.contactEmails
      }
      Forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: budgetConfig!.contactEmails
      }
    }
  }
}

resource protection 'Microsoft.Authorization/locks@2020-05-01' = if (protectFromDeletion) {
  name: 'pawprint-easm'
  scope: workspace
  properties: {
    level: 'CanNotDelete'
    notes: 'Shared EASM inventory. Review discovery, billing, exports, and dependencies before an authorized operator removes this lock and decommissions the workspace.'
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name

@description('Service-returned endpoint for authenticated EASM data-plane onboarding; not a credential or proof of discovery coverage.')
output dataPlaneEndpoint string = workspace.properties.dataPlaneEndpoint
