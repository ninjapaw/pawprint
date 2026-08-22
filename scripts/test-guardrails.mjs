/**
 * Guardrail tests for the configuration resolver.
 *
 * These assert the negative paths. A guardrail that never fires is worse than
 * no guardrail, because it manufactures false confidence.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVER = join(REPO_ROOT, "scripts", "pawprint-config.mjs");
const WORK_DIR = mkdtempSync(join(tmpdir(), "pawprint-guardrails-"));

function runResolver(args) {
  const result = spawnSync(process.execPath, [RESOLVER, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeConfig(name, contents) {
  const path = join(WORK_DIR, name);
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

const cases = [
  {
    name: "rejects a secret-shaped key in committed config",
    args: () => ["--environment", "dev", "--config", writeConfig("secret.json", {
      configVersion: "1.0.0",
      defaults: { clientSecret: "oops" },
    })],
    expect: /clientSecret|not allowed|additional properties|must NOT/i,
  },
  {
    name: "rejects a secret-shaped key regardless of casing",
    args: () => ["--environment", "dev", "--config", writeConfig("secret-cased.json", {
      configVersion: "1.0.0",
      defaults: { MY_API_KEY: "oops" },
    })],
    expect: /not allowed|must NOT|additional properties/i,
  },
  {
    name: "rejects a populated subscriptionId in committed config",
    args: () => ["--environment", "dev", "--config", writeConfig("subscription.json", {
      configVersion: "1.0.0",
      environments: { dev: { subscriptionId: "11111111-2222-3333-4444-555555555555" } },
    })],
    expect: /subscriptionId|must be equal to constant/i,
  },
  {
    name: "rejects an incompatible major configVersion",
    args: () => ["--environment", "dev", "--config", writeConfig("version.json", {
      configVersion: "2.0.0",
    })],
    expect: /Major versions are not compatible|migrate/i,
  },
  {
    name: "rejects a branch that does not own the requested environment",
    args: () => ["--branch", "main", "--environment", "dev"],
    expect: /does not own environment/i,
  },
  {
    name: "rejects an unknown environment",
    args: () => ["--environment", "staging"],
    expect: /Unknown environment/i,
  },
  {
    name: "requires an environment or branch selector",
    args: () => [],
    expect: /--environment|--branch/i,
  },
  {
    name: "refuses a subscription when no allowlist is configured",
    args: () => ["--environment", "dev", "--subscription", "16037566-d4df-4c7c-b484-346d8472b4c4"],
    expect: /No approved subscriptions are configured/i,
  },
  {
    name: "refuses a subscription absent from the allowlist",
    args: () => [
      "--environment",
      "dev",
      "--subscription",
      "99999999-9999-9999-9999-999999999999",
      "--config",
      writeConfig("allowlist.json", {
        configVersion: "1.0.0",
        defaults: { approvedSubscriptions: ["16037566-d4df-4c7c-b484-346d8472b4c4"] },
      }),
    ],
    expect: /is not in the approved list/i,
  },
  {
    name: "rejects a malformed subscription id in the allowlist",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig("bad-allowlist.json", {
        configVersion: "1.0.0",
        defaults: { approvedSubscriptions: ["not-a-guid"] },
      }),
    ],
    expect: /pattern|must match/i,
  },
];

let failures = 0;

for (const testCase of cases) {
  const { code, stderr, stdout } = runResolver(testCase.args());
  const output = `${stdout}${stderr}`;

  if (code === 0) {
    failures += 1;
    process.stderr.write(`FAIL  ${testCase.name}\n      expected a non-zero exit, got 0\n`);
    continue;
  }
  if (!testCase.expect.test(output)) {
    failures += 1;
    process.stderr.write(
      `FAIL  ${testCase.name}\n      exit ${code} but message did not match ${testCase.expect}\n` +
        `      got: ${output.trim().split("\n").join("\n           ")}\n`,
    );
    continue;
  }
  process.stdout.write(`ok    ${testCase.name}\n`);
}

// A positive control, so a resolver that rejects everything cannot pass this suite.
const healthy = runResolver(["--environment", "dev", "--check"]);
if (healthy.code !== 0) {
  failures += 1;
  process.stderr.write(`FAIL  accepts the shipped default configuration\n      ${healthy.stderr.trim()}\n`);
} else {
  process.stdout.write("ok    accepts the shipped default configuration\n");
}

// The allowlist must permit as well as refuse, otherwise it is just a wall.
const approvedPath = writeConfig("approved.json", {
  configVersion: "1.0.0",
  defaults: { approvedSubscriptions: ["16037566-d4df-4c7c-b484-346d8472b4c4"] },
});
const approved = runResolver([
  "--environment",
  "dev",
  "--check",
  "--config",
  approvedPath,
  "--subscription",
  "16037566-D4DF-4C7C-B484-346D8472B4C4",
]);
if (approved.code !== 0) {
  failures += 1;
  process.stderr.write(
    `FAIL  accepts an approved subscription regardless of case\n      ${approved.stderr.trim()}\n`,
  );
} else {
  process.stdout.write("ok    accepts an approved subscription regardless of case\n");
}

if (failures > 0) {
  process.stderr.write(`\n${failures} guardrail test(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll guardrail tests passed.\n");
