import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const graphRoot = "https://graph.microsoft.com/v1.0/";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schema = JSON.parse(
  readFileSync(
    new URL("../schema/public-client.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

export function validateManifest(manifest) {
  if (!validate(manifest))
    throw new Error(
      `Invalid public-client manifest: ${ajv.errorsText(validate.errors)}`,
    );
  if (
    new Set(
      manifest.permissions.map((item) => item.resourceAppId.toLowerCase()),
    ).size !== manifest.permissions.length
  ) {
    throw new Error("Duplicate resource application IDs are not allowed.");
  }
  for (const uri of manifest.redirectUris) {
    const parsed = new URL(uri);
    if (!parsed.port || Number(parsed.port) > 65535)
      throw new Error("Invalid loopback redirect port.");
  }
  return manifest;
}

export function desiredApplication(manifest, resources) {
  validateManifest(manifest);
  const requiredResourceAccess = manifest.permissions.map((permission) => {
    const resource = resources.find(
      (item) =>
        item.appId.toLowerCase() === permission.resourceAppId.toLowerCase(),
    );
    if (!resource)
      throw new Error(
        `Resource service principal missing: ${permission.resourceAppId}`,
      );
    const resourceAccess = permission.scopes.map((value) => {
      const matches = (resource.oauth2PermissionScopes ?? []).filter(
        (scope) => scope.value === value && scope.isEnabled,
      );
      if (matches.length !== 1 || !uuid.test(matches[0].id))
        throw new Error(`Delegated scope unavailable or ambiguous: ${value}`);
      return { id: matches[0].id, type: "Scope" };
    });
    return { resourceAppId: permission.resourceAppId, resourceAccess };
  });
  return {
    displayName: manifest.displayName,
    description: manifest.description,
    signInAudience: "AzureADMultipleOrgs",
    isFallbackPublicClient: true,
    publicClient: { redirectUris: manifest.redirectUris },
    requiredResourceAccess,
    tags: [`pawprint-public-client:${manifest.key}`],
    info: manifest.info,
  };
}

function canonical(value) {
  if (Array.isArray(value))
    return value
      .map(canonical)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function planApplication(desired, applications) {
  const tag = desired.tags[0];
  const matches = applications.filter((app) => app.tags?.includes(tag));
  if (matches.length > 1)
    throw new Error(
      "Multiple applications carry the managed ownership tag. Resolve manually.",
    );
  const current = matches[0];
  if (!current) {
    if (applications.some((app) => app.displayName === desired.displayName))
      throw new Error(
        "An unmanaged application has the same display name. Refusing adoption.",
      );
    return { action: "create", body: desired };
  }
  if (!uuid.test(current.id) || !uuid.test(current.appId))
    throw new Error("Managed application identifiers are invalid.");
  if (
    current.passwordCredentials?.length ||
    current.keyCredentials?.length ||
    current.web?.redirectUris?.length ||
    current.spa?.redirectUris?.length ||
    current.appRoles?.length ||
    current.api?.oauth2PermissionScopes?.length
  ) {
    throw new Error(
      "Managed app has confidential-client or resource-server configuration. Manual review required.",
    );
  }
  for (const resource of current.requiredResourceAccess ?? []) {
    const expected = desired.requiredResourceAccess.find(
      (item) => item.resourceAppId === resource.resourceAppId,
    );
    if (
      !expected ||
      resource.resourceAccess.some(
        (grant) =>
          !expected.resourceAccess.some(
            (item) => item.id === grant.id && item.type === grant.type,
          ),
      )
    ) {
      throw new Error(
        "Existing app has additional permissions. Refusing to remove or silently preserve unexpected grants.",
      );
    }
  }
  const body = {};
  for (const [key, value] of Object.entries(desired)) {
    const next =
      key === "tags"
        ? [...new Set([...(current.tags ?? []), ...value])]
        : value;
    const actual =
      key === "info"
        ? Object.fromEntries(
            Object.keys(value).map((field) => [field, current.info?.[field]]),
          )
        : current[key];
    if (!isDeepStrictEqual(canonical(actual), canonical(next)))
      body[key] = next;
  }
  return {
    action: Object.keys(body).length ? "update" : "found",
    id: current.id,
    clientId: current.appId,
    body,
  };
}

export function assertGraphUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== "https://graph.microsoft.com" ||
    !url.pathname.startsWith("/v1.0/") ||
    url.username ||
    url.password
  )
    throw new Error("Refusing non-Graph URL.");
  return url.href;
}

export async function provisionPublicClient({
  manifest,
  tenantId,
  activeTenantId,
  mode,
  request,
}) {
  validateManifest(manifest);
  if (
    !uuid.test(tenantId) ||
    tenantId.toLowerCase() !== activeTenantId?.toLowerCase()
  )
    throw new Error(
      "Explicit publisher tenant must match the active Azure CLI tenant.",
    );
  if (!["plan", "apply"].includes(mode))
    throw new Error("Expected plan or apply.");
  async function list(url) {
    const items = [];
    const visited = new Set();
    while (url) {
      url = assertGraphUrl(url);
      if (visited.has(url) || visited.size >= 1000)
        throw new Error("Graph pagination exceeded its safe bound.");
      visited.add(url);
      const page = await request("GET", url);
      if (!Array.isArray(page.value))
        throw new Error("Invalid Graph collection response.");
      items.push(...page.value);
      url = page["@odata.nextLink"];
    }
    return items;
  }
  const resources = [];
  for (const permission of manifest.permissions) {
    const url = new URL(`${graphRoot}servicePrincipals`);
    url.searchParams.set("$filter", `appId eq '${permission.resourceAppId}'`);
    url.searchParams.set("$select", "appId,oauth2PermissionScopes");
    const matches = await list(url.href);
    if (matches.length !== 1)
      throw new Error("Expected exactly one resource service principal.");
    resources.push(matches[0]);
  }
  const desired = desiredApplication(manifest, resources);
  const applicationsUrl = new URL(`${graphRoot}applications`);
  applicationsUrl.searchParams.set(
    "$select",
    "id,appId,displayName,description,tags,signInAudience,isFallbackPublicClient,publicClient,requiredResourceAccess,info,passwordCredentials,keyCredentials,web,spa,appRoles,api",
  );
  const plan = planApplication(desired, await list(applicationsUrl.href));
  if (mode === "plan")
    return { ...plan, tenantId, permissions: manifest.permissions };
  let id = plan.id;
  if (plan.action === "create")
    id = (await request("POST", `${graphRoot}applications`, plan.body)).id;
  if (plan.action === "update")
    await request("PATCH", `${graphRoot}applications/${id}`, plan.body);
  if (!uuid.test(id))
    throw new Error("Graph did not return a valid application object ID.");
  const observed = await request("GET", `${graphRoot}applications/${id}`);
  if (planApplication(desired, [observed]).action !== "found")
    throw new Error(
      "Read-back verification failed; rerun plan before retrying apply.",
    );
  return {
    action: plan.action,
    tenantId,
    objectId: id,
    clientId: observed.appId,
    verified: true,
  };
}

function azJson(args) {
  if (args.some((arg) => !/^[A-Za-z0-9._:/=-]+$/.test(arg)))
    throw new Error("Unsafe Azure CLI argument.");
  return JSON.parse(
    execFileSync(process.platform === "win32" ? "az.cmd" : "az", args, {
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      tenant: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const [mode] = positionals;
  if (
    positionals.length !== 1 ||
    !["validate", "plan", "apply"].includes(mode) ||
    !values.config
  )
    throw new Error(
      "Usage: node scripts/publisher-public-client.mjs validate|plan|apply --config <manifest> [--tenant <publisher-tenant-id>] [--yes]",
    );
  const manifest = validateManifest(
    JSON.parse(readFileSync(resolve(values.config), "utf8")),
  );
  if (mode === "validate") {
    console.log("Public-client manifest valid (offline; no changes).");
    return;
  }
  if (!uuid.test(values.tenant ?? ""))
    throw new Error("An explicit publisher tenant UUID is required.");
  if (mode === "apply" && !values.yes)
    throw new Error("Apply requires --yes after reviewing the plan.");
  const active = azJson(["account", "show", "--output", "json"]);
  if (active.tenantId?.toLowerCase() !== values.tenant.toLowerCase())
    throw new Error("Active Azure CLI tenant does not match --tenant.");
  const token = azJson([
    "account",
    "get-access-token",
    "--tenant",
    values.tenant,
    "--resource",
    "https://graph.microsoft.com/",
    "--output",
    "json",
  ]);
  const request = async (method, url, body) => {
    const response = await fetch(assertGraphUrl(url), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `Graph ${method} failed (${response.status}); check directory permissions and tenant policy.`,
      );
    return response.status === 204 ? undefined : response.json();
  };
  console.log(
    JSON.stringify(
      await provisionPublicClient({
        manifest,
        tenantId: values.tenant,
        activeTenantId: active.tenantId,
        mode,
        request,
      }),
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    process.stderr.write(
      "Public-client operation failed. Verify manifest, explicit tenant, directory access, and plan before applying. No tokens or raw provider responses are logged.\n",
    );
    process.exitCode = 1;
  });
}
