import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  assertEasmEndpoint, assertEasmWhatIf, createApiClient, executeEasm, reconcileDiscovery,
} from "./easm.mjs";
import {
  desiredDiscoveryGroups, normalizeSources, readEasmConfig, ROLE_IDS, validateEasmConfig,
} from "./lib/easm-config.mjs";

const SUBSCRIPTION = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const ARM_TOKEN = "fake-arm-token-do-not-log";
const DATA_TOKEN = "fake-data-token-do-not-log";
const GROUP = "NP-Platform-CentralUS";
const groupId = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}`;

function configuration(overrides = {}) {
  return validateEasmConfig({
    configVersion: "1.0.0", key: "test-shared", enabled: true, environment: "prod",
    workspaceName: "easm-test-shared", location: "centralus", protectFromDeletion: true,
    accessBindings: [{ principalId: PRINCIPAL, principalType: "Group", role: "Reader" }],
    budget: { monthlyAmount: 100, contactEmails: ["cost-owner@example.org"], startDate: "2026-10-01T00:00:00Z" },
    authorizedDomains: ["example.org"],
    discoveryGroups: [{
      name: "primary", tier: "advanced", frequencyDays: 0, description: "Authorized test scope",
      seeds: [{ kind: "domain", name: "example.org" }], excludes: [],
    }],
    ...overrides,
  });
}

function budgetResource(config, workspaceId) {
  return { properties: {
    amount: config.budget.monthlyAmount, category: "Cost", timeGrain: "Monthly",
    timePeriod: { startDate: config.budget.startDate },
    filter: { dimensions: { name: "ResourceId", operator: "In", values: [workspaceId] } },
    notifications: Object.fromEntries([
      ["Actual80", 80, "Actual"], ["Actual100", 100, "Actual"], ["Forecast100", 100, "Forecasted"],
    ].map(([name, threshold, thresholdType]) => [name, {
      enabled: true, operator: "GreaterThanOrEqualTo", threshold, thresholdType, contactEmails: config.budget.contactEmails,
    }])),
  } };
}

function harness(config = configuration(), options = {}) {
  const context = {
    subscription: SUBSCRIPTION, environment: "prod", groupName: GROUP, groupId,
    workspaceId: `${groupId}/providers/Microsoft.Easm/workspaces/${config.workspaceName}`,
  };
  const endpoint = `https://${config.location}.easm.defender.microsoft.com/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/workspaces/${config.workspaceName}`;
  const azureCalls = [], requests = [], writes = [], logs = [];
  const groups = new Map();
  const state = {
    providerState: options.providerState ?? "Registered", workspace: null, budget: null, locked: false,
    bindings: [], lastParameterFile: undefined, lastParameters: undefined,
    group: { id: groupId, tags: { "platform.managed": "true", "platform.environment": "prod" } },
  };
  function populate(parameters) {
    const values = parameters ?? {
      workspaceName: { value: config.workspaceName }, location: { value: config.location },
      tags: { value: { "platform.managed": "true", "platform.environment": "prod" } },
      budgetConfig: { value: config.budget }, accessBindings: { value: config.accessBindings },
      protectFromDeletion: { value: config.protectFromDeletion },
    };
    state.workspace = {
      id: context.workspaceId, type: "Microsoft.Easm/workspaces", name: values.workspaceName.value, location: values.location.value,
      tags: { ...values.tags.value, component: "easm" },
      properties: { provisioningState: "Succeeded", dataPlaneEndpoint: endpoint },
    };
    state.budget = values.budgetConfig.value ? budgetResource({ budget: values.budgetConfig.value }, context.workspaceId) : null;
    state.locked = values.protectFromDeletion.value;
    state.bindings = values.accessBindings.value.map((binding) => ({
      properties: {
        ...binding, scope: context.workspaceId,
        roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_IDS[binding.role]}`,
        description: `Pawprint-managed EASM ${binding.role} access.`,
      },
    }));
  }
  if (options.existing) populate();
  const azure = (args) => {
    azureCalls.push(args);
    const custom = options.azureOverride?.(args, state);
    if (custom !== undefined) return custom;
    const command = args.slice(0, 3).join(" ");
    if (command === "account show") return { id: SUBSCRIPTION, tenantId: TENANT, state: "Enabled" };
    if (command === "cloud show") return { name: "AzureCloud" };
    if (command === "provider show --namespace") return {
      registrationState: state.providerState, resourceTypes: [{ resourceType: "workspaces", locations: ["Central US", "East US"] }],
    };
    if (command === "provider register --namespace") { state.providerState = "Registered"; return null; }
    if (command === "account get-access-token --subscription") return {
      accessToken: args.includes("https://easm.defender.microsoft.com/.default") ? DATA_TOKEN : ARM_TOKEN,
      expires_on: Math.floor(Date.now() / 1000) + 3600,
    };
    if (command === "deployment group what-if") {
      state.lastParameterFile = args.find((arg) => arg.startsWith("@")).slice(1);
      state.lastParameters = JSON.parse(readFileSync(state.lastParameterFile, "utf8")).parameters;
      const preview = { status: "Succeeded", changes: [
        { resourceId: context.workspaceId, changeType: state.workspace ? "NoChange" : "Create" },
        ...(config.budget ? [{ resourceId: `${groupId}/providers/Microsoft.Consumption/budgets/pawprint-easm-monthly`, changeType: "Create" }] : []),
        ...(config.protectFromDeletion ? [{ resourceId: `${context.workspaceId}/providers/Microsoft.Authorization/locks/pawprint-easm`, changeType: "Create" }] : []),
        ...config.accessBindings.map((binding, index) => ({
          resourceId: `${context.workspaceId}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
          changeType: "Create",
          after: { properties: {
            principalId: binding.principalId, principalType: binding.principalType,
            roleDefinitionId: `/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_IDS[binding.role]}`,
          } },
        })),
      ] };
      options.mutatePreview?.(preview, context);
      return preview;
    }
    if (command === "deployment group create") {
      if (options.failDeployment) return { properties: { provisioningState: "Failed" } };
      populate(state.lastParameters);
      return { properties: { provisioningState: "Succeeded" } };
    }
    throw new Error(`Unexpected mocked Azure operation: ${command}`);
  };
  const fetcher = async (url, request) => {
    requests.push({ url, request });
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    const custom = await options.fetchOverride?.(url, request, state, groups, context);
    if (custom !== undefined) return custom;
    const parsed = new URL(url);
    const missing = () => Response.json({ error: { message: `${ARM_TOKEN} ${DATA_TOKEN}` } }, { status: 404 });
    if (parsed.origin === "https://management.azure.com") {
      assert.equal(request.headers.Authorization, `Bearer ${ARM_TOKEN}`);
      assert.equal(request.method, "GET");
      if (parsed.pathname === groupId) return state.group ? Response.json(state.group) : missing();
      if (parsed.pathname === `${groupId}/providers/Microsoft.Easm/workspaces`) return Response.json({ value: state.workspace ? [state.workspace] : [] });
      if (parsed.pathname === context.workspaceId) return state.workspace ? Response.json(state.workspace) : missing();
      if (parsed.pathname.endsWith("/providers/Microsoft.Consumption/budgets/pawprint-easm-monthly")) return state.budget ? Response.json(state.budget) : missing();
      if (parsed.pathname.endsWith("/providers/Microsoft.Authorization/locks/pawprint-easm")) return state.locked ? Response.json({ properties: { level: "CanNotDelete" } }) : missing();
      if (parsed.pathname.endsWith("/providers/Microsoft.Authorization/roleAssignments")) return Response.json({ value: state.bindings });
    } else {
      assert.equal(parsed.origin, `https://${config.location}.easm.defender.microsoft.com`);
      assert.equal(request.headers.Authorization, `Bearer ${DATA_TOKEN}`);
      assert.equal(parsed.searchParams.get("api-version"), "2024-10-01-preview");
      const prefix = `${new URL(endpoint).pathname}/discoGroups`;
      if (request.method === "GET" && parsed.pathname === prefix) return Response.json({ value: [...groups.values()] });
      const name = decodeURIComponent(parsed.pathname.slice(prefix.length + 1));
      if (request.method === "GET") return groups.has(name) ? Response.json(groups.get(name)) : missing();
      if (request.method === "PUT") {
        const body = JSON.parse(request.body);
        groups.set(name, { ...body, latestRun: groups.get(name)?.latestRun ?? null });
        writes.push({ method: "PUT", name, body });
        return Response.json(groups.get(name));
      }
      if (request.method === "POST" && name.endsWith(":run")) {
        const group = groups.get(name.slice(0, -4));
        assert.ok(group);
        group.latestRun = { state: "pending" };
        writes.push({ method: "POST", name });
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected mocked request: ${request.method} ${parsed.pathname}`);
  };
  return {
    config, context, endpoint, state, groups, azureCalls, requests, writes, logs, populate,
    options: {
      azure, fetcher, log: (value) => logs.push(value),
      environment: { AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: TENANT, EASM_TARGET_ENVIRONMENT: "prod", EASM_SOURCE_REF: "main" },
      platform: { githubOrganisation: "ninjapaw", environments: { prod: { platformResourceGroup: GROUP } } },
    },
  };
}

test("configuration fails closed on credentials, broad roles, invalid financial values, and unapproved seeds", () => {
  const base = configuration();
  for (const patch of [
    { token: "accidental-secret" }, { subscriptionId: SUBSCRIPTION },
    { accessBindings: [{ principalId: PRINCIPAL, principalType: "Group", role: "Owner" }] },
    { budget: { ...base.budget, monthlyAmount: 0 } },
    { budget: { ...base.budget, monthlyAmount: 10.5 } },
    { budget: { ...base.budget, contactEmails: [] } },
    { budget: { ...base.budget, startDate: "2026-10-22T00:00:00Z" } },
    { discoveryGroups: [{ ...base.discoveryGroups[0], seeds: [{ kind: "domain", name: "outside.example.net" }] }] },
    { authorizedDomains: ["example.org", "EXAMPLE.ORG"] },
    { discoveryGroups: [...base.discoveryGroups, ...base.discoveryGroups] },
  ]) assert.throws(() => validateEasmConfig({ ...base, ...patch }));
  assert.throws(() => readEasmConfig(undefined, { EASM_CONFIG_JSON: '{"token":"accidental-secret",broken' }),
    (error) => /contents omitted/.test(error.message) && !error.message.includes("accidental-secret"));
});

test("source canonicalization is deterministic and CIDR exclusions do not become discovery seeds", () => {
  assert.deepEqual(normalizeSources([
    { kind: "ipBlock", name: "192.0.2.17/24" }, { kind: "ipBlock", name: "2001:0db8:1::9/32" },
  ]), [{ kind: "ipBlock", name: "192.0.2.0/24" }, { kind: "ipBlock", name: "2001:db8::/32" }]);
  assert.throws(() => normalizeSources([{ kind: "ipBlock", name: "192.0.2.1/33" }]));
  assert.throws(() => normalizeSources([{ kind: "ipBlock", name: "::1/-1" }]));
  const base = configuration();
  assert.throws(() => validateEasmConfig({ ...base, discoveryGroups: [{ ...base.discoveryGroups[0], seeds: [{ kind: "ipBlock", name: "192.0.2.0/24" }] }] }));
});

test("offline validation and plan never authenticate, write, scan, or print contact/principal details", async () => {
  const h = harness();
  for (const mode of ["validate", "plan"]) {
    const result = await executeEasm(mode, h.config, h.options);
    assert.equal(result.environment, "prod");
    assert.equal(result.configurationSha256.length, 64);
  }
  assert.equal(h.azureCalls.length, 0);
  assert.equal(h.requests.length, 0);
  assert.ok(h.logs.every((value) => !value.includes("cost-owner@example.org") && !value.includes(PRINCIPAL)));
});

test("optional portal correlation is validated and logged but never authorizes a write", async () => {
  const requestId = "44444444-4444-4444-8444-444444444444";
  const h = harness();
  const options = { ...h.options, environment: { ...h.options.environment, EASM_REQUEST_ID: requestId } };
  await executeEasm("plan", h.config, options);
  const event = JSON.parse(h.logs[0]);
  assert.equal(event.event, "shared-easm-request");
  assert.equal(event.requestId, requestId);
  assert.equal(event.operation, "plan");
  assert.equal(h.azureCalls.length, 0);
  await assert.rejects(executeEasm("deploy", h.config, options), /--yes/);
  assert.equal(h.azureCalls.length, 0);
  for (const value of ["not-a-uuid", "unsafe\nvalue", null, 17]) {
    await assert.rejects(executeEasm("plan", h.config, {
      ...h.options, environment: { ...h.options.environment, EASM_REQUEST_ID: value },
    }), /optional correlation UUID/);
  }
});

test("all writes, discovery actions, and incomplete/disabled deployments stop before Azure", async () => {
  for (const mode of ["register-provider", "deploy", "discovery-apply", "run-discovery"]) {
    const h = harness();
    await assert.rejects(executeEasm(mode, h.config, h.options), /--yes/);
    assert.equal(h.azureCalls.length, 0);
  }
  for (const mode of ["discovery-apply", "run-discovery"]) {
    const h = harness();
    await assert.rejects(executeEasm(mode, h.config, { ...h.options, yes: true }), /--approve-discovery/);
    assert.equal(h.azureCalls.length, 0);
  }
  for (const patch of [{ enabled: false }, { budget: null }]) {
    const h = harness(configuration(patch));
    await assert.rejects(executeEasm("deploy", h.config, { ...h.options, yes: true }), /Deployment blocked/);
    assert.equal(h.azureCalls.length, 0);
  }
});

test("tenant, subscription, branch, and environment mismatches cannot redirect cloud operations", async () => {
  for (const environment of [
    { AZURE_SUBSCRIPTION_ID: "bad" }, { AZURE_TENANT_ID: SUBSCRIPTION }, { EASM_TARGET_ENVIRONMENT: "dev" }, { EASM_SOURCE_REF: "dev" },
  ]) {
    const h = harness();
    await assert.rejects(executeEasm("deploy", h.config, { ...h.options, yes: true, environment: { ...h.options.environment, ...environment } }));
    assert.equal(h.requests.length, 0);
  }
});

test("provider registration is separately approved, read back, and idempotent", async () => {
  const h = harness(undefined, { providerState: "NotRegistered" });
  assert.equal((await executeEasm("register-provider", h.config, { ...h.options, yes: true })).workspaceDeployed, false);
  await executeEasm("register-provider", h.config, { ...h.options, yes: true });
  assert.equal(h.azureCalls.filter((args) => args[0] === "provider" && args[1] === "register").length, 1);
  assert.equal(h.requests.length, 0);
});

test("deployment previews exact scoped resources, verifies governance, and removes temporary parameters", async () => {
  const h = harness();
  const result = await executeEasm("deploy", h.config, { ...h.options, yes: true });
  assert.equal(result.infrastructureVerified, true);
  assert.equal(result.discoveryConfigured, false);
  assert.deepEqual(h.state.lastParameters.budgetConfig.value, h.config.budget);
  assert.deepEqual(h.state.lastParameters.accessBindings.value, h.config.accessBindings);
  assert.equal(existsSync(h.state.lastParameterFile), false);
  const preview = h.azureCalls.findIndex((args) => args[0] === "deployment" && args[2] === "what-if");
  const create = h.azureCalls.findIndex((args) => args[0] === "deployment" && args[2] === "create");
  assert.ok(preview >= 0 && create > preview);
  assert.equal(h.writes.length, 0);
  assert.ok(h.requests.every(({ url }) => new URL(url).origin === "https://management.azure.com"));
  assert.ok(h.logs.every((value) => !value.includes(ARM_TOKEN) && !value.includes(DATA_TOKEN) && !value.includes("cost-owner@example.org")));
});

test("missing/expiring shared groups and unmanaged workspaces are never adopted", async () => {
  for (const mutate of [
    (h) => { h.state.group = null; },
    (h) => { h.state.group.tags["pawprint.managed"] = "true"; },
    (h) => { h.state.group.tags["pawprint.expiresAt"] = "2026-10-01"; },
    (h) => { h.state.workspace.tags["platform.managed"] = "false"; },
    (h) => { h.state.workspace.location = "eastus"; },
  ]) {
    const h = harness(undefined, { existing: true });
    mutate(h);
    await assert.rejects(executeEasm("deploy", h.config, { ...h.options, yes: true }));
    assert.ok(!h.azureCalls.some((args) => args[0] === "deployment"));
    assert.equal(h.writes.length, 0);
  }
});

test("what-if refuses deletions, out-of-scope resources, unresolved analysis, and undeclared privileges", () => {
  const h = harness();
  for (const change of [
    { resourceId: h.context.workspaceId, changeType: "Delete" },
    { resourceId: h.context.workspaceId, changeType: "Unsupported" },
    { resourceId: `${groupId}/providers/Microsoft.Web/sites/foreign`, changeType: "Create" },
    {
      resourceId: `${h.context.workspaceId}/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      changeType: "Create", after: { properties: { principalId: PRINCIPAL, principalType: "Group", roleDefinitionId: "Owner" } },
    },
  ]) assert.throws(() => assertEasmWhatIf({ status: "Succeeded", changes: [change] }, h.config, h.context));
  assert.throws(() => assertEasmWhatIf({ status: "Failed", changes: [] }, h.config, h.context));
});

