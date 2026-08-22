metadata description = 'Shared user-defined types. Bicep best practice is to avoid open `object` and `array` types on parameters and outputs, because they defeat type checking at exactly the boundaries where mistakes are most expensive.'

@export()
@description('Tag set applied to every resource a run creates. Reaping, cost attribution and uninstall all key off these, so the required keys are typed rather than left to convention.')
type pawprintTags = {
  @description('Marks the resource as created by Pawprint. Only tagged resources are ever reaped or removed.')
  'pawprint.managed': string

  @description('Run identifier, linking the resource back to the pawprint that recorded its creation.')
  'pawprint.runId': string

  @description('Environment name, for example dev or prod.')
  'pawprint.environment': string

  @description('Run start time in ISO 8601.')
  'pawprint.startedAt': string

  @description('Instant after which the run is eligible for reaping.')
  'pawprint.expiresAt': string

  @description('Configured lifetime in hours, retained for reporting.')
  'pawprint.ttlHours': string

  @description('Additional caller-supplied tags.')
  *: string
}

@export()
@description('An endpoint a scenario exposes once deployed.')
type endpoint = {
  @description('Stable name, matching the endpoint declared in scenario.json.')
  name: string

  @description('Fully qualified URL.')
  url: string

  @description('True when reachable from the public internet. Drives blast-radius reporting.')
  public: bool
}

@export()
@description('Application settings passed to a container workload. Values are strings because App Service stores them as strings.')
type appSettings = {
  *: string
}
