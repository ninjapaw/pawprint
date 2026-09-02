import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createGitHubAppManifest,
  GITHUB_APP_NAME,
  GITHUB_APP_PERMISSIONS,
  GITHUB_APP_REPOSITORIES,
  GITHUB_ORGANIZATION,
  inspectInstallation,
  validateManifestConversion,
} from "./github-app-setup.mjs";

const executeFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const config = JSON.parse(
  readFileSync(join(root, "config", "portal.json"), "utf8"),
);
const platformConnectorCatalog = JSON.parse(
  readFileSync(
    join(root, "config", "platform-connectors.catalog.json"),
    "utf8",
  ),
);
const host = "127.0.0.1";
const port = Number.parseInt(process.env.PAWPRINT_PORT ?? "4173", 10);
const origin = `http://${host}:${port}`;
const authority = `${host}:${port}`;
const jobs = new Map();
const setupStates = new Map();
const installationStates = new Map();
let pendingGitHubApp = null;
const portalResourceGroup = "NP-Platform-Dev-CentralUS";
const portalFunctionApp = "np-pawprint-api-dev-centralus";
const portalKeyVault = "np-pawprint-dev-kv";
const portalRepository = "ninjapaw/pawprint";
const cloudflareRepository = "ninjapaw/site";
const cloudflareZoneName = "ninjapaws.org";
const cloudflareEnvironments = ["dev", "prod"];
const cloudflareAccountTokenUrl =
  "https://dash.cloudflare.com/?to=/:account/api-tokens";
const edgePath =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const setupPlanPath = join(root, ".pawprint-setup-plan.json");
let azureManagementToken = null;
const contentSecurityPolicy =
  "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://api.github.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://github.com";
const command = (name) => {
  if (process.platform !== "win32") return name;
  return name === "az" ? "az.cmd" : `${name}.exe`;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("PAWPRINT_PORT must be an unprivileged TCP port.");
}

if (config.environment !== "dev" || !Array.isArray(config.workloads)) {
  throw new Error(
    "Portal configuration must declare the dev workload allowlist.",
  );
}
for (const workload of config.workloads) {
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(workload.id) ||
    !/^ninjapaw\/[a-z0-9][a-z0-9-]*$/.test(workload.repository) ||
    !/^[a-zA-Z0-9._-]+\.ya?ml$/.test(workload.statusWorkflow) ||
    new URL(workload.siteUrl).protocol !== "https:"
  ) {
    throw new Error(
      `Unsafe portal configuration for '${workload.id ?? "unknown"}'.`,
    );
  }
  for (const step of workload.steps ?? []) {
    if (!/^[a-zA-Z0-9._-]+\.ya?ml$/.test(step.workflow)) {
      throw new Error(`Unsafe workflow name for '${workload.id}'.`);
    }
    for (const [name, value] of Object.entries(step.inputs ?? {})) {
      if (
        !/^[a-zA-Z0-9._-]+$/.test(name) ||
        !/^[a-zA-Z0-9._-]+$/.test(String(value))
      ) {
        throw new Error(`Unsafe workflow input for '${workload.id}'.`);
      }
    }
  }
}

if (!existsSync(join(dist, "index.html"))) {
  process.stderr.write(
    "Portal build not found. Run npm run portal:build first.\n",
  );
  process.exit(1);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function run(name, args, timeout = 120000) {
  try {
    const result = await executeFile(command(name), args, {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32" && name === "az",
      timeout,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    process.stderr.write(
      `[portal] ${name} command failed: ${error.stderr ?? error.message}\n`,
    );
    throw new Error(
      `${name} command failed. Review the portal terminal for details.`,
    );
  }
}

async function json(name, args) {
  return JSON.parse(await run(name, args));
}

async function optionalJson(name, args, fallback) {
  try {
    return await json(name, args);
  } catch {
    return fallback;
  }
}

async function optionalRun(name, args) {
  try {
    return await run(name, args);
  } catch {
    return null;
  }
}

async function azureManagementJson(path, options = {}) {
  if (!azureManagementToken) {
    azureManagementToken = await run("az", [
      "account",
      "get-access-token",
      "--resource",
      "https://management.azure.com/",
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ]);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`https://management.azure.com${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${azureManagementToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(60000),
    });
    if (response.ok) return response.json();
    if (response.status !== 429 || attempt === 4) {
      throw new Error(`Azure management query returned ${response.status}.`);
    }
    const retryAfter = Number(
      response.headers.get("retry-after") ?? attempt + 1,
    );
    await delay(Math.min(Math.max(retryAfter, 1), 60) * 1000);
  }
  throw new Error("Azure management query exhausted its retry limit.");
}

async function subscriptionCost(subscriptionId) {
  try {
    const cost = await azureManagementJson(
      `/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "ActualCost",
          timeframe: "MonthToDate",
          dataset: {
            granularity: "None",
            aggregation: { totalCost: { name: "Cost", function: "Sum" } },
          },
        }),
      },
    );
    const budgets = await azureManagementJson(
      `/subscriptions/${subscriptionId}/providers/Microsoft.Consumption/budgets?api-version=2023-11-01`,
    ).catch(() => ({ value: [] }));
    const columns = cost.properties?.columns ?? [];
    const row = cost.properties?.rows?.[0] ?? [];
    const valueIndex = columns.findIndex((column) => column.name === "Cost");
    const currencyIndex = columns.findIndex(
      (column) => column.name === "Currency",
    );
    const monthToDate = Number(row[valueIndex] ?? 0);
    const budget = (budgets.value ?? []).find(
      (candidate) => candidate.properties?.timeGrain === "Monthly",
    );
    const amount = budget ? Number(budget.properties.amount) : null;
    return {
      monthToDate,
      currency: row[currencyIndex] ?? "USD",
      budget: amount,
      remaining: amount === null ? null : amount - monthToDate,
    };
  } catch (error) {
    return {
      monthToDate: null,
      currency: null,
      budget: null,
      remaining: null,
      unavailableReason: error.message,
    };
  }
}

async function firstRunOverview() {
  const [subscriptions, locations] = await Promise.all([
    json("az", [
      "account",
      "list",
      "--query",
      "[?state=='Enabled'].{id:id,name:name,tenantId:tenantId,isDefault:isDefault}",
      "-o",
      "json",
    ]),
    json("az", [
      "account",
      "list-locations",
      "--query",
      "[?metadata.regionType=='Physical'].{name:name,displayName:displayName,regionalDisplayName:regionalDisplayName}",
      "-o",
      "json",
    ]),
  ]);
  let savedPlan = null;
  if (existsSync(setupPlanPath)) {
    try {
      savedPlan = JSON.parse(readFileSync(setupPlanPath, "utf8"));
    } catch {
      savedPlan = null;
    }
  }
  return { subscriptions, locations, savedPlan };
}

async function firstRunCost(subscriptionId) {
  const subscriptions = await json("az", [
    "account",
    "list",
    "--query",
    "[?state=='Enabled'].id",
    "-o",
    "json",
  ]);
  if (
    !subscriptions.some(
      (candidate) => candidate.toLowerCase() === subscriptionId.toLowerCase(),
    )
  ) {
    throw new HttpError(403, "The subscription is not accessible.");
  }
  return { subscriptionId, ...(await subscriptionCost(subscriptionId)) };
}

