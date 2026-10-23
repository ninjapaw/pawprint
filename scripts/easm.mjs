import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import {
  UUID, ROLE_IDS, configurationDigest, deploymentBlockers, desiredDiscoveryGroups,
  discoveryMarker, normalizeSources, offlineEasmPlan, readEasmConfig, validateEasmConfig,
} from "./lib/easm-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARM = "https://management.azure.com";
const WORKSPACE_API = "2023-04-01-preview";
const DISCOVERY_API = "2024-10-01-preview";
const BUDGET_API = "2026-06-01";
const MODES = ["validate", "plan", "register-provider", "what-if", "deploy", "discovery-plan", "discovery-apply", "run-discovery", "verify"];
const WRITE_MODES = ["register-provider", "deploy", "discovery-apply", "run-discovery"];
const DISCOVERY_WRITES = ["discovery-apply", "run-discovery"];
const sameId = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
const sameEmails = (left, right) => Array.isArray(left) && left.every((item) => typeof item === "string")
  && isDeepStrictEqual([...left].map((item) => item.toLowerCase()).sort(), [...right].map((item) => item.toLowerCase()).sort());

function bindingMatches(actual, expected, context) {
  return sameId(actual.properties?.scope, context.workspaceId) && sameId(actual.properties?.principalId, expected.principalId)
    && actual.properties?.principalType === expected.principalType
    && sameId(actual.properties?.roleDefinitionId, `/subscriptions/${context.subscription}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_IDS[expected.role]}`);
}

function assertNoRetainedManagedBindings(bindings, config, context) {
  if (bindings.some((binding) => sameId(binding.properties?.scope, context.workspaceId)
      && typeof binding.properties?.description === "string"
      && binding.properties.description.startsWith("Pawprint-managed EASM ")
      && !config.accessBindings.some((expected) => bindingMatches(binding, expected, context)))) {
    throw new Error("A previously managed EASM grant is absent from desired access. Incremental IaC does not revoke it; explicitly review/revoke the old assignment before proceeding.");
  }
}

export function azureJson(args) {
  if (process.platform === "win32") {
    throw new Error("Cloud operations require Linux/WSL with Linux Node and Azure CLI, or the manual GitHub workflow. Native Windows supports validate and plan; no shell shim workaround is used.");
  }
  let text;
  try {
    text = execFileSync("az", [...args, "--only-show-errors", "--output", "json"], {
      encoding: "utf8", shell: false, timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no", AZURE_CORE_COLLECT_TELEMETRY: "false" },
    });
  } catch (error) {
    throw new Error(`Azure CLI ${args[0]} ${args[1]} failed (${error.code === "ENOENT" ? "tool unavailable" : `exit ${error.status ?? "unknown"}`}). Check login, permissions, policy, and prerequisites; raw diagnostics were omitted.`);
  }
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { throw new Error("Azure CLI returned invalid JSON; contents omitted."); }
}

export function assertSharedGroup(group, context) {
  if (!sameId(group?.id, context.groupId) || group.tags?.["platform.managed"] !== "true"
      || group.tags?.["platform.environment"] !== context.environment
      || group.tags?.["pawprint.managed"] === "true" || group.tags?.["pawprint.expiresAt"]
      || group.tags?.["pawprint.runId"]) {
    throw new Error("The exact long-lived shared platform group must exist with matching ownership/environment and no scenario expiry. Deploy the reviewed shared baseline first.");
  }
  return group;
}

export function assertWorkspace(workspace, config, context) {
  if (!sameId(workspace?.id, context.workspaceId) || workspace.type?.toLowerCase() !== "microsoft.easm/workspaces"
      || workspace.name !== config.workspaceName || workspace.location?.toLowerCase() !== config.location
      || workspace.tags?.["platform.managed"] !== "true" || workspace.tags?.["platform.environment"] !== config.environment
      || workspace.tags?.component !== "easm") {
    throw new Error("EASM identity, region, or ownership differs. Unmanaged workspaces and implicit renames/region moves are not adopted.");
  }
  return workspace;
}