test("failed deployments and failed governance readback never report success", async () => {
  const failed = harness(undefined, { failDeployment: true });
  await assert.rejects(executeEasm("deploy", failed.config, { ...failed.options, yes: true }), /did not reach Succeeded/);
  assert.equal(existsSync(failed.state.lastParameterFile), false);
  const budget = harness(undefined, { existing: true });
  budget.state.budget.properties.notifications.Actual80.contactEmails = ["unexpected@example.org"];
  await assert.rejects(executeEasm("verify", budget.config, budget.options), /budget amount/);
  const lock = harness(undefined, { existing: true });
  lock.state.locked = false;
  await assert.rejects(executeEasm("verify", lock.config, lock.options), /HTTP 404/);
});

test("removed or downgraded managed grants must be explicitly revoked, not silently retained", async () => {
  const h = harness(undefined, { existing: true });
  const reduced = configuration({ accessBindings: [], discoveryGroups: [] });
  await assert.rejects(executeEasm("deploy", reduced, { ...h.options, yes: true }), /does not revoke/);
  assert.ok(!h.azureCalls.some((args) => args[0] === "deployment"));
  await assert.rejects(executeEasm("verify", reduced, h.options), /does not revoke/);
});

test("invalid/expired tokens are rejected before any management request", async () => {
  for (const expires_on of ["invalid", 1]) {
    const h = harness(undefined, { azureOverride: (args) => args[1] === "get-access-token" ? { accessToken: ARM_TOKEN, expires_on } : undefined });
    await assert.rejects(executeEasm("what-if", h.config, h.options), /active access token/);
    assert.equal(h.requests.length, 0);
  }
});

