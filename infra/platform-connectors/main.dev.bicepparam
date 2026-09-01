using './main.bicep'

param connectors = [
  {
    name: 'ninjapaws-github'
    resourceGroup: 'ninjapaws-github'
    location: 'centralus'
    environmentName: 'Github'
    hierarchyIdentifier: '6895eaa4-9556-42e3-afab-36e79a74ddde'
  }
]
