metadata description = 'Durable evidence store for pawprints. Write-once semantics are the point: a time-based immutability policy means a written pawprint cannot be altered or deleted before it expires, which is what separates evidence from a log.'

@description('Azure region.')
param location string = resourceGroup().location

@description('Storage account name. Globally unique, lowercase alphanumeric.')
@minLength(3)
@maxLength(24)
param accountName string

@description('Container holding pawprints.')
param containerName string = 'pawprints'

@description('Tags applied to every resource in this module.')
param tags object = {}

@description('Apply a time-based immutability policy to the container.')
param immutable bool = true

@description('Immutability window in days. Cannot be shortened once the policy is locked, so match it to your audit obligation.')
@minValue(1)
@maxValue(3650)
param retentionDays int = 365

@description('Principal id of the identity that writes pawprints. Granted create and read, deliberately not delete.')
param writerPrincipalId string = ''

@description('Principal id granted read-only access, for auditors and the viewer.')
param readerPrincipalId string = ''

@description('Replication SKU. Zone-redundant is recommended for evidence you intend to rely on.')
param skuName string = 'Standard_ZRS'

// Storage Blob Data Contributor: create and read blobs, but no data-plane delete
// of an immutable blob. The runner must not be able to destroy its own evidence.
var blobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: accountName
  location: location
  tags: union(tags, { component: 'evidence-store' })
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Evidence integrity depends on identity, not on shared keys that can be
    // copied out of a pipeline log.
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
    metadata: {
      purpose: 'pawprint-evidence'
    }
  }
}

// Left unlocked so an operator can correct a misconfigured window. Lock it
// manually once the retention period is confirmed; a locked policy cannot be
// shortened or removed.
resource immutabilityPolicy 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = if (immutable) {
  parent: container
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: retentionDays
    allowProtectedAppendWritesAll: true
  }
}

resource writerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(writerPrincipalId)) {
  scope: storageAccount
  name: guid(storageAccount.id, writerPrincipalId, blobContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
    principalId: writerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(readerPrincipalId)) {
  scope: storageAccount
  name: guid(storageAccount.id, readerPrincipalId, blobReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobReaderRoleId)
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Storage account resource id.')
output accountId string = storageAccount.id

@description('Blob endpoint for the evidence store.')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob

@description('Container pawprints are written to.')
output containerName string = container.name

@description('Whether a time-based immutability policy is applied.')
output immutabilityApplied bool = immutable

@description('Immutability window in days, zero when not applied.')
output retentionDays int = immutable ? retentionDays : 0
