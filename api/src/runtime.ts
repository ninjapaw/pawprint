import { bindingHints, services } from "./catalog.generated.js";

export type Environment = "dev" | "prod";
export type DesiredState = "enabled" | "disabled" | "not-configured";
export interface SourceBinding {
  desired: DesiredState;
  resourceIds: string[];
  budgetResourceId?: string;
}
export interface RuntimeSources {
  subscriptions: Readonly<Record<string, string>>;
  bindings: Readonly<Record<string, Partial<Record<Environment, SourceBinding>>>>;
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (value: unknown): value is string => typeof value === "string" && guidPattern.test(value);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isEnvironment = (value: unknown): value is Environment => value === "dev" || value === "prod";
export const serviceCatalog: readonly ServiceDefinition[] = services;

export interface ServiceDefinition {
  id: string;
  label: string;
  description: string;
  kind: string;
  resourceTypes: readonly string[];
  guideUrl: string;
  workflowUrl?: string;
  repository?: string;
  statusWorkflow?: string;
  zones?: readonly string[];
  siteUrl?: string;
  steps?: readonly string[];
}

export function parseResourceId(id: string) {
  const match = /^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/([a-zA-Z0-9._()-]+)\/providers\/([a-zA-Z.]+\/[a-zA-Z]+)\/([a-zA-Z0-9._()-]+)$/i.exec(id);
  if (!match || !isGuid(match[1]) || !match[2] || !match[3] || !match[4]) return null;
  return { subscription: match[1], group: match[2], type: match[3], name: match[4] };
}

export function runtimeSources(environment: NodeJS.ProcessEnv = process.env): RuntimeSources | null {
  if (!environment.PORTAL_SOURCES_JSON) return { subscriptions: {}, bindings: {} };
  try {
    const value: unknown = JSON.parse(environment.PORTAL_SOURCES_JSON);
    if (!isRecord(value) || !isRecord(value.subscriptions) || !isRecord(value.bindings)
      || Object.keys(value).some((key) => !["subscriptions", "bindings"].includes(key))) return null;
    const subscriptions: Record<string, string> = {};
    for (const [key, id] of Object.entries(value.subscriptions)) {
      if (!["dev", "prod"].includes(key) || !isGuid(id)) return null;
      subscriptions[key] = id;
    }
    const bindings: Record<string, Partial<Record<Environment, SourceBinding>>> = {};
    for (const [id, environments] of Object.entries(value.bindings)) {
      const definition = serviceCatalog.find((item) => item.id === id);
      if (!definition || !isRecord(environments)) return null;
      const hints: Readonly<Record<string, Partial<Record<Environment, { subscriptionRef: string; resourceGroups: readonly string[] }>>>> = bindingHints;
      const bound: Partial<Record<Environment, SourceBinding>> = {};
      for (const [name, binding] of Object.entries(environments)) {
        if (!isEnvironment(name) || !isRecord(binding)
          || !["enabled", "disabled", "not-configured"].includes(String(binding.desired))
          || !Array.isArray(binding.resourceIds) || binding.resourceIds.length > 4
          || Object.keys(binding).some((key) => !["desired", "resourceIds", "budgetResourceId"].includes(key))) return null;
        const hint = hints[id]?.[name];
        const approvedSubscription = hint ? subscriptions[hint.subscriptionRef] : undefined;
        const resourceIds: string[] = [];
        for (const resourceId of binding.resourceIds) {
          if (typeof resourceId !== "string") return null;
          const resource = parseResourceId(resourceId);
          if (!resource || !approvedSubscription
            || resource.subscription.toLowerCase() !== approvedSubscription.toLowerCase()
            || !hint?.resourceGroups.some((group) => group.toLowerCase() === resource.group.toLowerCase())
            || !definition.resourceTypes.some((type) => type.toLowerCase() === resource.type.toLowerCase())) return null;
          resourceIds.push(resourceId);
        }
        const desired = binding.desired;
        if (desired !== "enabled" && desired !== "disabled" && desired !== "not-configured") return null;
        const result: SourceBinding = { desired, resourceIds };
        if (binding.budgetResourceId !== undefined) {
          if (typeof binding.budgetResourceId !== "string" || id !== "shared-easm") return null;
          const match = /^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/([a-zA-Z0-9._()-]+)\/providers\/Microsoft\.Consumption\/budgets\/([a-zA-Z0-9._()-]+)$/i.exec(binding.budgetResourceId);
          if (!match || !approvedSubscription
            || match[1]?.toLowerCase() !== approvedSubscription.toLowerCase()
            || !hint?.resourceGroups.some((group) => group.toLowerCase() === match[2]?.toLowerCase())) return null;
          result.budgetResourceId = binding.budgetResourceId;
        }
        bound[name] = result;
      }
      bindings[id] = bound;
    }
    return { subscriptions, bindings };
  } catch {
    return null;
  }
}

export function workforceConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  const tenantId = environment.PORTAL_ENTRA_TENANT_ID?.trim();
  const clientId = environment.PORTAL_ENTRA_CLIENT_ID?.trim();
  return environment.PORTAL_AUTH_MODE === "workforce" && isGuid(tenantId) && isGuid(clientId)
    ? { tenantId, clientId } : null;
}
