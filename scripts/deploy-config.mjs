// Resolves config/deploy.config.json into the environment variables a deployment
// pipeline consumes. Shared across repositories: the resolution order, the
// branch-to-environment binding and the refusal to read a subscription id out of
// committed configuration are organisation policy, not per-repository detail.
//
// Repository-specific output is declarative. Put it in the config file under
// defaults.resolver, not in a fork of this script:
//
//   "resolver": {
//     "required": ["resourceGroup", "staticWebAppName"],
//     "env": { "AZURE_STATIC_WEB_APP_NAME": "staticWebAppName" }
//   }
//
// Vendored copy. Edit it in ninjapaw/pawprint and re-vendor; CI fails on drift.

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const SUPPORTED_CONFIG_VERSIONS = ["1.0.0"];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_SHAPED =
  /(password|passwd|secret|api[_-]?key|client[_-]?secret|token|credential|connection[_-]?string|private[_-]?key|pfx)/i;
// A key that names, counts or toggles a secret is metadata and safe to commit.
// Only a key that would hold the secret itself is worth refusing.
const SECRET_METADATA = /(names?|days|enabled|mode|tier|path|uri|url|count)$/i;

const BRANCH_FOR_ENVIRONMENT = { dev: "dev", prod: "main" };

const BASE_ENV = {
  DEPLOY_ENVIRONMENT: "__environmentName",
  AZURE_ENVIRONMENT: "azureEnvironment",
  AZURE_SUBSCRIPTION_ID: "subscriptionId",
  AZURE_LOCATION: "location",
  AZURE_RESOURCE_GROUP: "resourceGroup",
};

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "config/deploy.config.json" },
    environment: { type: "string" },
    branch: { type: "string" },
    "github-env": { type: "boolean", default: false },
    "github-output": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    "require-subscription": { type: "boolean", default: false },
  },
});

const configPath = resolve(values.config);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const environmentName = resolveEnvironment(values.environment, values.branch);
const environment = config.environments?.[environmentName];

if (!environment) {
  fail(`Environment '${environmentName}' is not defined in ${configPath}.`);
}

// A subscription id in a committed file is a fork away from being deployed into
// by someone who never intended it, so the runtime value always wins.
const settings = {
  ...config.defaults,
  ...environment,
  subscriptionId:
    process.env.AZURE_SUBSCRIPTION_ID || environment.subscriptionId || "",
};

validate(config, environmentName, settings, values["require-subscription"]);

const resolver = config.defaults?.resolver ?? {};
// Values a caller may supply at runtime, for deployment targets whose public
// URL is not knowable from configuration alone. Empty is not an override.
const overridable = new Set(resolver.envOverridable ?? []);
const output = {};
for (const [name, key] of Object.entries({
  ...BASE_ENV,
  ...(resolver.env ?? {}),
})) {
  const value = key === "__environmentName" ? environmentName : settings[key];
  const resolved = value === undefined || value === null ? "" : String(value);
  const override = overridable.has(name)
    ? (process.env[name] ?? "").trim()
    : "";
  output[name] = override === "" ? resolved : override;
}

const lines = Object.entries(output).map(([name, value]) => `${name}=${value}`);

if (values["github-env"]) {
  appendTo("GITHUB_ENV", lines);
}
if (values["github-output"]) {
  appendTo("GITHUB_OUTPUT", lines);
}
if (!values["github-env"] && !values["github-output"] && !values.check) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function appendTo(variableName, content) {
  const target = process.env[variableName];
  if (!target) {
    fail(
      `${variableName} is required when --${variableName.toLowerCase().replace("github_", "github-")} is used.`,
    );
  }
  appendFileSync(target, `${content.join("\n")}\n`);
}

function resolveEnvironment(requested, branch) {
  if (requested && requested !== "auto" && requested !== "auto-detect") {
    return requested;
  }
  if (branch === "main") {
    return "prod";
  }
  if (branch === "dev") {
    return "dev";
  }
  fail("Specify --environment dev|prod or --branch dev|main.");
}

function validate(root, name, resolved, requireSubscription) {
  if (!SUPPORTED_CONFIG_VERSIONS.includes(root.configVersion)) {
    fail(`Unsupported deployment config version '${root.configVersion}'.`);
  }

  assertNoSecretShapedKeys(root, "");

  const required = [
    "branch",
    "githubEnvironment",
    "location",
    "resourceGroup",
    ...(root.defaults?.resolver?.required ?? []),
  ];
  for (const property of new Set(required)) {
    if (
      typeof resolved[property] !== "string" ||
      resolved[property].trim() === ""
    ) {
      fail(`environments.${name}.${property} must be a non-empty string.`);
    }
  }

  const expectedBranch = BRANCH_FOR_ENVIRONMENT[name];
  if (expectedBranch && resolved.branch !== expectedBranch) {
    fail(
      `environments.${name}.branch is '${resolved.branch}' but the promotion model binds it to '${expectedBranch}'.`,
    );
  }

  if (
    resolved.customDomain &&
    resolved.publicSiteUrl !== `https://${resolved.customDomain}`
  ) {
    fail(
      `environments.${name}.publicSiteUrl must be https://${resolved.customDomain}.`,
    );
  }

  if (!/^[A-Za-z0-9._()-]{1,90}$/.test(resolved.resourceGroup)) {
    fail(
      `environments.${name}.resourceGroup is not a valid resource group name.`,
    );
  }

  if (environment.subscriptionId) {
    fail(
      `environments.${name}.subscriptionId must stay empty; supply AZURE_SUBSCRIPTION_ID at runtime instead.`,
    );
  }
  if (resolved.subscriptionId && !UUID.test(resolved.subscriptionId)) {
    fail(`AZURE_SUBSCRIPTION_ID is not a UUID.`);
  }
  if (requireSubscription && !resolved.subscriptionId) {
    fail(`Set AZURE_SUBSCRIPTION_ID before deploying environment '${name}'.`);
  }

  validateSecrets(name, resolved.secrets);
}

function validateSecrets(name, secrets) {
  if (secrets === undefined) {
    return;
  }
  const mode = secrets.mode;
  if (!["none", "platform", "workload"].includes(mode)) {
    fail(
      `environments.${name}.secrets.mode must be none, platform or workload.`,
    );
  }
  if (mode === "workload" && !secrets.vaultName) {
    fail(
      `environments.${name}.secrets.vaultName is required when mode is workload.`,
    );
  }
  if (mode === "platform") {
    if (!secrets.platformVaultName) {
      fail(
        `environments.${name}.secrets.platformVaultName is required when mode is platform.`,
      );
    }
    // A vault-wide grant is the failure mode this tier exists to prevent, so an
    // empty secret list is refused rather than quietly widened.
    if (
      !Array.isArray(secrets.secretNames) ||
      secrets.secretNames.length === 0
    ) {
      fail(
        `environments.${name}.secrets.secretNames must name at least one secret when mode is platform.`,
      );
    }
  }
}

function assertNoSecretShapedKeys(node, path) {
  if (node === null || typeof node !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    const holdsAValue = typeof value === "string" && value.trim() !== "";
    if (holdsAValue && SECRET_SHAPED.test(key) && !SECRET_METADATA.test(key)) {
      fail(
        `${here} looks like a secret. Committed configuration must not carry secrets; use Key Vault or a GitHub Environment secret.`,
      );
    }
    assertNoSecretShapedKeys(value, here);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