async function saveSetupPlan(plan) {
  const availableSubscriptions = await json("az", [
    "account",
    "list",
    "--query",
    "[?state=='Enabled'].id",
    "-o",
    "json",
  ]);
  const validSubscriptions = new Set(
    availableSubscriptions.map((id) => id.toLowerCase()),
  );
  const allowedEnvironments = new Set(["dev", "prod", "qa", "test"]);
  if (
    !Array.isArray(plan.environments) ||
    plan.environments.length < 1 ||
    plan.environments.some(
      (environment) => !allowedEnvironments.has(environment),
    ) ||
    new Set(plan.environments).size !== plan.environments.length ||
    !validSubscriptions.has(
      String(plan.managementSubscriptionId).toLowerCase(),
    ) ||
    !/^[a-z0-9]{2,40}$/.test(plan.defaultLocation ?? "") ||
    !/^[A-Za-z][A-Za-z0-9 -]{1,39}$/.test(plan.organizationName ?? "") ||
    !/^[A-Za-z][A-Za-z0-9 -]{1,39}$/.test(plan.platformName ?? "") ||
    !/^[A-Za-z0-9]{1,6}$/.test(plan.organizationPrefix ?? "") ||
    !Array.isArray(plan.connectors) ||
    plan.connectors.some(
      (connector) => !platformConnectorCatalog.connectors[connector],
    ) ||
    typeof plan.allowRecreate !== "boolean"
  ) {
    throw new HttpError(400, "The first-run plan is incomplete or invalid.");
  }
  for (const environment of plan.environments) {
    const subscriptionId =
      plan.environmentOverrides?.[environment]?.subscriptionId ||
      plan.managementSubscriptionId;
    const location =
      plan.environmentOverrides?.[environment]?.location ||
      plan.defaultLocation;
    if (
      !validSubscriptions.has(String(subscriptionId).toLowerCase()) ||
      !/^[a-z0-9]{2,40}$/.test(location)
    ) {
      throw new HttpError(
        400,
        `Invalid ${environment} subscription or location.`,
      );
    }
  }
  const saved = {
    planVersion: "1.0.0",
    savedAt: new Date().toISOString(),
    environments: plan.environments,
    managementSubscriptionId: plan.managementSubscriptionId,
    defaultLocation: plan.defaultLocation,
    environmentOverrides: plan.environmentOverrides ?? {},
    organizationName: plan.organizationName.trim(),
    organizationPrefix: String(plan.organizationPrefix ?? "").toUpperCase(),
    platformName: plan.platformName.trim(),
    namingPrompt: String(plan.namingPrompt ?? "").slice(0, 500),
    allowRecreate: plan.allowRecreate,
    tags: plan.tags ?? {},
    connectors: plan.connectors ?? [],
  };
  writeFileSync(setupPlanPath, `${JSON.stringify(saved, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return saved;
}

async function runWithInput(name, args, input, timeout = 120000) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command(name), args, {
      cwd: root,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun();
      } else {
        process.stderr.write(`[portal] ${name} command failed: ${stderr}\n`);
        rejectRun(
          new Error(
            `${name} command failed. Review the portal terminal for details.`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

function temporaryVaultAssignmentName(vaultId, userObjectId) {
  const hex = createHash("sha256")
    .update(`pawprint-portal:${vaultId}:${userObjectId}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function deleteTemporaryVaultAssignment(vaultId, userObjectId) {
  const assignmentId = `${vaultId}/providers/Microsoft.Authorization/roleAssignments/${temporaryVaultAssignmentName(vaultId, userObjectId)}`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await optionalRun("az", [
      "role",
      "assignment",
      "delete",
      "--ids",
      assignmentId,
    ]);
    const remaining = await json("az", [
      "role",
      "assignment",
      "list",
      "--scope",
      vaultId,
      "--assignee-object-id",
      userObjectId,
      "-o",
      "json",
    ]);
    if (
      !remaining.some(
        (assignment) =>
          assignment.id?.toLowerCase() === assignmentId.toLowerCase(),
      )
    ) {
      return;
    }
    await delay(3000);
  }
  throw new Error("Temporary Key Vault role assignment could not be removed.");
}

async function recoverTemporaryVaultAssignment() {
  const userObjectId = await run("az", [
    "ad",
    "signed-in-user",
    "show",
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  const vaultId = await run("az", [
    "keyvault",
    "show",
    "--name",
    portalKeyVault,
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  await deleteTemporaryVaultAssignment(vaultId, userObjectId);
}

async function setupOverview() {
  const [
    membership,
    variables,
    installations,
    account,
    functionSettings,
    cloudflareDevSecrets,
    cloudflareProdSecrets,
    cloudflareVariables,
    cloudflareWorkflow,
  ] = await Promise.all([
    optionalJson(
      "gh",
      ["api", `user/memberships/orgs/${GITHUB_ORGANIZATION}`],
      null,
    ),
    optionalJson(
      "gh",
      [
        "variable",
        "list",
        "--env",
        "dev",
        "--repo",
        portalRepository,
        "--json",
        "name,value",
      ],
      [],
    ),
    optionalJson("gh", ["api", `orgs/${GITHUB_ORGANIZATION}/installations`], {
      installations: [],
    }),
    json("az", [
      "account",
      "show",
      "--query",
      "{name:name,id:id,tenantId:tenantId}",
      "-o",
      "json",
    ]),
    optionalJson(
      "az",
      [
        "functionapp",
        "config",
        "appsettings",
        "list",
        "--resource-group",
        portalResourceGroup,
        "--name",
        portalFunctionApp,
        "-o",
        "json",
      ],
      [],
    ),
    optionalJson(
      "gh",
      [
        "secret",
        "list",
        "--env",
        "dev",
        "--repo",
        cloudflareRepository,
        "--json",
        "name",
      ],
      [],
    ),
    optionalJson(
      "gh",
      [
        "secret",
        "list",
        "--env",
        "prod",
        "--repo",
        cloudflareRepository,
        "--json",
        "name",
      ],
      [],
    ),
    optionalJson(
      "gh",
      [
        "variable",
        "list",
        "--env",
        "dev",
        "--repo",
        cloudflareRepository,
        "--json",
        "name,value",
      ],
      [],
    ),
    optionalRun("gh", [
      "api",
      "-X",
      "GET",
      `repos/${cloudflareRepository}/contents/.github/workflows/deploy-azure-infrastructure.yml`,
      "-f",
      "ref=dev",
      "-H",
      "Accept: application/vnd.github.raw+json",
    ]),
  ]);
  const variableMap = Object.fromEntries(
    variables.map((variable) => [variable.name, variable.value]),
  );
  const appSlug =
    variableMap.PAWPRINT_GITHUB_APP_SLUG ?? pendingGitHubApp?.slug;
  const installationId = variableMap.PAWPRINT_GITHUB_APP_INSTALLATION_ID;
  const installed = installations.installations?.find(
    (installation) => installation.app_slug === appSlug,
  );
  const enabled =
    functionSettings
      .find((setting) => setting.name === "GITHUB_APP_ENABLED")
      ?.value?.toLowerCase() === "true";
  const cloudflareVariableMap = Object.fromEntries(
    cloudflareVariables.map((variable) => [variable.name, variable.value]),
  );

  return {
    organization: GITHUB_ORGANIZATION,
    appName: GITHUB_APP_NAME,
    requiredPermissions: GITHUB_APP_PERMISSIONS,
    requiredRepositories: GITHUB_APP_REPOSITORIES,
    github: {
      membershipState: membership?.state ?? "unknown",
      organizationRole: membership?.role ?? "unknown",
      canCreateApp:
        membership?.state === "active" && membership?.role === "admin",
    },
    azure: {
      subscription: account.name,
      subscriptionId: account.id,
      tenantId: account.tenantId,
      keyVault: portalKeyVault,
      functionApp: portalFunctionApp,
    },
    app: {
      id: variableMap.PAWPRINT_GITHUB_APP_ID ?? pendingGitHubApp?.id ?? null,
      slug: appSlug ?? null,
      installationId: installationId ?? installed?.id ?? null,
      enabled,
      installed: Boolean(installed || installationId),
      repositorySelection: installed?.repository_selection ?? null,
      permissions: installed?.permissions ?? null,
      pendingInstallation: Boolean(pendingGitHubApp && !installationId),
    },
    cloudflare: {
      repository: cloudflareRepository,
      zoneName: cloudflareZoneName,
      environments: {
        dev: cloudflareDevSecrets.some(
          (secret) => secret.name === "CLOUDFLARE_API_TOKEN",
        ),
        prod: cloudflareProdSecrets.some(
          (secret) => secret.name === "CLOUDFLARE_API_TOKEN",
        ),
      },
      tokenExpiresOn:
        cloudflareVariableMap.CLOUDFLARE_TOKEN_EXPIRES_ON ?? "unknown",
      workflowReady:
        cloudflareWorkflow?.includes("connect-cloudflare-dns") === true &&
        cloudflareWorkflow?.includes("Converge custom domain with Bicep") ===
          true,
    },
  };
}

async function platformOverview() {
  const account = await json("az", [
    "account",
    "show",
    "--query",
    "{name:name,id:id,tenantId:tenantId}",
    "-o",
    "json",
  ]);
  const operator = await optionalJson(
    "az",
    [
      "ad",
      "signed-in-user",
      "show",
      "--query",
      "{id:id,displayName:displayName,userPrincipalName:userPrincipalName}",
      "-o",
      "json",
    ],
    null,
  );
  const [
    securityConnectorResponse,
    servicePrincipalResponse,
    enterprises,
    roleAssignments,
    directoryRoleResponse,
    cloudflareSecrets,
  ] = await Promise.all([
    optionalJson(
      "az",
      [
        "rest",
        "--method",
        "GET",
        "--url",
        `https://management.azure.com/subscriptions/${account.id}/providers/Microsoft.Security/securityConnectors?api-version=2024-08-01-preview`,
        "-o",
        "json",
      ],
      { value: [] },
    ),
    optionalJson(
      "az",
      [
        "rest",
        "--method",
        "GET",
        "--url",
        "https://graph.microsoft.com/v1.0/servicePrincipals?$select=id,displayName,accountEnabled,appRoleAssignmentRequired",
        "-o",
        "json",
      ],
      { value: [] },
    ),
    optionalJson(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        "query=query { viewer { enterprises(first: 100) { nodes { slug name } } } }",
        "--jq",
        ".data.viewer.enterprises.nodes",
      ],
      null,
    ),
    operator
      ? optionalJson(
          "az",
          [
            "role",
            "assignment",
            "list",
            "--assignee-object-id",
            operator.id,
            "--all",
            "--query",
            "[].{role:roleDefinitionName,scope:scope}",
            "-o",
            "json",
          ],
          [],
        )
      : [],
    optionalJson(
      "az",
      [
        "rest",
        "--method",
        "GET",
        "--url",
        "https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.directoryRole?$select=displayName",
        "-o",
        "json",
      ],
      { value: [] },
    ),
    optionalJson(
      "gh",
      [
        "secret",
        "list",
        "--env",
        "dev",
        "--repo",
        cloudflareRepository,
        "--json",
        "name",
      ],
      [],
    ),
  ]);

  const securityConnectors = securityConnectorResponse.value ?? [];
  const servicePrincipals = servicePrincipalResponse.value ?? [];
  const authorization = new Map();
  await Promise.all(
    securityConnectors
      .filter((connector) =>
        ["github", "azuredevops", "gitlab"].includes(
          connector.properties?.environmentName?.toLowerCase(),
        ),
      )
      .map(async (connector) => {
        const devops = await optionalJson(
          "az",
          [
            "rest",
            "--method",
            "GET",
            "--url",
            `https://management.azure.com${connector.id}/devops/default?api-version=2024-04-01`,
            "-o",
            "json",
          ],
          null,
        );
        authorization.set(connector.id.toLowerCase(), Boolean(devops));
      }),
  );

  const inventory = Object.entries(platformConnectorCatalog.connectors).map(
    ([id, connector]) => {
      let matches = [];
      let detectionAvailable = true;
      if (connector.detect.kind === "azure-security-connector") {
        matches = securityConnectors.filter(
          (candidate) =>
            candidate.properties?.environmentName?.toLowerCase() ===
            connector.detect.environmentName?.toLowerCase(),
        );
      } else if (connector.detect.kind === "graph-service-principal") {
        matches = servicePrincipals.filter((candidate) =>
          candidate.displayName
            ?.toLowerCase()
            .includes(connector.detect.displayName.toLowerCase()),
        );
      } else if (connector.detect.kind === "github-enterprise") {
        detectionAvailable = Array.isArray(enterprises);
        matches = detectionAvailable ? enterprises : [];
      } else if (connector.detect.kind === "github-environment-secret") {
        matches = cloudflareSecrets.some(
          (secret) => secret.name === "CLOUDFLARE_API_TOKEN",
        )
          ? [{ name: "CLOUDFLARE_API_TOKEN", managed: true }]
          : [];
      }

      const authorized = matches.every((match) =>
        match.id && authorization.has(match.id.toLowerCase())
          ? authorization.get(match.id.toLowerCase())
          : true,
      );
      const managed = matches.some(
        (match) =>
          match.managed === true ||
          match.tags?.managedBy?.toLowerCase() === "bicep",
      );
      const azureRoleNames = roleAssignments.map(
        (assignment) => assignment.role,
      );
      const directoryRoleNames = (directoryRoleResponse.value ?? []).map(
        (role) => role.displayName,
      );
      const canManageAzure = azureRoleNames.some((role) =>
        ["Owner", "Contributor", "Security Admin"].includes(role),
      );
      const canManageDirectory = directoryRoleNames.some((role) =>
        [
          "Global Administrator",
          "Application Administrator",
          "Cloud Application Administrator",
        ].includes(role),
      );
      return {
        id,
        ...connector,
        state: !detectionAvailable
          ? "unavailable"
          : matches.length === 0
            ? "eligible"
            : !authorized
              ? "needs-action"
              : managed
                ? "managed"
                : "pre-existing",
        authorized,
        canManage:
          connector.category === "identity"
            ? canManageDirectory
            : connector.category === "defender"
              ? canManageAzure
              : false,
        resources: matches.map((match) => ({
          id: match.id ?? null,
          name: match.name ?? match.displayName ?? match.slug ?? "present",
          enabled: match.accountEnabled ?? true,
        })),
      };
    },
  );

  return {
    scannedAt: new Date().toISOString(),
    subscription: account,
    operator,
    access: {
      azureRoles: roleAssignments,
      directoryRoles: directoryRoleResponse.value ?? [],
      hasOwnerRole: roleAssignments.some(
        (assignment) => assignment.role === "Owner",
      ),
      canManageAzure: roleAssignments.some((assignment) =>
        ["Owner", "Contributor", "Security Admin"].includes(assignment.role),
      ),
      canManageDirectory: (directoryRoleResponse.value ?? []).some((role) =>
        [
          "Global Administrator",
          "Application Administrator",
          "Cloud Application Administrator",
        ].includes(role.displayName),
      ),
      recommendedReadRoles: ["Security Reader", "Directory Readers"],
      recommendedManageRoles: [
        "Security Admin",
        "Cloud Application Administrator",
        "Groups Administrator",
      ],
    },
    inventory,
  };
}

async function deployPlatformConnectors(preview) {
  const args = [
    "deployment",
    "sub",
    preview ? "what-if" : "create",
    "--name",
    preview
      ? "pawprint-platform-connectors-preview"
      : "pawprint-platform-connectors",
    "--location",
    "centralus",
    "--template-file",
    "infra/platform-connectors/main.bicep",
    "--parameters",
    "infra/platform-connectors/main.dev.bicepparam",
    "--output",
    "none",
  ];
  await run("az", args, 1200000);
  return preview
    ? "Platform connector Bicep preview completed. Review the portal terminal before applying."
    : "All declared platform connectors converged through Bicep.";
}

function platformConnector(connectorId) {
  const connector = platformConnectorCatalog.connectors[connectorId];
  if (
    !connector ||
    connector.category !== "identity" ||
    connector.detect.kind !== "graph-service-principal"
  ) {
    throw new HttpError(400, "Select a supported Entra gallery connector.");
  }
  return connector;
}

async function findGalleryServicePrincipal(connectorId) {
  const connector = platformConnector(connectorId);
  const response = await optionalJson(
    "az",
    [
      "rest",
      "--method",
      "GET",
      "--url",
      "https://graph.microsoft.com/v1.0/servicePrincipals?$select=id,displayName,accountEnabled,appRoleAssignmentRequired,appRoles",
      "-o",
      "json",
    ],
    { value: [] },
  );
  return (response.value ?? []).find((servicePrincipal) =>
    servicePrincipal.displayName
      ?.toLowerCase()
      .includes(connector.detect.displayName.toLowerCase()),
  );
}

async function canManageDirectory() {
  const response = await optionalJson(
    "az",
    [
      "rest",
      "--method",
      "GET",
      "--url",
      "https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.directoryRole?$select=displayName",
      "-o",
      "json",
    ],
    { value: [] },
  );
  return (response.value ?? []).some((role) =>
    [
      "Global Administrator",
      "Application Administrator",
      "Cloud Application Administrator",
    ].includes(role.displayName),
  );
}

async function enterpriseAppAccess(connectorId) {
  const servicePrincipal = await findGalleryServicePrincipal(connectorId);
  if (!servicePrincipal) {
    return {
      provisioned: false,
      canManage: await canManageDirectory(),
      assignments: [],
      principals: [],
      appRoles: [],
    };
  }
  const [assignments, users, groups, manageable] = await Promise.all([
    optionalJson(
      "az",
      [
        "rest",
        "--method",
        "GET",
        "--url",
        `https://graph.microsoft.com/v1.0/servicePrincipals/${servicePrincipal.id}/appRoleAssignedTo?$select=id,principalId,principalDisplayName,principalType,appRoleId`,
        "-o",
        "json",
      ],
      { value: [] },
    ),
    optionalJson(
      "az",
      [
        "rest",
        "--method",
        "GET",
        "--url",
        "https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,accountEnabled",
        "-o",
        "json",
      ],
      { value: [] },
    ),
    optionalJson(
      "az",
      [
        "rest",
        "--method",
        "GET",
        "--url",
        "https://graph.microsoft.com/v1.0/groups?$select=id,displayName,securityEnabled",
        "-o",
        "json",
      ],
      { value: [] },
    ),
    canManageDirectory(),
  ]);
  return {
    provisioned: true,
    canManage: manageable,
    servicePrincipal: {
      id: servicePrincipal.id,
      displayName: servicePrincipal.displayName,
      accountEnabled: servicePrincipal.accountEnabled,
      assignmentRequired: servicePrincipal.appRoleAssignmentRequired,
    },
    assignments: assignments.value ?? [],
    principals: [
      ...(users.value ?? [])
        .filter((user) => user.accountEnabled !== false)
        .map((user) => ({
          id: user.id,
          type: "User",
          label: `${user.displayName} (${user.userPrincipalName})`,
        })),
      ...(groups.value ?? [])
        .filter((group) => group.securityEnabled === true)
        .map((group) => ({
          id: group.id,
          type: "Group",
          label: group.displayName,
        })),
    ].sort((left, right) => left.label.localeCompare(right.label)),
    appRoles: (servicePrincipal.appRoles ?? [])
      .filter(
        (role) =>
          role.isEnabled !== false && role.allowedMemberTypes?.includes("User"),
      )
      .map((role) => ({ id: role.id, label: role.displayName ?? role.value })),
  };
}

async function updateEnterpriseAppAccess(connectorId, operation, body) {
  if (!(await canManageDirectory())) {
    throw new HttpError(
      403,
      "Cloud Application Administrator or Application Administrator is required.",
    );
  }
  const servicePrincipal = await findGalleryServicePrincipal(connectorId);
  if (!servicePrincipal) {
    throw new HttpError(409, "Instantiate or adopt the gallery app first.");
  }

  if (operation === "assign") {
    if (
      !/^[0-9a-f-]{36}$/i.test(body.principalId ?? "") ||
      !/^[0-9a-f-]{36}$/i.test(body.appRoleId ?? "")
    ) {
      throw new HttpError(400, "Select a valid Entra principal and app role.");
    }
    const principal = await optionalJson(
      "az",
      [
        "rest",
        "--method",
        "GET",
        "--url",
        `https://graph.microsoft.com/v1.0/directoryObjects/${body.principalId}`,
        "-o",
        "json",
      ],
      null,
    );
    if (
      !principal ||
      !["#microsoft.graph.user", "#microsoft.graph.group"].includes(
        principal["@odata.type"],
      )
    ) {
      throw new HttpError(400, "Only Entra users and groups can be assigned.");
    }
    const validRoles = new Set(
      (servicePrincipal.appRoles ?? [])
        .filter((role) => role.isEnabled !== false)
        .map((role) => role.id),
    );
    if (!validRoles.has(body.appRoleId)) {
      throw new HttpError(400, "The selected app role is not available.");
    }
    await run("az", [
      "rest",
      "--method",
      "POST",
      "--url",
      `https://graph.microsoft.com/v1.0/servicePrincipals/${servicePrincipal.id}/appRoleAssignedTo`,
      "--body",
      JSON.stringify({
        principalId: body.principalId,
        resourceId: servicePrincipal.id,
        appRoleId: body.appRoleId,
      }),
      "--output",
      "none",
    ]);
    return "Entra application access assigned.";
  }

  if (!/^[0-9a-f-]{36}$/i.test(body.assignmentId ?? "")) {
    throw new HttpError(400, "Select a valid assignment to remove.");
  }
  await run("az", [
    "rest",
    "--method",
    "DELETE",
    "--url",
    `https://graph.microsoft.com/v1.0/servicePrincipals/${servicePrincipal.id}/appRoleAssignedTo/${body.assignmentId}`,
    "--output",
    "none",
  ]);
  return "Entra application access removed.";
}

function assertLocalPost(request) {
  if (
    request.headers.origin !== origin ||
    request.headers["content-type"] !== "application/json"
  ) {
    throw new HttpError(
      403,
      "Setup actions require the local PawPrint Portal.",
    );
  }
}

async function setGitHubVariable(name, value) {
  if (
    !/^[A-Z][A-Z0-9_]+$/.test(name) ||
    !/^[A-Za-z0-9._-]+$/.test(String(value))
  ) {
    throw new Error("Refusing an unsafe GitHub variable.");
  }
  await setGitHubEnvironmentVariable(portalRepository, "dev", name, value);
}

async function setGitHubEnvironmentVariable(
  repository,
  environment,
  name,
  value,
) {
  if (
    !/^ninjapaw\/[a-z0-9-]+$/.test(repository) ||
    !/^[a-z][a-z0-9-]*$/.test(environment) ||
    !/^[A-Z][A-Z0-9_]+$/.test(name) ||
    !/^[A-Za-z0-9:._+-]+$/.test(String(value))
  ) {
    throw new Error("Refusing an unsafe GitHub Environment variable.");
  }
  await run("gh", [
    "variable",
    "set",
    name,
    "--env",
    environment,
    "--repo",
    repository,
    "--body",
    String(value),
  ]);
}

async function cloudflareJson(path, token, method = "GET", body = null) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    throw new HttpError(
      400,
      "Cloudflare rejected the token or its zone permissions.",
    );
  }
  return payload;
}

async function cloudflareZone(token) {
  const zones = await cloudflareJson(
    `/zones?name=${encodeURIComponent(cloudflareZoneName)}&status=active`,
    token,
  );
  if (
    zones.result?.length !== 1 ||
    !/^[a-f0-9]{32}$/i.test(zones.result[0].id)
  ) {
    throw new HttpError(
      400,
      `The token must grant access to the active ${cloudflareZoneName} zone.`,
    );
  }
  const zone = zones.result[0];
  if (!/^[a-f0-9]{32}$/i.test(zone.account?.id ?? "")) {
    throw new HttpError(400, "Use an account-owned Cloudflare API token.");
  }
  return { zoneId: zone.id, accountId: zone.account.id };
}

async function createCloudflareDnsToken(bootstrapToken, accountId, zoneId) {
  const groups = await cloudflareJson(
    `/accounts/${encodeURIComponent(accountId)}/tokens/permission_groups`,
    bootstrapToken,
  );
  const required = ["Zone Read", "DNS Write"];
  const permissionGroups = required.map((name) =>
    groups.result?.find(
      (group) =>
        group.name === name &&
        group.scopes?.includes("com.cloudflare.api.account.zone"),
    ),
  );
  if (permissionGroups.some((group) => !/^[a-f0-9]{32}$/i.test(group?.id ?? ""))) {
    throw new HttpError(
      400,
      "Cloudflare did not expose the required Zone Read and DNS Write permission groups.",
    );
  }
  const expiresOn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const created = await cloudflareJson(
    `/accounts/${encodeURIComponent(accountId)}/tokens`,
    bootstrapToken,
    "POST",
    {
      name: `pawprint-site-dns-${new Date().toISOString().slice(0, 10)}`,
      expires_on: expiresOn,
      policies: [
        {
          effect: "allow",
          permission_groups: permissionGroups.map((group) => ({
            id: group.id,
            meta: {},
          })),
          resources: {
            [`com.cloudflare.api.account.zone.${zoneId}`]: "*",
          },
        },
      ],
    },
  );
  if (
    !/^[a-f0-9]{32}$/i.test(created.result?.id ?? "") ||
    typeof created.result?.value !== "string" ||
    created.result.value.length < 20
  ) {
    throw new HttpError(400, "Cloudflare did not return a usable DNS token.");
  }
  return {
    id: created.result.id,
    value: created.result.value,
    expiresOn: created.result.expires_on ?? expiresOn,
  };
}

async function verifyCloudflareDnsToken(token) {
  const { zoneId, accountId } = await cloudflareZone(token);
  await cloudflareJson(
    `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=1`,
    token,
  );
  const verification = await cloudflareJson(
    `/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
    token,
  );
  if (
    verification.result?.status !== "active" ||
    !/^[a-f0-9]{32}$/i.test(verification.result?.id ?? "")
  ) {
    throw new HttpError(400, "The Cloudflare account token is not active.");
  }
  const probeName = `_pawprint-connect-${randomBytes(8).toString("hex")}.${cloudflareZoneName}`;
  const created = await cloudflareJson(
    `/zones/${encodeURIComponent(zoneId)}/dns_records`,
    token,
    "POST",
    {
      type: "TXT",
      name: probeName,
      content: "pawprint-connection-verification",
      ttl: 60,
      comment: "Temporary PawPrint permission check",
    },
  );
  if (!/^[a-f0-9]{32}$/i.test(created.result?.id ?? "")) {
    throw new HttpError(400, "Cloudflare did not create the DNS write probe.");
  }
  await cloudflareJson(
    `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(created.result.id)}`,
    token,
    "DELETE",
  );
  return {
    id: verification.result.id,
    expiresOn: verification.result.expires_on ?? "no-expiry",
  };
}

async function storeCloudflareDnsToken(token, verification) {
  for (const environment of cloudflareEnvironments) {
    await runWithInput(
      "gh",
      [
        "secret",
        "set",
        "CLOUDFLARE_API_TOKEN",
        "--env",
        environment,
        "--repo",
        cloudflareRepository,
      ],
      token,
    );
    await setGitHubEnvironmentVariable(
      cloudflareRepository,
      environment,
      "CLOUDFLARE_TOKEN_ID",
      verification.id,
    );
    await setGitHubEnvironmentVariable(
      cloudflareRepository,
      environment,
      "CLOUDFLARE_TOKEN_EXPIRES_ON",
      verification.expiresOn,
    );
  }
}

async function connectCloudflare(bootstrapToken) {
  if (
    typeof bootstrapToken !== "string" ||
    bootstrapToken.length < 20 ||
    bootstrapToken.length > 4096 ||
    /\s/.test(bootstrapToken)
  ) {
    throw new HttpError(400, "Enter a valid temporary Cloudflare bootstrap token.");
  }

  const { accountId, zoneId } = await cloudflareZone(bootstrapToken);
  let dnsToken = null;
  try {
    dnsToken = await createCloudflareDnsToken(
      bootstrapToken,
      accountId,
      zoneId,
    );
    const verification = await verifyCloudflareDnsToken(dnsToken.value);
    await storeCloudflareDnsToken(dnsToken.value, verification);
  } catch (error) {
    if (dnsToken) {
      await cloudflareJson(
        `/accounts/${encodeURIComponent(accountId)}/tokens/${encodeURIComponent(dnsToken.id)}`,
        bootstrapToken,
        "DELETE",
      ).catch(() => null);
    }
    throw error;
  }
  return "Stored a new seven-day DNS-only token for Site dev and prod. Revoke the temporary bootstrap token in Cloudflare now.";
}

function openCloudflareAccountTokens() {
  if (!existsSync(edgePath)) {
    throw new HttpError(
      409,
      "Microsoft Edge is not installed at its standard Windows location.",
    );
  }
  const child = spawn(edgePath, [cloudflareAccountTokenUrl], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

async function storePrivateKey(privateKey) {
  const userObjectId = await run("az", [
    "ad",
    "signed-in-user",
    "show",
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  const vaultId = await run("az", [
    "keyvault",
    "show",
    "--name",
    portalKeyVault,
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  const assignments = await optionalJson(
    "az",
    [
      "role",
      "assignment",
      "list",
      "--assignee-object-id",
      userObjectId,
      "--scope",
      vaultId,
      "--include-inherited",
      "-o",
      "json",
    ],
    [],
  );
  const alreadyOfficer = assignments.some(
    (assignment) =>
      assignment.roleDefinitionName === "Key Vault Secrets Officer",
  );
  let temporaryAssignmentId = null;
  const secretPath = join(
    tmpdir(),
    `pawprint-github-app-${randomBytes(12).toString("hex")}.pem`,
  );

  try {
    if (!alreadyOfficer) {
      const assignmentName = temporaryVaultAssignmentName(
        vaultId,
        userObjectId,
      );
      temporaryAssignmentId = await run("az", [
        "role",
        "assignment",
        "create",
        "--name",
        assignmentName,
        "--assignee-object-id",
        userObjectId,
        "--assignee-principal-type",
        "User",
        "--role",
        "Key Vault Secrets Officer",
        "--scope",
        vaultId,
        "--query",
        "id",
        "-o",
        "tsv",
      ]);
    }
    writeFileSync(secretPath, privateKey, { encoding: "utf8", mode: 0o600 });
    let stored = false;
    for (let attempt = 0; attempt < 18 && !stored; attempt += 1) {
      try {
        await run("az", [
          "keyvault",
          "secret",
          "set",
          "--vault-name",
          portalKeyVault,
          "--name",
          "github-app-private-key",
          "--file",
          secretPath,
          "--output",
          "none",
        ]);
        stored = true;
      } catch (error) {
        if (attempt === 17) throw error;
        await delay(5000);
      }
    }
  } finally {
    rmSync(secretPath, { force: true });
    if (temporaryAssignmentId) {
      await deleteTemporaryVaultAssignment(vaultId, userObjectId);
    }
  }
}

async function loadStoredGitHubApp() {
  const variables = await json("gh", [
    "variable",
    "list",
    "--env",
    "dev",
    "--repo",
    portalRepository,
    "--json",
    "name,value",
  ]);
  const values = Object.fromEntries(
    variables.map((variable) => [variable.name, variable.value]),
  );
  if (
    !/^\d+$/.test(values.PAWPRINT_GITHUB_APP_ID ?? "") ||
    !/^[a-z0-9-]+$/.test(values.PAWPRINT_GITHUB_APP_SLUG ?? "")
  ) {
    return null;
  }

  const userObjectId = await run("az", [
    "ad",
    "signed-in-user",
    "show",
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  const vaultId = await run("az", [
    "keyvault",
    "show",
    "--name",
    portalKeyVault,
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  const assignments = await optionalJson(
    "az",
    [
      "role",
      "assignment",
      "list",
      "--assignee-object-id",
      userObjectId,
      "--scope",
      vaultId,
      "--include-inherited",
      "-o",
      "json",
    ],
    [],
  );
  const alreadyOfficer = assignments.some(
    (assignment) =>
      assignment.roleDefinitionName === "Key Vault Secrets Officer",
  );
  let temporaryAssignmentId = null;
  try {
    if (!alreadyOfficer) {
      const assignmentName = temporaryVaultAssignmentName(
        vaultId,
        userObjectId,
      );
      temporaryAssignmentId = await run("az", [
        "role",
        "assignment",
        "create",
        "--name",
        assignmentName,
        "--assignee-object-id",
        userObjectId,
        "--assignee-principal-type",
        "User",
        "--role",
        "Key Vault Secrets Officer",
        "--scope",
        vaultId,
        "--query",
        "id",
        "-o",
        "tsv",
      ]);
    }
    let pem = null;
    for (let attempt = 0; attempt < 18 && !pem; attempt += 1) {
      try {
        pem = await run("az", [
          "keyvault",
          "secret",
          "show",
          "--vault-name",
          portalKeyVault,
          "--name",
          "github-app-private-key",
          "--query",
          "value",
          "-o",
          "tsv",
        ]);
      } catch (error) {
        if (attempt === 17) throw error;
        await delay(5000);
      }
    }
    return {
      id: Number(values.PAWPRINT_GITHUB_APP_ID),
      slug: values.PAWPRINT_GITHUB_APP_SLUG,
      pem,
    };
  } finally {
    if (temporaryAssignmentId) {
      await deleteTemporaryVaultAssignment(vaultId, userObjectId);
    }
  }
}

async function enableGitHubApp(app, installation) {
  try {
    await Promise.all([
      setGitHubVariable("PAWPRINT_GITHUB_APP_ID", app.id),
      setGitHubVariable("PAWPRINT_GITHUB_APP_SLUG", app.slug),
      setGitHubVariable("PAWPRINT_GITHUB_APP_INSTALLATION_ID", installation.id),
      setGitHubVariable("PAWPRINT_GITHUB_APP_ENABLED", "false"),
    ]);
    await run(
      "az",
      [
        "deployment",
        "group",
        "create",
        "--name",
        "pawprint-github-app-setup",
        "--resource-group",
        portalResourceGroup,
        "--template-file",
        "infra/portal/main.bicep",
        "--parameters",
        "infra/portal/main.dev.bicepparam",
        "githubAppEnabled=true",
        `githubAppId=${app.id}`,
        `githubAppInstallationId=${installation.id}`,
        "--output",
        "none",
      ],
      1200000,
    );
    const settings = await json("az", [
      "functionapp",
      "config",
      "appsettings",
      "list",
      "--resource-group",
      portalResourceGroup,
      "--name",
      portalFunctionApp,
      "-o",
      "json",
    ]);
    const configured = Object.fromEntries(
      settings.map((setting) => [setting.name, setting.value]),
    );
    if (
      configured.GITHUB_APP_ENABLED?.toLowerCase() !== "true" ||
      configured.GITHUB_APP_ID !== String(app.id) ||
      configured.GITHUB_APP_INSTALLATION_ID !== String(installation.id) ||
      !configured.GITHUB_APP_PRIVATE_KEY?.startsWith("@Microsoft.KeyVault")
    ) {
      throw new Error("Function App GitHub App settings did not converge.");
    }
    await setGitHubVariable("PAWPRINT_GITHUB_APP_ENABLED", "true");
  } catch (error) {
    await setGitHubVariable("PAWPRINT_GITHUB_APP_ENABLED", "false");
    await optionalRun("az", [
      "functionapp",
      "config",
      "appsettings",
      "set",
      "--resource-group",
      portalResourceGroup,
      "--name",
      portalFunctionApp,
      "--settings",
      "GITHUB_APP_ENABLED=false",
      "--output",
      "none",
    ]);
    throw error;
  }
}

async function disableGitHubApp() {
  await run("az", [
    "functionapp",
    "config",
    "appsettings",
    "set",
    "--resource-group",
    portalResourceGroup,
    "--name",
    portalFunctionApp,
    "--settings",
    "GITHUB_APP_ENABLED=false",
    "--output",
    "none",
  ]);
  const settings = await json("az", [
    "functionapp",
    "config",
    "appsettings",
    "list",
    "--resource-group",
    portalResourceGroup,
    "--name",
    portalFunctionApp,
    "-o",
    "json",
  ]);
  if (
    settings
      .find((setting) => setting.name === "GITHUB_APP_ENABLED")
      ?.value?.toLowerCase() !== "false"
  ) {
    throw new Error("Function App hosted dispatch did not disable.");
  }
  await setGitHubVariable("PAWPRINT_GITHUB_APP_ENABLED", "false");
}

async function auditAndEnableStoredGitHubApp() {
  const app = pendingGitHubApp ?? (await loadStoredGitHubApp());
  if (!app) throw new Error("No stored Pawprint GitHub App is available.");
  const installation = await inspectInstallation(app);
  if (!installation?.valid) {
    throw new Error(
      "The GitHub App installation does not match the required owner, permissions, and repositories.",
    );
  }
  await enableGitHubApp(app, installation);
  pendingGitHubApp = null;
  return installation;
}

function sendRedirect(response, location) {
  response.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

function sendSetupResult(response, title, message, success) {
  response.writeHead(success ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;max-width:720px;margin:12vh auto;padding:24px}a{color:#075985}</style></head><body><h1>${title}</h1><p>${message}</p><p><a href="/">Return to PawPrint Portal</a></p></body></html>`,
  );
}

async function latestRun(workload) {
  const runs = await json("gh", [
    "run",
    "list",
    "--repo",
    workload.repository,
    "--workflow",
    workload.statusWorkflow,
    "--branch",
    config.environment,
    "--limit",
    "1",
    "--json",
    "databaseId,status,conclusion,createdAt,updatedAt,url,headSha",
  ]);
  return runs[0] ?? null;
}

async function overview() {
  const [github, azure, runs] = await Promise.all([
    run("gh", ["api", "user", "--jq", ".login"]),
    json("az", [
      "account",
      "show",
      "--query",
      "{name:name,id:id}",
      "-o",
      "json",
    ]),
    Promise.all(
      config.workloads.map(async (workload) => {
        try {
          return await latestRun(workload);
        } catch {
          return null;
        }
      }),
    ),
  ]);

  return {
    canDeploy: true,
    identity: { github, azure: azure.name },
    environment: config.environment,
    workloads: config.workloads.map((workload, index) => ({
      id: workload.id,
      label: workload.label,
      description: workload.description,
      environment: config.environment,
      siteUrl: workload.siteUrl,
      actionsUrl: `https://github.com/${workload.repository}/actions/workflows/${workload.statusWorkflow}`,
      action: workload.id,
      run: runs[index],
      job: jobs.get(workload.id) ?? null,
    })),
    jobs: [...jobs.values()],
  };
}

async function workflowRuns(workload, workflow) {
  return json("gh", [
    "run",
    "list",
    "--repo",
    workload.repository,
    "--workflow",
    workflow,
    "--event",
    "workflow_dispatch",
    "--branch",
    config.environment,
    "--limit",
    "10",
    "--json",
    "databaseId,status,conclusion,createdAt,url",
  ]);
}

async function findDispatchedRun(workload, workflow, previousRunIds) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidates = (await workflowRuns(workload, workflow)).filter(
      (candidate) => !previousRunIds.has(candidate.databaseId),
    );
    if (candidates.length > 1) {
      throw new Error(
        `${workflow} had multiple new runs; refusing to correlate the deployment.`,
      );
    }
    if (candidates.length === 1) {
      await delay(1500);
      const confirmed = (await workflowRuns(workload, workflow)).filter(
        (candidate) => !previousRunIds.has(candidate.databaseId),
      );
      if (confirmed.length !== 1) {
        throw new Error(
          `${workflow} dispatch became ambiguous; refusing to continue.`,
        );
      }
      return confirmed[0];
    }
    await delay(1500);
  }
  throw new Error(`GitHub accepted ${workflow}, but its run did not appear.`);
}

