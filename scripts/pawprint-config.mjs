/**
 * Pawprint deployment configuration resolver.
 *
 * Resolution order, lowest precedence first:
 *   builtin < config/deploy.defaults.json < config/deploy.config.json < environment variable < CLI flag
 *
 * The defaults file is upstream-owned and must never be edited by adopters, so
 * forks merge cleanly. The override file is adopter-owned and upstream never
 * touches it.
 *
 * Usage:
 *   node scripts/pawprint-config.mjs --environment dev
 *   node scripts/pawprint-config.mjs --branch dev --github-env
 *   node scripts/pawprint-config.mjs --environment prod --check
 *   node scripts/pawprint-config.mjs --environment dev --json
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

// The schemas target draft 2020-12; ajv's default export only implements draft-07.
const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|api[_-]?key|client[_-]?secret|token|credential|connection[_-]?string|private[_-]?key|\bsas\b|pfx)/i;

class ConfigError extends Error {}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not read JSON from ${path}: ${error.message}`);
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

/** Recursively sort keys so the hash is stable regardless of authoring order. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function hashConfig(resolved) {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(resolved))).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Secret-shaped keys are rejected here as well as in the schema. The schema
 * catches the conventional spellings; this catches every casing and reports the
 * exact path so the fix is obvious.
 */
function assertNoSecretKeys(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ConfigError(
        `Secret-shaped key '${here}' is not allowed in committed configuration.\n` +
          `  Runtime secrets belong in Key Vault. Pipeline identity belongs in GitHub Environment variables.`,
      );
    }
    assertNoSecretKeys(child, here);
  }
}

function assertConfigVersion(fileVersion, schemaVersion, label) {
  const [fileMajor] = fileVersion.split(".");
  const [schemaMajor] = schemaVersion.split(".");
  if (fileMajor !== schemaMajor) {
    throw new ConfigError(
      `${label} declares configVersion ${fileVersion} but this Pawprint expects ${schemaVersion}.x.\n` +
        `  Major versions are not compatible. Run 'pawprint config migrate' and review the diff.`,
    );
  }
}

function buildValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(readJson(resolve(REPO_ROOT, "schema/deploy.config.schema.json")));
}

function validateFile(validate, config, label) {
  if (validate(config)) return;
  const detail = validate.errors
    .map((error) => `  ${error.instancePath || "/"} ${error.message}`)
    .join("\n");
  throw new ConfigError(`${label} failed schema validation:\n${detail}`);
}

function environmentFromBranch(config, branch) {
  const match = Object.entries(config.environments ?? {}).find(
    ([, settings]) => settings.branch === branch,
  );
  if (!match) {
    const known = Object.entries(config.environments ?? {})
      .map(([name, settings]) => `${settings.branch ?? "?"} -> ${name}`)
      .join(", ");
    throw new ConfigError(
      `No environment is bound to branch '${branch}'. Known bindings: ${known || "none"}.`,
    );
  }
  return match[0];
}

function resolveConfig({ environment, branch, overridePath }) {
  const validate = buildValidator();

  const defaultsPath = resolve(REPO_ROOT, "config/deploy.defaults.json");
  const defaults = readJson(defaultsPath);
  validateFile(validate, defaults, "config/deploy.defaults.json");
  assertNoSecretKeys(defaults);

  const resolvedOverridePath = overridePath
    ? resolve(process.cwd(), overridePath)
    : resolve(REPO_ROOT, "config/deploy.config.json");

  let merged = defaults;
  if (existsSync(resolvedOverridePath)) {
    const override = readJson(resolvedOverridePath);
    validateFile(validate, override, resolvedOverridePath);
    assertNoSecretKeys(override);
    assertConfigVersion(override.configVersion, defaults.configVersion, resolvedOverridePath);
    merged = deepMerge(defaults, override);
  }

  const targetEnvironment = environment ?? environmentFromBranch(merged, branch);
  const environmentSettings = merged.environments?.[targetEnvironment];
  if (!environmentSettings) {
    const known = Object.keys(merged.environments ?? {}).join(", ") || "none";
    throw new ConfigError(`Unknown environment '${targetEnvironment}'. Defined environments: ${known}.`);
  }

  if (branch && environmentSettings.branch && environmentSettings.branch !== branch) {
    throw new ConfigError(
      `Branch '${branch}' does not own environment '${targetEnvironment}' ` +
        `(that environment expects branch '${environmentSettings.branch}').`,
    );
  }

  const resolved = {
    environment: targetEnvironment,
    ...deepMerge(merged.defaults ?? {}, environmentSettings),
  };

  return {
    environment: targetEnvironment,
    project: merged.project ?? {},
    configVersion: merged.configVersion,
    configHash: hashConfig(resolved),
    resolved,
    overrideApplied: existsSync(resolvedOverridePath),
  };
}

