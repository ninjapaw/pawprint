import { Resolver } from "node:dns/promises";
import { armJson, SourceError } from "./azure.js";
import { cached } from "./cache.js";
import { workflowObservation } from "./github.js";
import { isRecord, parseResourceId, runtimeSources, serviceCatalog, type Environment, type ServiceDefinition, type SourceBinding } from "./runtime.js";

export interface Observation {
  state: string;
  source: string;
  observedAt: string | null;
  message: string;
}
const observation = (state: string, source: string, message: string, observedAt: string | null = null): Observation =>
  ({ state, source, message, observedAt });
const readCached = cached<Observation>(60000);
const resourceVersions: Readonly<Record<string, string>> = {
  "microsoft.easm/workspaces": "2023-04-01-preview",
  "microsoft.operationalinsights/workspaces": "2025-02-01",
  "microsoft.insights/components": "2020-02-02",
  "microsoft.keyvault/vaults": "2025-05-01",
  "microsoft.web/staticsites": "2025-03-01",
  "microsoft.web/sites": "2025-03-01",
  "microsoft.compute/virtualmachines": "2024-11-01",
  "microsoft.app/containerapps": "2025-01-01",
};

async function provisioning(id: string): Promise<Observation> {
  return readCached(`resource:${id}`, async () => {
    const resource = parseResourceId(id);
    const version = resource ? resourceVersions[resource.type.toLowerCase()] : undefined;
    if (!version) return observation("not-configured", "Azure ARM · resource metadata", "No supported runtime binding.");
    const now = new Date().toISOString();
    try {
      const value = await armJson(`${id}?api-version=${version}`);
      const properties = isRecord(value) && isRecord(value.properties) ? value.properties : {};
      const state = typeof properties.provisioningState === "string" ? properties.provisioningState : "unknown";
      return observation(state, "Azure ARM · resource metadata", "Provisioning state only; not application health, EASM coverage or log ingestion.", now);
    } catch (error) {
      return observation(error instanceof SourceError ? error.state : "unavailable", "Azure ARM · resource metadata",
        "The bound resource could not be read. Its existence or health is not inferred.", now);
    }
  });
}

async function availability(id: string): Promise<Observation> {
  return readCached(`availability:${id}`, async () => {
    const now = new Date().toISOString();
    try {
      const value = await armJson(`${id}/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version=2024-02-01`);
      const properties = isRecord(value) && isRecord(value.properties) ? value.properties : {};
      return observation(typeof properties.availabilityState === "string" ? properties.availabilityState : "unknown",
        "Azure Resource Health", "Azure resource availability only, not an application probe or EASM coverage.", now);
    } catch (error) {
      return observation(error instanceof SourceError && error.state === "access-needed" ? "access-needed" : "unknown",
        "Azure Resource Health", "Availability is unsupported or unavailable for this bound resource; no application health inference.", now);
    }
  });
}

async function dnsObservation(zone: string): Promise<Observation> {
  return readCached(`dns:${zone}`, async () => {
    const now = new Date().toISOString();
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    try {
      const names = await resolver.resolveNs(zone);
      return observation("dns-observed", `Public DNS · ${zone}`,
        `${names.length} NS answers observed. Cloudflare account access, record ownership and application reachability are not verified.`, now);
    } catch {
      return observation("unavailable", `Public DNS · ${zone}`, "No current public DNS observation is available.", now);
    } finally {
      resolver.cancel();
    }
  });
}

async function budgetObservation(binding: SourceBinding | undefined): Promise<Observation> {
  if (!binding?.budgetResourceId) return observation("not-configured", "Azure ARM · EASM budget", "An explicit EASM budget binding has not been configured.");
  const id = binding.budgetResourceId;
  return readCached(`budget:${id}`, async () => {
    const now = new Date().toISOString();
    try {
      const value = await armJson(`${id}?api-version=2024-08-01`);
      const properties = isRecord(value) && isRecord(value.properties) ? value.properties : null;
      return observation(properties ? "observed" : "unknown", "Azure ARM · EASM budget",
        properties ? "Budget resource observed. Contacts, amounts, spend and notification settings are intentionally omitted." : "Budget readiness could not be established.", now);
    } catch (error) {
      return observation(error instanceof SourceError ? error.state : "unavailable", "Azure ARM · EASM budget", "Budget readiness could not be read.", now);
    }
  });
}

async function serviceObservation(service: ServiceDefinition, environment: Environment) {
  const sources = runtimeSources();
  const binding = sources?.bindings[service.id]?.[environment];
  const resources = binding?.resourceIds ?? [];
  const configured = sources !== null;
  const [provisioningStates, availabilityStates, dns, workflow, budget] = await Promise.all([
    Promise.all(resources.map(provisioning)),
    Promise.all(resources.map(availability)),
    Promise.all((service.zones ?? []).map(dnsObservation)),
    service.repository && service.statusWorkflow
      ? workflowObservation(service.repository, service.statusWorkflow, environment === "prod" ? "main" : "dev")
      : Promise.resolve(null),
    service.kind === "easm" ? budgetObservation(binding) : Promise.resolve(null),
  ]);
  return {
    id: service.id, label: service.label, description: service.description, kind: service.kind, guideUrl: service.guideUrl,
    ...(service.workflowUrl ? { workflowUrl: service.workflowUrl } : {}),
    desired: observation(configured ? binding?.desired ?? (service.kind === "dns" ? "external" : "not-configured") : "invalid-configuration",
      "Reviewed server runtime configuration", "Desired configuration is not an observation of deployed resources."),
    provisioning: provisioningStates.length ? provisioningStates
      : [observation("not-configured", "Azure ARM · resource metadata", "No approved runtime resource binding. Subscription IDs are never guessed.")],
    availability: availabilityStates.length ? availabilityStates
      : [observation("unknown", "Azure Resource Health", "No resource availability observation.")],
    health: service.kind === "portal"
      ? observation("api-observed", "PawPrint API · this authenticated response", "This API status request responded; frontend reachability and end-to-end application health are not inferred.", new Date().toISOString())
      : observation("unknown", service.kind === "easm" ? "EASM coverage / discovery" : "Application probe",
        service.kind === "easm" ? "Coverage and last discovery are not measured by this console." : "No approved application-health source is configured."),
    dns, workflow, budget,
  };
}

export async function sharedOverview(environment: Environment) {
  return Promise.all(serviceCatalog.map((service) => serviceObservation(service, environment)));
}