async function waitForRun(workload, runId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const current = await json("gh", [
      "run",
      "view",
      String(runId),
      "--repo",
      workload.repository,
      "--json",
      "databaseId,status,conclusion,createdAt,updatedAt,url",
    ]);
    if (current.status === "completed") return current;
    await delay(10000);
  }
  throw new Error(`Timed out waiting for GitHub run ${runId}.`);
}

async function deploy(workload) {
  const job = {
    id: workload.id,
    label: workload.label,
    status: "running",
    stage: "Starting",
    startedAt: new Date().toISOString(),
  };
  jobs.set(workload.id, job);

  try {
    for (const step of workload.steps) {
      job.stage = step.label;
      const args = [
        "workflow",
        "run",
        step.workflow,
        "--repo",
        workload.repository,
        "--ref",
        config.environment,
      ];
      for (const [name, value] of Object.entries(step.inputs)) {
        args.push("-f", `${name}=${value}`);
      }
      const previousRunIds = new Set(
        (await workflowRuns(workload, step.workflow)).map(
          (candidate) => candidate.databaseId,
        ),
      );
      await run("gh", args);
      const dispatched = await findDispatchedRun(
        workload,
        step.workflow,
        previousRunIds,
      );
      job.run = dispatched;
      const completed = await waitForRun(workload, dispatched.databaseId);
      job.run = completed;
      if (completed.conclusion !== "success") {
        throw new Error(`${step.label} ended with ${completed.conclusion}.`);
      }
    }
    job.status = "success";
    job.stage = "Complete";
  } catch (error) {
    job.status = "failure";
    job.error = error.message;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

function startAction(action) {
  const selected =
    action === "deploy-all"
      ? config.workloads
      : config.workloads.filter((workload) => workload.id === action);
  if (selected.length === 0) throw new Error("Unknown deployment action.");

  const available = selected.filter(
    (workload) => jobs.get(workload.id)?.status !== "running",
  );
  if (available.length === 0)
    throw new Error("The selected deployment is already running.");
  for (const workload of available) deploy(workload);
  return available;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function serveStatic(pathname, response) {
  const requested =
    pathname === "/"
      ? "index.html"
      : pathname.endsWith("/")
        ? `${pathname.slice(1)}index.html`
        : pathname.slice(1);
  const file = resolve(dist, normalize(requested));
  if (!file.startsWith(`${dist}\\`) && !file.startsWith(`${dist}/`)) {
    response.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
    "Cache-Control":
      extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== authority) {
      response
        .writeHead(421, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Misdirected request");
      return;
    }
    const url = new URL(request.url, origin);
    if (request.method === "GET" && url.pathname === "/api/overview") {
      sendJson(response, 200, await overview());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/setup/overview") {
      sendJson(response, 200, await setupOverview());
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/setup/platform/overview"
    ) {
      sendJson(response, 200, await platformOverview());
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/setup/first-run/overview"
    ) {
      sendJson(response, 200, await firstRunOverview());
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/setup/first-run/cost"
    ) {
      sendJson(
        response,
        200,
        await firstRunCost(url.searchParams.get("subscription") ?? ""),
      );
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/setup/first-run/save"
    ) {
      assertLocalPost(request);
      sendJson(response, 200, {
        plan: await saveSetupPlan(await readBody(request)),
      });
      return;
    }
    if (
      request.method === "POST" &&
      [
        "/api/setup/platform/iac/preview",
        "/api/setup/platform/iac/apply",
      ].includes(url.pathname)
    ) {
      assertLocalPost(request);
      sendJson(response, 200, {
        message: await deployPlatformConnectors(
          url.pathname.endsWith("/preview"),
        ),
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/setup/platform/access"
    ) {
      sendJson(
        response,
        200,
        await enterpriseAppAccess(url.searchParams.get("connector") ?? ""),
      );
      return;
    }
    if (
      request.method === "POST" &&
      [
        "/api/setup/platform/access/assign",
        "/api/setup/platform/access/remove",
      ].includes(url.pathname)
    ) {
      assertLocalPost(request);
      const body = await readBody(request);
      sendJson(response, 200, {
        message: await updateEnterpriseAppAccess(
          body.connectorId,
          url.pathname.endsWith("/assign") ? "assign" : "remove",
          body,
        ),
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/setup/github-app/start"
    ) {
      assertLocalPost(request);
      const state = randomBytes(32).toString("hex");
      const installationState = randomBytes(32).toString("hex");
      setupStates.set(state, {
        expiresAt: Date.now() + 10 * 60 * 1000,
        installationState,
      });
      sendJson(response, 200, {
        action: `https://github.com/organizations/${GITHUB_ORGANIZATION}/settings/apps/new?state=${state}`,
        manifest: createGitHubAppManifest(origin, installationState),
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/setup/github-app/callback"
    ) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const setupState = state ? setupStates.get(state) : null;
      if (!code || !state || !setupState || setupState.expiresAt < Date.now()) {
        sendSetupResult(
          response,
          "GitHub App setup rejected",
          "The callback state is missing or expired. Start again from the local portal.",
          false,
        );
        return;
      }
      setupStates.delete(state);
      try {
        const conversionResponse = await fetch(
          `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );
        if (!conversionResponse.ok) {
          throw new Error(
            `GitHub manifest conversion returned ${conversionResponse.status}.`,
          );
        }
        const app = validateManifestConversion(await conversionResponse.json());
        await storePrivateKey(app.pem);
        pendingGitHubApp = {
          id: app.id,
          slug: app.slug,
          pem: app.pem,
          installationState: setupState.installationState,
        };
        installationStates.set(setupState.installationState, {
          appId: app.id,
          expiresAt: Date.now() + 60 * 60 * 1000,
        });
        await Promise.all([
          setGitHubVariable("PAWPRINT_GITHUB_APP_ID", app.id),
          setGitHubVariable("PAWPRINT_GITHUB_APP_SLUG", app.slug),
        ]);
        sendRedirect(
          response,
          `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
        );
      } catch (error) {
        process.stderr.write(
          `[portal] GitHub App conversion failed: ${error.stack ?? error.message}\n`,
        );
        pendingGitHubApp = null;
        sendSetupResult(
          response,
          "GitHub App setup failed",
          "The App could not be stored. Review the portal terminal; no secret was returned to the browser.",
          false,
        );
      }
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/setup/github-app/installed"
    ) {
      const state = url.searchParams.get("state");
      const installationState = state ? installationStates.get(state) : null;
      if (
        !pendingGitHubApp ||
        !state ||
        !installationState ||
        installationState.expiresAt < Date.now() ||
        installationState.appId !== pendingGitHubApp.id ||
        pendingGitHubApp.installationState !== state
      ) {
        sendSetupResult(
          response,
          "Installation not recognized",
          "Start GitHub App setup from this local portal before installing.",
          false,
        );
        return;
      }
      installationStates.delete(state);
      try {
        const installation = await inspectInstallation(pendingGitHubApp);
        if (!installation?.valid) {
          sendSetupResult(
            response,
            "Installation needs attention",
            "Install the App on the ninjapaw organization and select exactly the four listed workload repositories.",
            false,
          );
          return;
        }
        await enableGitHubApp(pendingGitHubApp, installation);
        pendingGitHubApp = null;
        sendSetupResult(
          response,
          "GitHub App ready",
          "The App is installed with the expected permissions and repositories. Hosted deployment is enabled.",
          true,
        );
      } catch (error) {
        process.stderr.write(
          `[portal] GitHub App installation failed: ${error.stack ?? error.message}\n`,
        );
        sendSetupResult(
          response,
          "Installation setup failed",
          "The installation could not be verified or enabled. Review the portal terminal.",
          false,
        );
      }
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/setup/github-app/enable"
    ) {
      assertLocalPost(request);
      const installation = await auditAndEnableStoredGitHubApp();
      sendJson(response, 200, {
        message: `Hosted dispatch enabled for ${installation.repositories.length} repositories.`,
        installation,
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/setup/github-app/audit"
    ) {
      assertLocalPost(request);
      const app = pendingGitHubApp ?? (await loadStoredGitHubApp());
      if (!app) {
        sendJson(response, 409, {
          error:
            "Start or resume GitHub App setup before auditing authenticated permissions.",
        });
        return;
      }
      sendJson(response, 200, { installation: await inspectInstallation(app) });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/setup/github-app/disable"
    ) {
      assertLocalPost(request);
      await disableGitHubApp();
      sendJson(response, 200, {
        message: "Hosted GitHub App dispatch is disabled.",
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/setup/cloudflare/connect"
    ) {
      assertLocalPost(request);
      const body = await readBody(request);
      const message = await connectCloudflare(body.token);
      sendJson(response, 200, {
        message,
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/setup/cloudflare/open-account-tokens"
    ) {
      assertLocalPost(request);
      openCloudflareAccountTokens();
      sendJson(response, 200, {
        message: "Opened Cloudflare account token setup in Microsoft Edge.",
      });
      return;
    }
    if (url.pathname === "/api/setup/github-app/webhook") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/actions") {
      if (
        request.headers.origin !== origin ||
        request.headers["content-type"] !== "application/json"
      ) {
        sendJson(response, 403, {
          error: "Deployment actions require the local PawPrint Portal.",
        });
        return;
      }
      const { action } = await readBody(request);
      const selected = startAction(action);
      sendJson(response, 202, {
        message: `Started ${selected.map((workload) => workload.label).join(", ")} in development.`,
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    serveStatic(url.pathname, response);
  } catch (error) {
    process.stderr.write(
      `[portal] Request failed: ${error.stack ?? error.message}\n`,
    );
    sendJson(response, error instanceof HttpError ? error.status : 500, {
      error:
        error instanceof HttpError
          ? error.message
          : "The portal request failed. Review the portal terminal for details.",
    });
  }
});

await recoverTemporaryVaultAssignment();

server.listen(port, host, async () => {
  process.stdout.write(`PawPrint Portal is ready at ${origin}\n`);
  if (process.env.PAWPRINT_NO_BROWSER !== "1") {
    const opener =
      process.platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", origin]]
        : process.platform === "darwin"
          ? ["open", [origin]]
          : ["xdg-open", [origin]];
    executeFile(opener[0], opener[1], { windowsHide: true }).catch(() => {});
  }
});
