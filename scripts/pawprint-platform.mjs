/**
 * Reports how far the organisation's platform is from the state
 * config/platform.json declares.
 *
 * Onboarding is several ordered steps across two systems, and until now the
 * only way to know where a repository stood was to query Azure and GitHub by
 * hand. Everything this reports was found that way at least once during setup:
 * a repository with no identity at all, credentials whose subject could never
 * match, a service principal holding no roles, and a security connector that
 * had looked provisioned for weeks without ever being authorized.
 *
 *   node scripts/pawprint-platform.mjs --environment dev --subscription <id>
 *
 * Read-only. Nothing here changes anything; pawprint-onboard.mjs does that.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO_ROOT, "config", "platform.json");
const WINDOWS = process.platform === "win32";

const { values } = parseArgs({
  options: {
    environment: { type: "string", default: "dev" },
    subscription: { type: "string", multiple: true, default: [] },
    manifest: { type: "string", default: MANIFEST },
  },
});

// Accepts ref=id pairs because an environment is not always one subscription:
// a workload may sit somewhere other than its environment's default, and that
// should be declared rather than reported as a missing resource group.
const subscriptions = new Map();
for (const pair of values.subscription) {
  const [ref, id] = pair.includes("=") ? pair.split("=", 2) : [null, pair];
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    fail(`'${id}' is not a subscription id.`);
  }
  subscriptions.set(ref ?? values.environment, id);
}
if (subscriptions.size === 0) {
  fail(
    "--subscription <ref>=<id> is required; subscription ids are supplied at runtime, not committed.",
  );
}

const manifest = JSON.parse(readFileSync(values.manifest, "utf8"));
const environmentName = values.environment;
const environment = manifest.environments?.[environmentName];
if (!environment) {
  fail(
    `Environment '${environmentName}' is not declared in ${values.manifest}.`,
  );
}

const organisation = manifest.githubOrganisation;

function subscriptionFor(ref) {
  const resolved = subscriptions.get(ref ?? environmentName);
  if (!resolved) {
    fail(
      `No subscription supplied for '${ref ?? environmentName}'. Pass --subscription ${ref ?? environmentName}=<id>.`,
    );
  }
  return resolved;
}

const subscription = subscriptionFor(environment.subscriptionRef);

let problems = 0;
let blocked = 0;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args) {
  try {
    return execFileSync(
      WINDOWS && command === "az" ? "az.cmd" : command,
      args,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: WINDOWS,
      },
    ).trim();
  } catch {
    return null;
  }
}

const ok = (message) => process.stdout.write(`  ok       ${message}\n`);
const gap = (message) => {
  problems += 1;
  process.stdout.write(`  MISSING  ${message}\n`);
};
// Declared as unresolved in the manifest: a decision is owed before anything
// can be automated, so it is reported without counting as a defect.
const undecided = (message) => {
  blocked += 1;
  process.stdout.write(`  DECIDE   ${message}\n`);
};

const ghJson = (path) => {
  const raw = run("gh", ["api", path]);
  return raw ? JSON.parse(raw) : null;
};

process.stdout.write(
  `\nPlatform status: ${organisation} / ${environmentName}\n\n`,
);

// --- organisation ----------------------------------------------------------

process.stdout.write("organisation\n");
const orgVariables = ghJson(
  `orgs/${organisation}/actions/variables?per_page=100`,
);
for (const [name, expected] of Object.entries(
  manifest.organisationVariables ?? {},
)) {
  const actual = orgVariables?.variables?.find(
    (variable) => variable.name === name,
  );
  if (!actual) {
    gap(`organisation variable ${name} is not set`);
  } else if (actual.value !== expected) {
    gap(
      `organisation variable ${name} is '${actual.value}', expected '${expected}'`,
    );
  } else {
    ok(`organisation variable ${name}`);
  }
}

// --- platform resource group ----------------------------------------------

process.stdout.write("\nplatform\n");
const platformGroup = environment.platformResourceGroup;
if (
  run("az", [
    "group",
    "exists",
    "--name",
    platformGroup,
    "--subscription",
    subscription,
  ]) === "true"
) {
  ok(`resource group ${platformGroup}`);
} else {
  gap(
    `resource group ${platformGroup} does not exist; deploy platform/org.bicep`,
  );
}

if (environment.hostsDevOpsConnector) {
  const connectors = run("az", [
    "rest",
    "--method",
    "GET",
    "--url",
    `https://management.azure.com/subscriptions/${subscription}/providers/Microsoft.Security/securityConnectors?api-version=2023-10-01-preview`,
    "-o",
    "json",
  ]);
  const github = (connectors ? JSON.parse(connectors).value : []).filter(
    (connector) =>
      (connector.properties?.environmentName ?? "").toLowerCase() === "github",
  );
  if (github.length === 0) {
    gap("no Defender DevOps connector exists");
  } else {
    for (const connector of github) {
      const authorized = run("az", [
        "rest",
        "--method",
        "GET",
        "--url",
        `https://management.azure.com${connector.id}/devops/default?api-version=2024-04-01`,
        "-o",
        "json",
      ]);
      if (authorized) {
        ok(`DevOps connector ${connector.name} is authorized`);
      } else {
        gap(
          `DevOps connector ${connector.name} exists but was never authorized; that step is interactive`,
        );
      }
    }
  }
}

// --- repositories ----------------------------------------------------------

for (const [name, repository] of Object.entries(manifest.repositories ?? {})) {
  const declared = repository.environments?.[environmentName];
  if (repository.role === "kit" || !declared) {
    continue;
  }

  process.stdout.write(`\n${name} / ${environmentName}\n`);

  if (declared.note && !declared.resourceGroup) {
    undecided(declared.note);
    continue;
  }
  if (declared.note) {
    undecided(declared.note);
  }

  const repositorySubscription = subscriptionFor(declared.subscriptionRef);

  if (
    run("az", [
      "group",
      "exists",
      "--name",
      declared.resourceGroup,
      "--subscription",
      repositorySubscription,
    ]) === "true"
  ) {
    ok(
      `resource group ${declared.resourceGroup}` +
        (declared.subscriptionRef
          ? ` (in the ${declared.subscriptionRef} subscription)`
          : ""),
    );
  } else {
    gap(
      `resource group ${declared.resourceGroup} does not exist in the ${declared.subscriptionRef ?? environmentName} subscription`,
    );
  }

  const ghEnvironment = ghJson(
    `repos/${organisation}/${name}/environments/${environmentName}`,
  );
  if (!ghEnvironment) {
    gap(`GitHub environment '${environmentName}' does not exist`);
    continue;
  }
  const policies = ghJson(
    `repos/${organisation}/${name}/environments/${environmentName}/deployment-branch-policies`,
  );
  const boundTo = (policies?.branch_policies ?? []).map(
    (policy) => policy.name,
  );
  if (boundTo.includes(environment.branch)) {
    ok(`environment is bound to branch '${environment.branch}'`);
  } else {
    gap(
      `environment is not restricted to branch '${environment.branch}'; any branch can request its token`,
    );
  }

  const variables = ghJson(
    `repos/${organisation}/${name}/environments/${environmentName}/variables?per_page=100`,
  );
  for (const required of ["AZURE_CLIENT_ID", "AZURE_SUBSCRIPTION_ID"]) {
    if (
      (variables?.variables ?? []).some(
        (variable) => variable.name === required,
      )
    ) {
      ok(`variable ${required}`);
    } else {
      gap(`variable ${required} is not set`);
    }
  }

  for (const [kind, appName] of [
    ["infrastructure", declared.infrastructureApp],
    ["api", declared.apiApp],
  ]) {
    if (!appName) {
      continue;
    }
    checkApplication(kind, appName, declared, name, repositorySubscription);
  }
}

function checkApplication(
  kind,
  appName,
  declared,
  repositoryName,
  repositorySubscription,
) {
  // Queried by --display-name rather than a JMESPath filter: the filter needs
  // embedded quotes, which a shell strips.
  const appId = run("az", [
    "ad",
    "app",
    "list",
    "--display-name",
    appName,
    "--query",
    "[0].appId",
    "-o",
    "tsv",
  ]);
  if (!appId) {
    gap(`${kind} application '${appName}' does not exist`);
    return;
  }
  ok(`${kind} application ${appName}`);

  const objectId = run("az", [
    "ad",
    "app",
    "show",
    "--id",
    appId,
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  const credentials = JSON.parse(
    run("az", [
      "ad",
      "app",
      "federated-credential",
      "list",
      "--id",
      objectId,
      "-o",
      "json",
    ]) ?? "[]",
  );
  const expected = `repo:${organisation}/${repositoryName}:environment:${environmentName}`;
  const match = credentials.find(
    (credential) => credential.subject === expected,
  );
  if (match) {
    ok(`${kind} credential trusts ${expected}`);
  } else {
    const found =
      credentials.map((credential) => credential.subject).join(", ") || "none";
    gap(`${kind} credential does not trust ${expected}; found ${found}`);
  }

  if (
    !run("az", [
      "ad",
      "sp",
      "show",
      "--id",
      appId,
      "--query",
      "id",
      "-o",
      "tsv",
    ])
  ) {
    gap(
      `${kind} application has no service principal, so it can hold no roles`,
    );
    return;
  }

  // Listed across the subscription and filtered by prefix: a role scoped to a
  // single resource inside the group, which is what a well-scoped workload
  // identity looks like, does not appear when querying the group scope.
  const groupScope = `/subscriptions/${repositorySubscription}/resourceGroups/${declared.resourceGroup}`;
  const assignments = JSON.parse(
    run("az", [
      "role",
      "assignment",
      "list",
      "--assignee",
      appId,
      "--all",
      "--subscription",
      repositorySubscription,
      "--query",
      "[].{role:roleDefinitionName,scope:scope}",
      "-o",
      "json",
    ]) ?? "[]",
  ).filter((assignment) =>
    assignment.scope.toLowerCase().startsWith(groupScope.toLowerCase()),
  );

  if (assignments.length === 0) {
    // A documented reason means the absence is understood and owed a decision,
    // not an oversight to be closed by handing out a role.
    const documented = declared[`${kind}Note`];
    if (documented) {
      undecided(`${kind} identity holds no roles: ${documented}`);
    } else {
      gap(
        `${kind} identity holds no roles on ${declared.resourceGroup}; deployments would fail on the first call`,
      );
    }
  } else {
    const described = assignments.map((assignment) =>
      assignment.scope.toLowerCase() === groupScope.toLowerCase()
        ? assignment.role
        : `${assignment.role} (on ${assignment.scope.split("/").pop()})`,
    );
    ok(`${kind} roles: ${described.join(", ")}`);
  }
}

process.stdout.write(
  `\n${problems} gap(s), ${blocked} decision(s) outstanding.\n` +
    (problems > 0 ? "Close gaps with scripts/pawprint-onboard.mjs.\n" : ""),
);

process.exit(problems > 0 ? 1 : 0);