/**
 * Fails closed. A subscription is deployable only when it appears in the
 * allowlist, so an unconfigured or mistyped allowlist blocks deployment rather
 * than silently permitting the wrong subscription.
 */
function assertSubscriptionApproved(resolved, subscriptionId) {
  const approved = resolved.approvedSubscriptions;

  if (!Array.isArray(approved) || approved.length === 0) {
    throw new ConfigError(
      `No approved subscriptions are configured, so deployment is refused.\n` +
        `  Add the subscription to 'approvedSubscriptions' in config/deploy.config.json.\n` +
        `  Requested: ${subscriptionId}`,
    );
  }

  const normalized = approved.map((id) => id.toLowerCase());
  if (!normalized.includes(subscriptionId.toLowerCase())) {
    throw new ConfigError(
      `Subscription ${subscriptionId} is not in the approved list.\n` +
        `  Approved: ${approved.join(", ")}\n` +
        `  Add it deliberately if this is intended; Pawprint will not deploy into an unapproved subscription.`,
    );
  }
}

function toEnvironmentVariables(result) {
  const { resolved } = result;
  const entries = {
    PAWPRINT_ENVIRONMENT: result.environment,
    PAWPRINT_CONFIG_VERSION: result.configVersion,
    PAWPRINT_CONFIG_HASH: result.configHash,
    PAWPRINT_LOCATION: resolved.location ?? "",
    PAWPRINT_RESOURCE_GROUP: resolved.resourceGroup ?? "",
    PAWPRINT_TTL_HOURS: String(resolved.ttlHours ?? ""),
    PAWPRINT_REGISTRY: resolved.registry ?? "",
    PAWPRINT_SCENARIO: resolved.scenario ?? "",
    PAWPRINT_GITHUB_ENVIRONMENT: resolved.githubEnvironment ?? result.environment,
    PAWPRINT_REDACT: String(resolved.redactPawprint ?? false),
    PAWPRINT_TEARDOWN_ON_FAILURE: String(resolved.teardownOnFailure ?? true),
  };
  // Subscription and tenant are deliberately absent: they are supplied at
  // runtime from GitHub Environment variables, never from committed config.
  return entries;
}

function emit(result, { githubEnv, githubOutput, json }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const variables = toEnvironmentVariables(result);
  const lines = Object.entries(variables).map(([key, value]) => `${key}=${value}`);

  if (githubEnv && process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
  }
  if (githubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  if (!githubEnv && !githubOutput) {
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: "string" },
      branch: { type: "string" },
      config: { type: "string" },
      check: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      subscription: { type: "string" },
      "github-env": { type: "boolean", default: false },
      "github-output": { type: "boolean", default: false },
    },
  });

  if (!values.environment && !values.branch) {
    throw new ConfigError("Provide --environment <name> or --branch <name>.");
  }

  const result = resolveConfig({
    environment: values.environment,
    branch: values.branch,
    overridePath: values.config,
  });

  if (values.subscription) {
    assertSubscriptionApproved(result.resolved, values.subscription);
  }

  if (values.check) {
    process.stdout.write(
      `ok  ${result.environment}  configVersion=${result.configVersion}  ${result.configHash}` +
        `${result.overrideApplied ? "" : "  (no override file; defaults only)"}\n`,
    );
    return;
  }

  emit(result, {
    githubEnv: values["github-env"],
    githubOutput: values["github-output"],
    json: values.json,
  });
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`pawprint config: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