test("data endpoints and redirects cannot receive credentials outside the verified workspace", async () => {
  const h = harness(undefined, { existing: true });
  for (const value of [
    "http://centralus.easm.defender.microsoft.com", "https://evil.example.org",
    `https://user@centralus.easm.defender.microsoft.com`, `${h.endpoint}?token=unsafe`,
    h.endpoint.replace(h.config.workspaceName, "foreign"), h.endpoint.replace("centralus.", "eastus."),
  ]) assert.throws(() => assertEasmEndpoint(value, h.config, h.context));
  h.state.workspace.properties.dataPlaneEndpoint = "https://evil.example.org";
  await assert.rejects(executeEasm("discovery-plan", h.config, h.options), /Refusing an EASM endpoint/);
  assert.ok(!h.azureCalls.some((args) => args.includes("https://easm.defender.microsoft.com/.default")));
  let tokens = 0;
  const client = createApiClient({
    base: "https://example.invalid", scope: "unused", getToken: async () => { tokens += 1; return ARM_TOKEN; },
    assertUrl: () => { throw new Error("blocked origin"); },
  });
  await assert.rejects(client.request("GET", "/"), /blocked origin/);
  assert.equal(tokens, 0);
});

test("transport errors and invalid JSON omit upstream bodies and token details", async () => {
  for (const fetcher of [
    async () => { throw new Error(DATA_TOKEN); },
    async () => Response.json({ error: DATA_TOKEN }, { status: 403 }),
    async () => new Response(DATA_TOKEN),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(DATA_TOKEN)); } })),
  ]) {
    const client = createApiClient({ base: "https://example.invalid", scope: "unused", getToken: async () => DATA_TOKEN, assertUrl() {}, fetcher });
    await assert.rejects(client.request("GET", "/"), (error) => !error.message.includes(DATA_TOKEN));
  }
  const oversized = createApiClient({
    base: "https://example.invalid", scope: "unused", getToken: async () => DATA_TOKEN, assertUrl() {},
    fetcher: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
  });
  await assert.rejects(oversized.request("GET", "/"), /4 MiB safety limit/);
});

