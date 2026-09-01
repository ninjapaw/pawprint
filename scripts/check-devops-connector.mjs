/**
 * Reports whether the Defender for Cloud DevOps connector is actually
 * authorized, rather than merely present.
 *
 * The ARM resource can be created declaratively; the authorization cannot.
 * Completing a connector needs an OAuth code that only a browser flow issues
 * and a GitHub App that an organisation owner installs, so infrastructure as
 * code can only ever produce the half that does nothing. A connector stuck in
 * that state looks provisioned in the portal and discovers no repositories,
 * which is exactly the failure this checks for.
 *
 * The devops/default sub-resource is the signal: it does not exist until
 * authorization succeeds.
 *
 *   node scripts/check-devops-connector.mjs --subscription <id>
 *   node scripts/check-devops-connector.mjs --subscription <id> --github-org ninjapaw
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const API = "2023-10-01-preview";
const DEVOPS_API = "2024-04-01";

const { values } = parseArgs({
  options: {
    subscription: { type: "string" },
    "github-org": { type: "string" },
    json: { type: "boolean", default: false },
  },
});

if (!values.subscription) {
  fail("--subscription is required.");
}
if (!/^[0-9a-fA-F-]{36}$/.test(values.subscription)) {
  fail(`--subscription '${values.subscription}' is not a subscription id.`);
}
if (values["github-org"] && !/^[A-Za-z0-9-]{1,39}$/.test(values["github-org"])) {
  fail(`--github-org '${values["github-org"]}' is not a GitHub organisation name.`);
}

const WINDOWS = process.platform === "win32";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args) {
  try {
    return execFileSync(WINDOWS && command === "az" ? "az.cmd" : command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: WINDOWS,
    }).trim();
  } catch {
    return null;
  }
}

const armGet = (url) => run("az", ["rest", "--method", "GET", "--url", url, "-o", "json"]);

const connectorsRaw = armGet(
  `https://management.azure.com/subscriptions/${values.subscription}/providers/Microsoft.Security/securityConnectors?api-version=${API}`,
);
if (!connectorsRaw) {
  fail("Could not list security connectors. Check 'az login' and that the subscription is accessible.");
}

const connectors = (JSON.parse(connectorsRaw).value ?? []).filter(
  (connector) => (connector.properties?.environmentName ?? "").toLowerCase() === "github",
);

const findings = [];

for (const connector of connectors) {
  const authorized = armGet(
    `https://management.azure.com${connector.id}/devops/default?api-version=${DEVOPS_API}`,
  );
  findings.push({
    name: connector.name,
    resourceGroup: connector.id.split("/resourcegroups/")[1]?.split("/")[0] ?? "unknown",
    authorized: Boolean(authorized),
  });
}

let installations = null;
if (values["github-org"]) {
  const raw = run("gh", ["api", `/orgs/${values["github-org"]}/installations`]);
  if (raw) {
    installations = JSON.parse(raw).installations ?? [];
  }
}

if (values.json) {
  process.stdout.write(`${JSON.stringify({ connectors: findings, installations }, null, 2)}\n`);
}

let failures = 0;

if (findings.length === 0) {
  process.stdout.write("warn  no GitHub DevOps connector exists in this subscription\n");
  failures += 1;
}

for (const finding of findings) {
  if (finding.authorized) {
    process.stdout.write(`ok    ${finding.name} in ${finding.resourceGroup} is authorized\n`);
  } else {
    failures += 1;
    process.stdout.write(
      `FAIL  ${finding.name} in ${finding.resourceGroup} exists but is not authorized.\n` +
        "      It will report as provisioned and discover no repositories.\n" +
        "      Defender for Cloud > Environment settings > the connector > Authorize,\n" +
        "      then install the DevOps security GitHub app for the organisation.\n",
    );
  }
}

if (installations !== null) {
  const defender = installations.filter((installation) =>
    /security|defender/i.test(installation.app_slug ?? ""),
  );
  if (defender.length > 0) {
    process.stdout.write(`ok    GitHub app installed: ${defender.map((i) => i.app_slug).join(", ")}\n`);
  } else {
    failures += 1;
    process.stdout.write(
      `FAIL  no Defender GitHub app is installed on '${values["github-org"]}'.\n` +
        "      Authorization cannot have completed without it.\n",
    );
  }
}

if (failures > 0) {
  process.stdout.write(
    `\n${failures} connector finding(s). Authorization is interactive and cannot be scripted.\n`,
  );
  process.exit(1);
}

process.stdout.write("\nDevOps connector is authorized and discovering repositories.\n");
