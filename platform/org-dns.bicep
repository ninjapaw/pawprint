metadata description = 'Public DNS zones hosted in Azure. Optional: the organisation currently hosts DNS externally, so this exists for the case where custom-domain validation is moved in-house and needs to be automated alongside the sites that consume it.'

targetScope = 'resourceGroup'

@description('Zone names to host, for example ninjapaws.org.')
@minLength(1)
param zoneNames string[]

@description('Tags applied to every zone.')
param tags { *: string }

// Azure DNS has shipped no stable API newer than 2018-05-01.
#disable-next-line use-recent-api-versions
resource zone 'Microsoft.Network/dnsZones@2018-05-01' = [
  for zoneName in zoneNames: {
    name: zoneName
    location: 'global'
    tags: union(tags, { component: 'dns' })
    properties: {
      zoneType: 'Public'
    }
  }
]

@description('Name servers to delegate to at the registrar, one entry per zone.')
output delegations object[] = [
  for (zoneName, index) in zoneNames: {
    zoneName: zoneName
    nameServers: zone[index].properties.nameServers
  }
]