test("discovery plan reads only; apply creates owned groups, reads back, and repeats without writes", async () => {
  const h = harness(undefined, { existing: true });
  const plan = await executeEasm("discovery-plan", h.config, h.options);
  assert.equal(plan.actions[0].action, "would create");
  assert.equal(h.writes.length, 0);
  const applied = await executeEasm("discovery-apply", h.config, { ...h.options, yes: true, approveDiscovery: true });
  assert.equal(applied.actions[0].action, "created");
  assert.equal(h.writes.length, 1);
  assert.ok(h.writes[0].body.description.startsWith("pawprint:easm:test-shared:prod"));
  assert.equal(h.writes[0].body.frequencyMilliseconds, 0);
  await executeEasm("discovery-apply", h.config, { ...h.options, yes: true, approveDiscovery: true });
  assert.equal(h.writes.length, 1);
  assert.ok(h.writes.every((write) => write.method === "PUT"));
});

test("foreign ownership, different manifests, omitted schedules, and template-based scope are explicit conflicts", async () => {
  const desired = desiredDiscoveryGroups(configuration())[0];
  for (const current of [
    { ...desired, description: "Owned outside Pawprint" },
    { ...desired, description: "pawprint:easm:another:prod" },
    { ...desired, names: ["unexpected organisation"] },
    { ...desired, templateId: "broad-template" },
  ]) {
    const h = harness(undefined, { existing: true });
    h.groups.set(desired.name, current);
    await assert.rejects(executeEasm("discovery-apply", h.config, { ...h.options, yes: true, approveDiscovery: true }));
    assert.equal(h.writes.length, 0);
  }
  const client = {
    collection: async () => [{ ...desired, name: "pawprint-test-shared-omitted" }],
  };
  await assert.rejects(reconcileDiscovery(configuration(), client), /omits owned discovery groups/);
});