export function assertEasmEndpoint(value, config, context) {
  let url;
  try { url = new URL(value); } catch { throw new Error("EASM did not return a valid HTTPS data-plane endpoint."); }
  const path = `/subscriptions/${context.subscription}/resourceGroups/${context.groupName}/workspaces/${config.workspaceName}`;
  if (url.protocol !== "https:" || url.hostname !== `${config.location}.easm.defender.microsoft.com`
      || url.port || url.username || url.password || url.search || url.hash
      || !["", "/", path.toLowerCase(), `${path.toLowerCase()}/`].includes(url.pathname.toLowerCase())) {
    throw new Error("Refusing an EASM endpoint outside the independently verified Azure workspace/region.");
  }
  return new URL(path, url.origin).href;
}

export function createApiClient({ base, scope, getToken, fetcher = fetch, assertUrl }) {
  let token;
  async function cancelBody(response) {
    try { await response.body?.cancel(); }
    catch { throw new Error("Azure response body cancellation failed; upstream details were omitted."); }
  }
  async function readJson(response) {
    const limit = 4 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) {
      await cancelBody(response);
      throw new Error("Azure response exceeded the 4 MiB safety limit.");
    }
    if (!response.body) throw new Error("Azure returned an empty JSON response.");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        let chunk;
        try { chunk = await reader.read(); }
        catch { throw new Error("Azure response stream failed or timed out; upstream details were omitted."); }
        const { done, value } = chunk;
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          try { await reader.cancel(); }
          catch { throw new Error("Azure response exceeded its limit and cancellation failed; upstream details were omitted."); }
          throw new Error("Azure response exceeded the 4 MiB safety limit.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Azure returned invalid JSON; contents omitted."); }
  }
  async function request(method, input, body, { allowMissing = false, expectJson = true } = {}) {
    const url = new URL(input, `${base}/`).href;
    assertUrl(url);
    token ??= await getToken(scope);
    let response;
    try {
      response = await fetcher(url, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Azure ${method} request failed or timed out; no success is asserted. Recheck state before retrying writes.`);
    }
    if (response.status === 404 && allowMissing) {
      await cancelBody(response);
      return null;
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new Error(`Azure ${method} request rejected (HTTP ${response.status}); check the selected tenant, scoped permissions, API support, and resource state. Upstream contents were omitted.`);
    }
    if (!expectJson) return response.status;
    return readJson(response);
  }
  async function collection(input) {
    const items = [];
    const visited = new Set();
    let url = new URL(input, `${base}/`).href;
    while (url) {
      if (visited.has(url) || visited.size >= 25) throw new Error("Azure pagination exceeded its safe bound.");
      visited.add(url);
      const page = await request("GET", url);
      if (!Array.isArray(page?.value) || items.length + page.value.length > 1000
          || (page.nextLink != null && typeof page.nextLink !== "string")) {
        throw new Error("Invalid or oversized Azure collection response.");
      }
      items.push(...page.value);
      url = page.nextLink ? new URL(page.nextLink, url).href : undefined;
    }
    return items;
  }
  return { request, collection };
}

function groupState(group) {
  if (!group || typeof group.name !== "string" || typeof group.description !== "string" || typeof group.tier !== "string"
      || !Number.isSafeInteger(group.frequencyMilliseconds) || group.frequencyMilliseconds < 0
      || (group.names?.length ?? 0) > 0 || group.templateId) {
    throw new Error("Discovery group has invalid state or additional organisation-name/template inputs requiring manual scope review.");
  }
  return {
    name: group.name, description: group.description, tier: group.tier,
    frequencyMilliseconds: group.frequencyMilliseconds,
    seeds: normalizeSources(group.seeds), excludes: normalizeSources(group.excludes ?? []),
  };
}

export async function reconcileDiscovery(config, client, { apply = false, approveDiscovery = false } = {}) {
  if (apply && !approveDiscovery) throw new Error("Discovery writes require explicit --approve-discovery; configuration may initiate recursive scanning.");
  const desired = desiredDiscoveryGroups(config);
  const marker = discoveryMarker(config);
  const owns = (group) => typeof group?.description === "string"
    && (group.description === marker || group.description.startsWith(`${marker}\n`));
  const existing = await client.collection(`discoGroups?api-version=${DISCOVERY_API}`);
  if (existing.some((group) => typeof group.description === "string"
      && group.description.startsWith("pawprint:easm:") && !owns(group))) {
    throw new Error("This workspace contains another Pawprint discovery ownership key/environment. Review the primary configuration instead of creating overlapping inventories.");
  }
  if (existing.some((group) => owns(group) && !desired.some((item) => item.name === group.name))) {
    throw new Error("The manifest omits owned discovery groups that may still recur. Retain them with a reviewed schedule or explicitly decommission them; no groups are deleted automatically.");
  }
  const plan = [];
  for (const body of desired) {
    const path = `discoGroups/${encodeURIComponent(body.name)}?api-version=${DISCOVERY_API}`;
    const current = await client.request("GET", path, undefined, { allowMissing: true });
    if (current && (!owns(current) || current.name !== body.name)) throw new Error("Refusing to adopt or overwrite a foreign discovery group.");
    const observed = current ? groupState(current) : null;
    plan.push({ path, body, observed, action: !current ? "create" : isDeepStrictEqual(observed, body) ? "found" : "update", current });
  }
  const actions = [];
  for (const item of plan) {
    let action = item.action;
    let observed = item.current;
    if (apply && action !== "found") {
      const current = await client.request("GET", item.path, undefined, { allowMissing: true });
      if (current && (!owns(current) || current.name !== item.body.name)) throw new Error("Discovery ownership changed before apply.");
      const state = current ? groupState(current) : null;
      if (isDeepStrictEqual(state, item.body)) action = "found";
      else {
        if (!isDeepStrictEqual(state, item.observed)) throw new Error("Discovery configuration changed concurrently; rerun discovery-plan.");
        await client.request("PUT", item.path, item.body);
        observed = await client.request("GET", item.path);
        if (!owns(observed) || !isDeepStrictEqual(groupState(observed), item.body)) throw new Error("Discovery read-back did not match the desired configuration; no success is asserted.");
      }
    }
    if (apply && action === "found") {
      observed = await client.request("GET", item.path);
      if (!owns(observed) || !isDeepStrictEqual(groupState(observed), item.body)) {
        throw new Error("Discovery changed during no-op verification; rerun discovery-plan.");
      }
    }
    if (observed?.latestRun?.state !== undefined
        && !["pending", "running", "completed", "failed"].includes(observed.latestRun.state)) {
      throw new Error("Unexpected EASM discovery run state.");
    }
    actions.push({
      name: item.body.name,
      action: action === "found" ? "found" : apply ? `${action}d` : `would ${action}`,
      latestRunState: observed?.latestRun?.state ?? null,
    });
  }
  return actions;
}

export function assertEasmWhatIf(result, config, context) {
  if (result?.status !== "Succeeded" || !Array.isArray(result.changes)) throw new Error("What-if must return a complete successful change list.");
  const workspace = context.workspaceId.toLowerCase();
  const budget = `${context.groupId}/providers/Microsoft.Consumption/budgets/pawprint-easm-monthly`.toLowerCase();
  const lock = `${workspace}/providers/microsoft.authorization/locks/pawprint-easm`;
  for (const change of result.changes) {
    const id = String(change.resourceId ?? "").toLowerCase();
    const allowed = id === workspace || (config.budget && id === budget)
      || (config.protectFromDeletion && id === lock)
      || (config.accessBindings.length > 0 && id.startsWith(`${workspace}/providers/microsoft.authorization/roleassignments/`));
    if (!allowed || !["Create", "Modify", "NoChange"].includes(change.changeType)) {
      throw new Error("What-if contains an out-of-boundary, destructive, or incompletely analyzed change; refusing deployment.");
    }
    if (id.startsWith(`${workspace}/providers/microsoft.authorization/roleassignments/`)
        && change.changeType !== "NoChange") {
      const after = change.after?.properties;
      if (!UUID.test(id.split("/").at(-1)) || !config.accessBindings.some((binding) =>
        sameId(after?.principalId, binding.principalId) && after?.principalType === binding.principalType
        && sameId(after?.roleDefinitionId, `/subscriptions/${context.subscription}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_IDS[binding.role]}`))) {
        throw new Error("What-if contains an undeclared or unresolved EASM role grant.");
      }
    }
  }
}

function onlyWorkspaceBudgetFilter(filter, workspaceId) {
  if (!filter || filter.tags || (filter.and?.length ?? 0) > 1) return false;
  const dimensions = filter.dimensions ?? (filter.and?.length === 1 && !filter.and[0].tags ? filter.and[0].dimensions : undefined);
  if (filter.dimensions && filter.and?.length) return false;
  return dimensions?.name === "ResourceId" && dimensions.operator === "In"
    && dimensions.values?.length === 1 && sameId(dimensions.values[0], workspaceId);
}

function budgetMatches(budget, config, context) {
  const properties = budget?.properties;
  const contacts = config.budget.contactEmails;
  if (!properties || properties.category !== "Cost" || properties.timeGrain !== "Monthly"
      || properties.amount !== config.budget.monthlyAmount
      || Date.parse(properties.timePeriod?.startDate) !== Date.parse(config.budget.startDate)
      || !onlyWorkspaceBudgetFilter(properties.filter, context.workspaceId)) return false;
  const expected = { Actual80: [80, "Actual"], Actual100: [100, "Actual"], Forecast100: [100, "Forecasted"] };
  if (!isDeepStrictEqual(Object.keys(properties.notifications ?? {}).sort(), Object.keys(expected).sort())) return false;
  return Object.entries(expected).every(([key, [threshold, type]]) => {
    const notification = properties.notifications[key];
    return notification.enabled === true && notification.operator === "GreaterThanOrEqualTo"
      && notification.threshold === threshold && notification.thresholdType === type
      && sameEmails(notification.contactEmails, contacts)
      && !(notification.contactGroups?.length) && !(notification.contactRoles?.length);
  });
}

export async function executeEasm(mode, input, options = {}) {
  if (!MODES.includes(mode)) throw new Error(`Expected one of: ${MODES.join(", ")}.`);
  const config = validateEasmConfig(input);
  const environment = options.environment ?? process.env;
  const log = options.log ?? console.log;
  const requestId = environment.EASM_REQUEST_ID;
  if (requestId !== undefined && requestId !== "" && (typeof requestId !== "string" || !UUID.test(requestId))) {
    throw new Error("EASM_REQUEST_ID must be an optional correlation UUID; no authorization is inferred from it.");
  }
  if (requestId) {
    log(JSON.stringify({
      event: "shared-easm-request", requestId, operation: mode,
      environment: config.environment, configurationSha256: configurationDigest(config),
    }));
  }
  if (environment.EASM_TARGET_ENVIRONMENT && environment.EASM_TARGET_ENVIRONMENT !== config.environment) {
    throw new Error("The configuration environment must match the explicitly selected GitHub Environment.");
  }
  if (["validate", "plan"].includes(mode)) {
    const plan = offlineEasmPlan(config);
    log(JSON.stringify(plan, null, 2));
    return plan;
  }
  if (WRITE_MODES.includes(mode) && !options.yes) throw new Error("Writes require --yes to acknowledge the reviewed configuration and applicable ongoing costs.");
  if (DISCOVERY_WRITES.includes(mode) && !options.approveDiscovery) throw new Error("Scanning/discovery writes require a separate --approve-discovery authorization.");
  if (["what-if", "deploy", ...DISCOVERY_WRITES].includes(mode) && deploymentBlockers(config).length) {
    throw new Error(`Deployment blocked: ${deploymentBlockers(config).join(" ")}`);
  }
  if (DISCOVERY_WRITES.includes(mode) && !config.discoveryGroups.length) throw new Error("No discovery groups are declared; no discovery action can be applied.");
  if (environment.EASM_SOURCE_REF && environment.EASM_SOURCE_REF !== (config.environment === "prod" ? "main" : "dev")) {
    throw new Error("Cloud operations must use the branch matching the selected environment.");
  }
  const subscription = environment.AZURE_SUBSCRIPTION_ID;
  const tenant = environment.AZURE_TENANT_ID;
  if (!UUID.test(subscription ?? "") || !UUID.test(tenant ?? "")) throw new Error("Cloud operations require explicit AZURE_SUBSCRIPTION_ID and AZURE_TENANT_ID UUIDs.");
  const az = options.azure ?? azureJson;
  const account = az(["account", "show"]);
  if (!sameId(account?.id, subscription) || !sameId(account.tenantId, tenant) || account.state !== "Enabled"
      || az(["cloud", "show"])?.name !== "AzureCloud") {
    throw new Error("The enabled active AzureCloud subscription and tenant must exactly match the explicit runtime target. No account is switched automatically.");
  }
  let provider = az(["provider", "show", "--namespace", "Microsoft.Easm", "--subscription", subscription]);
  if (mode === "register-provider") {
    const namespaces = ["Microsoft.Easm", ...(config.budget ? ["Microsoft.Consumption"] : [])];
    for (const namespace of namespaces) {
      let current = namespace === "Microsoft.Easm" ? provider : az(["provider", "show", "--namespace", namespace, "--subscription", subscription]);
      if (current?.registrationState !== "Registered") {
        az(["provider", "register", "--namespace", namespace, "--subscription", subscription, "--wait"]);
        current = az(["provider", "show", "--namespace", namespace, "--subscription", subscription]);
      }
      if (current?.registrationState !== "Registered") throw new Error(`Provider ${namespace} has not reached Registered.`);
    }
    const result = { providerRegistered: true, registeredProviders: namespaces, workspaceDeployed: false };
    log(JSON.stringify(result));
    return result;
  }
  const regions = provider?.resourceTypes?.find((item) => item.resourceType?.toLowerCase() === "workspaces")?.locations;
  if (provider?.registrationState !== "Registered" || !Array.isArray(regions)
      || !regions.some((region) => region.replaceAll(" ", "").toLowerCase() === config.location)) {
    throw new Error("Microsoft.Easm must be explicitly registered and advertise the selected workspace region. Run the separately approved registration action if needed.");
  }
  if (config.budget && az(["provider", "show", "--namespace", "Microsoft.Consumption", "--subscription", subscription])?.registrationState !== "Registered") {
    throw new Error("Microsoft.Consumption must be explicitly registered for the declared cost budget.");
  }
  const platform = options.platform ?? JSON.parse(readFileSync(join(ROOT, "config", "platform.json"), "utf8"));
  const groupName = platform.environments?.[config.environment]?.platformResourceGroup;
  if (typeof groupName !== "string" || !/^[a-z0-9._()-]{1,90}$/i.test(groupName) || groupName.endsWith(".")) {
    throw new Error("The shared platform group must be explicitly declared in config/platform.json.");
  }
  const groupId = `/subscriptions/${subscription}/resourceGroups/${groupName}`;
  const context = { environment: config.environment, subscription, groupName, groupId, workspaceId: `${groupId}/providers/Microsoft.Easm/workspaces/${config.workspaceName}` };
  const getToken = async (scope) => {
    const token = az(["account", "get-access-token", "--subscription", subscription, "--scope", scope]);
    if (typeof token?.accessToken !== "string" || !token.accessToken
        || (token.expires_on !== undefined && (!Number.isFinite(Number(token.expires_on)) || Number(token.expires_on) <= Date.now() / 1000))) {
      throw new Error("Azure CLI did not return an active access token; no credential is printed or persisted.");
    }
    return token.accessToken;
  };
  const arm = createApiClient({
    base: ARM, scope: `${ARM}/.default`, getToken, fetcher: options.fetcher,
    assertUrl: (value) => {
      const url = new URL(value);
      const path = groupId.toLowerCase();
      if (url.origin !== ARM || url.username || url.password || url.hash || url.pathname.includes("%")
          || !(url.pathname.toLowerCase() === path || url.pathname.toLowerCase().startsWith(`${path}/`))) {
        throw new Error("Refusing a management request outside the exact shared resource group.");
      }
    },
  });
  assertSharedGroup(await arm.request("GET", `${groupId}?api-version=2025-04-01`, undefined, { allowMissing: true }), context);
  const workspacePath = `${context.workspaceId}?api-version=${WORKSPACE_API}`;
  const getWorkspace = async () => {
    const workspace = await arm.request("GET", workspacePath);
    assertWorkspace(workspace, config, context);
    if (workspace.properties?.provisioningState !== "Succeeded") throw new Error("EASM provisioning has not reached Succeeded.");
    return workspace;
  };
  const budgetPath = `${groupId}/providers/Microsoft.Consumption/budgets/pawprint-easm-monthly?api-version=${BUDGET_API}`;
  const bindingsPath = `${context.workspaceId}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01`;
  const verifyInfrastructure = async () => {
    const workspace = await getWorkspace();
    const endpoint = assertEasmEndpoint(workspace.properties?.dataPlaneEndpoint, config, context);
    if (config.budget && !budgetMatches(await arm.request("GET", budgetPath), config, context)) {
      throw new Error("The EASM-only budget amount, period, scope, or notification contacts/thresholds did not converge.");
    }
    if (config.protectFromDeletion) {
      const lock = await arm.request("GET", `${context.workspaceId}/providers/Microsoft.Authorization/locks/pawprint-easm?api-version=2020-05-01`);
      if (lock?.properties?.level !== "CanNotDelete") throw new Error("The EASM workspace deletion lock is not verified.");
    }
    const bindings = await arm.collection(bindingsPath);
    assertNoRetainedManagedBindings(bindings, config, context);
    if (config.accessBindings.length) {
      if (config.accessBindings.some((expected) => !bindings.some((actual) => bindingMatches(actual, expected, context)))) {
        throw new Error("A declared workspace-scoped EASM access binding was not read back. Inherited/undeclared grants are not asserted absent.");
      }
    }
    return { workspace, endpoint };
  };
  if (["what-if", "deploy"].includes(mode)) {
    const workspaces = await arm.collection(`${groupId}/providers/Microsoft.Easm/workspaces?api-version=${WORKSPACE_API}`);
    if (workspaces.some((workspace) => !sameId(workspace.id, context.workspaceId))) {
      throw new Error("Another EASM workspace exists in the selected shared group. Review the primary inventory/migration; duplicate workspaces are not created implicitly.");
    }
    const current = await arm.request("GET", workspacePath, undefined, { allowMissing: true });
    if (current) {
      assertWorkspace(current, config, context);
      assertNoRetainedManagedBindings(await arm.collection(bindingsPath), config, context);
    }
    const currentBudget = await arm.request("GET", budgetPath, undefined, { allowMissing: true });
    if (currentBudget) {
      if (!onlyWorkspaceBudgetFilter(currentBudget.properties?.filter, context.workspaceId)
          || (config.budget && Date.parse(currentBudget.properties?.timePeriod?.startDate) !== Date.parse(config.budget.startDate))) {
        throw new Error("The reserved budget has a different scope or immutable start date; review migration instead of overwriting it.");
      }
    }
    const directory = mkdtempSync(join(tmpdir(), "pawprint-easm-"));
    try {
      const file = join(directory, "parameters.json");
      writeFileSync(file, JSON.stringify({
        $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
        contentVersion: "1.0.0.0",
        parameters: Object.fromEntries(Object.entries({
          workspaceName: config.workspaceName, location: config.location,
          tags: { "platform.managed": "true", "platform.environment": config.environment, owner: platform.githubOrganisation, managedBy: "bicep" },
          accessBindings: config.accessBindings, budgetConfig: config.budget, protectFromDeletion: config.protectFromDeletion,
        }).map(([key, value]) => [key, { value }])),
      }), { mode: 0o600 });
      const args = ["--subscription", subscription, "--resource-group", groupName,
        "--name", `pawprint-easm-${config.environment}`, "--template-file", join(ROOT, "platform", "org-easm.bicep"),
        "--parameters", `@${file}`];
      const preview = az(["deployment", "group", "what-if", ...args, "--no-pretty-print", "--result-format", "FullResourcePayloads"]);
      assertEasmWhatIf(preview, config, context);
      log(JSON.stringify({ configurationSha256: configurationDigest(config), changes: preview.changes.map((change) => ({ changeType: change.changeType, resourceId: change.resourceId })) }, null, 2));
      if (mode === "what-if") return { previewVerified: true, changeCount: preview.changes.length };
      const deployment = az(["deployment", "group", "create", ...args]);
      if (deployment?.properties?.provisioningState !== "Succeeded") throw new Error("EASM deployment did not reach Succeeded; no success is asserted.");
      await verifyInfrastructure();
      const result = { infrastructureVerified: true, discoveryConfigured: false, configurationSha256: configurationDigest(config) };
      log(JSON.stringify(result));
      return result;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const { endpoint } = await verifyInfrastructure();
  if (mode === "verify" && !config.discoveryGroups.length) {
    const result = { infrastructureVerified: true, declaredDiscoveryGroups: 0, coverage: "not asserted; omitted groups/assets are not deleted or stopped" };
    log(JSON.stringify(result));
    return result;
  }
  const data = createApiClient({
    base: endpoint, scope: "https://easm.defender.microsoft.com/.default", getToken, fetcher: options.fetcher,
    assertUrl: (value) => {
      const url = new URL(value);
      const base = new URL(endpoint);
      if (url.origin !== base.origin || url.username || url.password || url.hash || url.pathname.includes("%")
          || !(url.pathname === `${base.pathname}/discoGroups` || url.pathname.startsWith(`${base.pathname}/discoGroups/`))) {
        throw new Error("Refusing an EASM request outside this workspace's discovery groups.");
      }
    },
  });
  const actions = await reconcileDiscovery(config, data, {
    apply: mode === "discovery-apply", approveDiscovery: options.approveDiscovery,
  });
  if (["verify", "run-discovery"].includes(mode) && actions.some((action) => action.action !== "found")) {
    throw new Error("Discovery configuration has drifted; review discovery-plan and explicitly apply it first.");
  }
  if (mode === "run-discovery") {
    if (actions.some((action) => ["pending", "running"].includes(action.latestRunState))) throw new Error("An owned discovery run is already pending/running; concurrent scans are not started.");
    for (const action of actions) {
      const status = await data.request("POST", `discoGroups/${encodeURIComponent(action.name)}:run?api-version=${DISCOVERY_API}`, undefined, { expectJson: false });
      if (status !== 204) throw new Error("EASM did not acknowledge discovery submission with the documented HTTP 204 response.");
    }
    const result = { submittedGroups: actions.length, discoveryCompletion: "not asserted", configurationSha256: configurationDigest(config) };
    log(JSON.stringify(result));
    return result;
  }
  if (mode === "verify" && actions.some((action) => action.latestRunState === "failed")) throw new Error("An observed discovery run failed. Configuration convergence is not discovery health or coverage.");
  const result = { infrastructureVerified: true, actions, discoveryCoverage: "not asserted", configurationSha256: configurationDigest(config) };
  log(JSON.stringify(result, null, 2));
  return result;
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { config: { type: "string" }, yes: { type: "boolean", default: false }, "approve-discovery": { type: "boolean", default: false } },
  });
  if (positionals.length !== 1 || !MODES.includes(positionals[0])) throw new Error(`Usage: node scripts/easm.mjs <${MODES.join("|")}> [--config <file>] [--yes] [--approve-discovery].`);
  if (values["approve-discovery"] && !DISCOVERY_WRITES.includes(positionals[0])) throw new Error("--approve-discovery applies only to discovery-apply or run-discovery.");
  return executeEasm(positionals[0], readEasmConfig(values.config, environment), {
    environment, yes: values.yes, approveDiscovery: values["approve-discovery"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
