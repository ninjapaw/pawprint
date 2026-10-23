metadata description = 'Front Door Premium profile. Kept separate from routing so an origin can restrict inbound traffic to this profile before the route is created.'

import { pawprintTags } from '../types.bicep'

@description('Front Door profile name.')
param profileName string

@description('Front Door is a global service.')
@allowed(['global'])
param location string = 'global'

@description('Pawprint ownership and expiry tags.')
param tags pawprintTags

resource profile 'Microsoft.Cdn/profiles@2025-04-15' = {
  name: profileName
  location: location
  tags: tags
  sku: {
    name: 'Premium_AzureFrontDoor'
  }
  properties: {
    originResponseTimeoutSeconds: 30
  }
}

output resourceId string = profile.id
output frontDoorId string = profile.properties.frontDoorId