test("all desired groups are checked before any write, and concurrent changes stop apply", async () => {
  const config = configuration();
  config.discoveryGroups.push({ ...config.discoveryGroups[0], name: "second" });
  const h = harness(config, { existing: true });
  const desired = desiredDiscoveryGroups(config);
  h.groups.set(desired[1].name, { ...desired[1], description: "foreign" });
  await assert.rejects(executeEasm("discovery-apply", h.config, { ...h.options, yes: true, approveDiscovery: true }), /foreign/);
  assert.equal(h.writes.length, 0);
  let reads = 0;
  const racing = harness(undefined, { existing: true, fetchOverride: (url, request, state, groups) => {
    if (request.method === "GET" && new URL(url).pathname.endsWith(`/discoGroups/${desired[0].name}`) && ++reads === 2) {
      groups.set(desired[0].name, { ...desired[0], description: "foreign concurrent owner" });
    }
  } });
  await assert.rejects(executeEasm("discovery-apply", racing.config, { ...racing.options, yes: true, approveDiscovery: true }), /ownership changed/);
  assert.equal(racing.writes.length, 0);
});

test("explicit one-time runs do not overlap and never assert completed discovery", async () => {
  const h = harness(undefined, { existing: true });
  await executeEasm("discovery-apply", h.config, { ...h.options, yes: true, approveDiscovery: true });
  const result = await executeEasm("run-discovery", h.config, { ...h.options, yes: true, approveDiscovery: true });
  assert.equal(result.submittedGroups, 1);
  assert.equal(result.discoveryCompletion, "not asserted");
  await assert.rejects(executeEasm("run-discovery", h.config, { ...h.options, yes: true, approveDiscovery: true }), /already pending/);
  assert.equal(h.writes.filter((write) => write.method === "POST").length, 1);
  h.groups.values().next().value.latestRun = { state: "failed" };
  await assert.rejects(executeEasm("verify", h.config, h.options), /discovery run failed/);
});

