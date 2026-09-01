/**
 * Onboards a repository environment to Azure via GitHub OIDC.
 *
 * Replaces the per-repository bootstrap scripts, which had diverged on the
 * three things that matter: the federated credential subject format, whether
 * identifiers were written as variables or secrets, and how much privilege the
 * deployment identity was granted.
 *
 * There is no credential to store. A federated credential is a trust statement,
 * not a secret: "a GitHub token whose sub matches this may act as this app".
 * Nothing here belongs in Key Vault, and the three identifiers it writes are
 * GitHub Variables because masking an identifier only redacts the deploy log.
 *
 * Runs as a human. The step that creates directory objects and grants roles is
 * the one step that needs elevation, so it stays interactive and attributable
 * rather than becoming a standing identity that could onboard anything.
 *
 *   node scripts/pawprint-onboard.mjs --repo ninjapaw/site --environment dev \
 *     --subscription <id> --resource-group NP-NinjaPawsSite-Dev-CentralUS
 *
 * Defaults to a dry run. Pass --apply to make changes.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(REPO_ROOT, ".pawprint-onboard.json");
const PAWPRINT_TAG = "pawprint-managed";
const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "api://AzureADTokenExchange";

const BRANCH_FOR_ENVIRONMENT = { dev: "dev", prod: "main" };

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    environment: { type: "string" },
    subscription: { type: "string" },
    "resource-group": { type: "string" },
    "with-api": { type: "boolean", default: false },
    "rbac-admin": { type: "boolean", default: false },
    "infrastructure-app": { type: "string" },
    "api-app": { type: "string" },
    "allow-new-app": { type: "boolean", default: false },
    "required-reviewer": { type: "string", multiple: true, default: [] },
    apply: { type: "boolean", default: false },
  },
});

for (const required of ["repo", "environment", "subscription", "resource-group"]) {
  if (!values[required]) {
    fail(`--${required} is required.`);
  }
}

// Windows needs a shell to invoke az.cmd, and a shell does not escape arguments.
// Validating every value that reaches a command line closes that off entirely,
// and catches typos before anything is created.
const SHAPES = {
  repo: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
  environment: /^[a-z][a-z0-9-]{0,31}$/,
  subscription: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "resource-group": /^[A-Za-z0-9._()-]{1,90}$/,
};
for (const [name, shape] of Object.entries(SHAPES)) {
  if (!shape.test(values[name])) {
    fail(`--${name} value '${values[name]}' is not a valid ${name}.`);
  }
}
for (const reviewer of values["required-reviewer"]) {
  if (!/^\d+$/.test(reviewer)) {
    fail(`--required-reviewer must be a numeric GitHub user id, got '${reviewer}'.`);
  }
}

const repository = values.repo;
const environmentName = values.environment;
const subscriptionId = values.subscription;
const resourceGroup = values["resource-group"];
const slug = repository.split("/")[1];
const scope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
const dryRun = !values.apply;

const created = [];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// az ships as a .cmd shim on Windows, which execFile cannot resolve on its own.
const WINDOWS = process.platform === "win32";
const binary = (command) => (WINDOWS && command === "az" ? "az.cmd" : command);

// A shell concatenates rather than escapes, so anything containing a space has
// to carry its own quotes. Every value reaching here is validated above.
const quoted = (argument) => (WINDOWS && /\s/.test(argument) ? `"${argument}"` : argument);

function run(command, args, { allowFailure = false } = {}) {
  try {
    return execFileSync(binary(command), WINDOWS ? args.map(quoted) : args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: WINDOWS,
    }).trim();
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    fail(`${command} ${args.join(" ")}\n${error.stderr ?? error.message}`);
  }
}

const az = (args, options) => run("az", args, options);
const gh = (args, options) => run("gh", args, options);

function step(description, action) {
  if (dryRun) {
    process.stdout.write(`would  ${description}\n`);
    return null;
  }
  const result = action();
  process.stdout.write(`done   ${description}\n`);
  return result;
}

function unchanged(description) {
  process.stdout.write(`ok     ${description}\n`);
}

// --- preflight -------------------------------------------------------------

if (!az(["account", "show", "--query", "id", "-o", "tsv"], { allowFailure: true })) {
  fail("Azure CLI is not signed in. Run 'az login' first; onboarding is deliberately interactive.");
}
if (!gh(["auth", "status"], { allowFailure: true }) && !process.env.GH_TOKEN) {
  fail("GitHub CLI is not signed in. Run 'gh auth login' first.");
}
if (!az(["account", "show", "--subscription", subscriptionId, "--query", "id", "-o", "tsv"], { allowFailure: true })) {
  fail(`Subscription ${subscriptionId} is not accessible from this session.`);
}
if (!gh(["repo", "view", repository, "--json", "name"], { allowFailure: true })) {
  fail(`Repository ${repository} is not accessible.`);
}

const tenantId = az(["account", "show", "--subscription", subscriptionId, "--query", "tenantId", "-o", "tsv"]);

process.stdout.write(
  `\n${dryRun ? "Dry run" : "Applying"}: ${repository} / ${environmentName}\n` +
    `  subscription ${subscriptionId}\n  resource group ${resourceGroup}\n\n`,
);

// --- GitHub environment ----------------------------------------------------

const branch = BRANCH_FOR_ENVIRONMENT[environmentName];
if (!branch) {
  fail(`No branch is bound to environment '${environmentName}'. Extend BRANCH_FOR_ENVIRONMENT first.`);
}

const reviewers = values["required-reviewer"].map((id) => ({ type: "User", id: Number(id) }));
const environmentBody = {
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  ...(reviewers.length ? { reviewers } : {}),
};

step(
  `bind environment '${environmentName}' to branch '${branch}'` +
    (reviewers.length ? ` with ${reviewers.length} required reviewer(s)` : ""),
  () => {
    ghJson(`repos/${repository}/environments/${environmentName}`, "PUT", environmentBody);
    const existing = ghJson(`repos/${repository}/environments/${environmentName}/deployment-branch-policies`);
    const already = (existing?.branch_policies ?? []).some((policy) => policy.name === branch);
    if (!already) {
      ghJson(`repos/${repository}/environments/${environmentName}/deployment-branch-policies`, "POST", {
        name: branch,
      });
    }
  },
);

// --- Entra applications ----------------------------------------------------

const infrastructure = ensureApplication(
  values["infrastructure-app"] ?? `${slug}-${environmentName}-infrastructure-github`,
  "infrastructure",
);
const api = values["with-api"]
  ? ensureApplication(values["api-app"] ?? `${slug}-${environmentName}-api-github`, "api")
  : null;

// The default subject is what GitHub actually emits unless a repository opts
// into immutable subjects. Mixing the two forms is how a credential silently
// stops matching.
ensureFederatedCredential(infrastructure, `github-${environmentName}-infrastructure`);
if (api) {
  ensureFederatedCredential(api, `github-${environmentName}-api`);
}

// --- role assignments ------------------------------------------------------

ensureRole(infrastructure, "Contributor", scope);
if (values["rbac-admin"]) {
  // This lets the identity grant roles inside the scope, which is escalation to
  // owner-equivalent there. Only templates that create roleAssignments need it.
  ensureRole(infrastructure, "Role Based Access Control Administrator", scope);
}

// --- GitHub variables ------------------------------------------------------

setVariable("AZURE_CLIENT_ID", infrastructure.appId);
setVariable("AZURE_SUBSCRIPTION_ID", subscriptionId);
if (api) {
  setVariable("AZURE_API_CLIENT_ID", api.appId);
  setVariable("AZURE_API_PRINCIPAL_OBJECT_ID", api.principalId ?? "");
}

// --- manifest --------------------------------------------------------------

if (!dryRun && created.length > 0) {
  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
    : { schemaVersion: "1.0.0", objects: [] };
  manifest.objects.push(...created);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`\nRecorded ${created.length} created object(s) in .pawprint-onboard.json\n`);
}

process.stdout.write(
  dryRun
    ? "\nNothing was changed. Re-run with --apply.\n"
    : `\nOnboarded ${repository} / ${environmentName}.\n` +
        `AZURE_TENANT_ID and AZURE_LOCATION come from organisation variables; tenant is ${tenantId}.\n`,
);

// --- helpers ---------------------------------------------------------------

function ghJson(path, method = "GET", body) {
  const args = ["api", path];
  if (method !== "GET") {
    args.push("-X", method, "--input", "-");
  }
  try {
    const output = execFileSync(binary("gh"), args, {
      encoding: "utf8",
      input: body ? JSON.stringify(body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim() ? JSON.parse(output) : null;
  } catch {
    return null;
  }
}

function ensureApplication(displayName, kind) {
  const existingId = az(
    ["ad", "app", "list", "--display-name", displayName, "--query", "[0].appId", "-o", "tsv"],
    { allowFailure: true },
  );

  if (existingId) {
    unchanged(`application ${displayName} exists (${existingId})`);
    const objectId = az(["ad", "app", "show", "--id", existingId, "--query", "id", "-o", "tsv"]);
    const principalId = az(["ad", "sp", "show", "--id", existingId, "--query", "id", "-o", "tsv"], {
      allowFailure: true,
    });
    return { displayName, appId: existingId, objectId, principalId, kind };
  }

  // A second identity for the same repository and environment is almost always
  // a naming mismatch rather than an intent, and the duplicate is invisible
  // until something authenticates as the wrong one.
  const nearMatches = JSON.parse(
    az(["ad", "app", "list", "--all", "--query", "[].{name:displayName,appId:appId}", "-o", "json"], {
      allowFailure: true,
    }) ?? "[]",
  ).filter(
    (candidate) =>
      candidate.name !== displayName &&
      candidate.name?.startsWith(slug) &&
      candidate.name.includes(kind === "api" ? "api" : "github"),
  );

  if (nearMatches.length > 0 && !values["allow-new-app"]) {
    const listed = nearMatches.map((m) => `      ${m.name}  (${m.appId})`).join("\n");
    fail(
      `Refusing to create '${displayName}': an application for this repository already exists under a different name.\n${listed}\n` +
        `Adopt it with --${kind === "api" ? "api" : "infrastructure"}-app '<name>', or pass --allow-new-app if a second identity is genuinely wanted.`,
    );
  }

  const result = step(`create application ${displayName}`, () => {
    const appId = az([
      "ad", "app", "create",
      "--display-name", displayName,
      "--sign-in-audience", "AzureADMyOrg",
      "--query", "appId", "-o", "tsv",
    ]);    const objectId = az(["ad", "app", "show", "--id", appId, "--query", "id", "-o", "tsv"]);
    // Tagged so uninstall can find it even if the manifest is lost.
    az(["ad", "app", "update", "--id", appId, "--set", `tags=[\\"${PAWPRINT_TAG}\\"]`], {
      allowFailure: true,
    });
    const principalId = az(["ad", "sp", "create", "--id", appId, "--query", "id", "-o", "tsv"]);
    created.push({ kind: "application", displayName, appId, objectId });
    created.push({ kind: "servicePrincipal", displayName, appId, id: principalId });
    return { appId, objectId, principalId };
  });

  return { displayName, kind, ...(result ?? { appId: "<new>", objectId: "<new>", principalId: "<new>" }) };
}

function credentialFile(payload) {
  // Passed as @file because a shell strips the quotes out of inline JSON, which
  // az then cannot parse.
  const path = join(tmpdir(), `pawprint-fic-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

function ensureFederatedCredential(application, name) {
  const subject = `repo:${repository}:environment:${environmentName}`;

  if (application.objectId !== "<new>") {
    const existing = az(
      ["ad", "app", "federated-credential", "list", "--id", application.objectId, "-o", "json"],
      { allowFailure: true },
    );
    const parsed = existing ? JSON.parse(existing) : [];

    // Azure rejects a duplicate subject, and an existing credential under a
    // different name already grants exactly the trust being asked for.
    const bySubject = parsed.find((credential) => credential.subject === subject);
    if (bySubject) {
      unchanged(`federated credential '${bySubject.name}' already trusts ${subject}`);
      return;
    }

    const match = parsed.find((credential) => credential.name === name);
    if (match) {
      if (match.subject === subject) {
        unchanged(`federated credential ${name} already trusts ${subject}`);
        return;
      }
      step(`correct federated credential ${name} subject to ${subject}`, () => {
        const file = credentialFile({ name, issuer: ISSUER, subject, audiences: [AUDIENCE] });
        try {
          az([
            "ad", "app", "federated-credential", "update",
            "--id", application.objectId,
            "--federated-credential-id", match.id,
            "--parameters", `@${file}`,
          ]);
        } finally {
          rmSync(file, { force: true });
        }
      });
      return;
    }
  }

  step(`create federated credential ${name} for ${subject}`, () => {
    const file = credentialFile({
      name,
      issuer: ISSUER,
      subject,
      audiences: [AUDIENCE],
      description: "Pawprint GitHub Actions environment trust",
    });
    try {
      az([
        "ad", "app", "federated-credential", "create",
        "--id", application.objectId,
        "--parameters", `@${file}`,
      ]);
    } finally {
      rmSync(file, { force: true });
    }
    created.push({ kind: "federatedIdentityCredential", displayName: name, parentAppId: application.appId });
  });
}

function ensureRole(application, role, roleScope) {
  if (application.principalId && application.principalId !== "<new>") {
    const existing = az(
      [
        "role", "assignment", "list",
        "--assignee", application.appId,
        "--scope", roleScope,
        "--subscription", subscriptionId,
        "--query", `[?roleDefinitionName=='${role}'] | length(@)`,
        "-o", "tsv",
      ],
      { allowFailure: true },
    );
    if (existing && Number(existing) > 0) {
      unchanged(`${application.displayName} already has ${role}`);
      return;
    }
  }

  step(`grant ${role} to ${application.displayName} on ${roleScope.split("/").pop()}`, () => {
    az([
      "role", "assignment", "create",
      "--assignee-object-id", application.principalId,
      "--assignee-principal-type", "ServicePrincipal",
      "--role", role,
      "--scope", roleScope,
      "--subscription", subscriptionId,
      "-o", "none",
    ]);
  });
}

function setVariable(name, value) {
  step(`set variable ${name} on ${environmentName}`, () => {
    gh(["variable", "set", name, "--env", environmentName, "--repo", repository, "--body", String(value)]);
  });
}
