using '../platform/main.bicep'

// See main.dev.bicepparam. Production keeps a shorter default lifetime so a
// forgotten run cannot linger, and expects the resolver to supply the rest.

param resourceGroupName = readEnvironmentVariable('PAWPRINT_RESOURCE_GROUP')

param location = readEnvironmentVariable('PAWPRINT_LOCATION', 'centralus')

param environmentName = 'prod'

param runId = readEnvironmentVariable('PAWPRINT_RUN_ID')

param scenarioId = readEnvironmentVariable('PAWPRINT_SCENARIO', '')

param ttlHours = int(readEnvironmentVariable('PAWPRINT_TTL_HOURS', '4'))

param deployMonitoring = true
