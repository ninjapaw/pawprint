using '../platform/main.bicep'

// Values come from the resolver so configuration has exactly one source of truth:
//   node scripts/pawprint-config.mjs --environment dev --github-env
// Bicep reads them at build time via readEnvironmentVariable, which keeps run
// identifiers out of source control while leaving the file reviewable.

param resourceGroupName = readEnvironmentVariable('PAWPRINT_RESOURCE_GROUP')

param location = readEnvironmentVariable('PAWPRINT_LOCATION', 'centralus')

param environmentName = 'dev'

param runId = readEnvironmentVariable('PAWPRINT_RUN_ID')

param scenarioId = readEnvironmentVariable('PAWPRINT_SCENARIO', '')

param ttlHours = int(readEnvironmentVariable('PAWPRINT_TTL_HOURS', '8'))

param deployMonitoring = true