test("collection paging preserves the route and refuses cycles or hostile continuation hosts", async () => {
  const calls = [];
  const client = createApiClient({
    base: "https://example.invalid/workspace", scope: "unused", getToken: async () => DATA_TOKEN,
    assertUrl: (url) => assert.equal(new URL(url).origin, "https://example.invalid"),
    fetcher: async (url) => {
      calls.push(url);
      return Response.json(calls.length === 1 ? { value: [1], nextLink: "?page=2" } : { value: [2] });
    },
  });
  assert.deepEqual(await client.collection("discoGroups?page=1"), [1, 2]);
  assert.equal(new URL(calls[1]).pathname, "/workspace/discoGroups");
  const hostile = createApiClient({
    base: "https://example.invalid/workspace", scope: "unused", getToken: async () => DATA_TOKEN,
    assertUrl: (url) => { if (new URL(url).origin !== "https://example.invalid") throw new Error("blocked continuation"); },
    fetcher: async () => Response.json({ value: [], nextLink: "https://evil.invalid/collect" }),
  });
  await assert.rejects(hostile.collection("discoGroups"), /blocked continuation/);
});

test("manual workflow pins actions, separates scan approval, and never falls back from a missing read identity", () => {
  const workflow = readFileSync(new URL("../.github/workflows/shared-easm.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /default: plan/);
  assert.match(workflow, /Separate discovery authorization is required/);
  assert.match(workflow, /vars\[\(inputs\.operation == 'verify' \|\| inputs\.operation == 'discovery-plan'\) && 'AZURE_READ_CLIENT_ID' \|\| 'AZURE_CLIENT_ID'\]/);
  for (const [, action] of workflow.matchAll(/^\s+(?:-\s+)?uses:\s+(\S+)/gm)) {
    assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  }
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /AZURE_CONFIG_DIR=/);
  assert.match(workflow, /EASM_CONFIG_JSON: \$\{\{ secrets\.EASM_CONFIG_JSON \}\}/);
  assert.doesNotMatch(workflow, /vars\.EASM_CONFIG_JSON/);
  assert.match(workflow, /run-name: Shared EASM - \$\{\{ inputs\.environment \}\} - \$\{\{ inputs\.operation \}\} - \$\{\{ inputs\.request_id \}\}/);
  assert.match(workflow, /EASM_REQUEST_ID: \$\{\{ inputs\.request_id \}\}/);
});
