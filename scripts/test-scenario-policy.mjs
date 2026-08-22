/**
 * Negative tests for scenario catalog policy.
 *
 * Each case takes the known-good sample scenario and breaks exactly one thing,
 * so a failure localises to a single policy rule.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = join(REPO_ROOT, "scripts", "validate-scenario.mjs");
const SAMPLE = join(REPO_ROOT, "samples", "defender-appservice-nginx-cve.scenario.json");
const WORK_DIR = mkdtempSync(join(tmpdir(), "pawprint-scenario-policy-"));

const baseline = JSON.parse(readFileSync(SAMPLE, "utf8"));

function mutate(name, mutation) {
  const scenario = structuredClone(baseline);
  mutation(scenario);
  const path = join(WORK_DIR, `${name}.scenario.json`);
  writeFileSync(path, JSON.stringify(scenario, null, 2));
  return path;
}

function validate(path) {
  const result = spawnSync(process.execPath, [VALIDATOR, path], { encoding: "utf8" });
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const cases = [
  {
    name: "missing-destroy-stage",
    mutation: (s) => { s.stages = s.stages.filter((stage) => stage !== "destroy"); },
    expect: /destroy/i,
  },
  {
    name: "ttl-above-ceiling",
    mutation: (s) => { s.safety.defaultTtlHours = 5000; },
    expect: /ttl|maximum|ceiling/i,
  },
  {
    name: "max-ttl-below-default",
    mutation: (s) => { s.safety.maxTtlHours = 1; s.safety.defaultTtlHours = 8; },
    expect: /maxTtlHours/i,
  },
  {
    name: "vulnerable-without-disclaimer",
    mutation: (s) => { delete s.safety.disclaimer; },
    expect: /disclaimer/i,
  },
  {
    name: "public-endpoint-without-declared-ingress",
    mutation: (s) => {
      s.safety.publicIngress = false;
      delete s.safety.ingressJustification;
    },
    expect: /blast radius|publicIngress/i,
  },
  {
    name: "evidence-only-from-config",
    mutation: (s) => { s.assertions = s.assertions.map((a) => ({ ...a, source: "config" })); },
    expect: /observe the running system/i,
  },
  {
    name: "critical-parameter-without-default",
    mutation: (s) => { delete s.parameters.nginxVersion.default; },
    expect: /critical parameter/i,
  },
  {
    name: "remediation-without-verification",
    mutation: (s) => { s.assertions = s.assertions.filter((a) => a.stage !== "verify"); },
    expect: /verify/i,
  },
];

let failures = 0;

for (const testCase of cases) {
  const { code, output } = validate(mutate(testCase.name, testCase.mutation));

  if (code === 0) {
    failures += 1;
    process.stderr.write(`FAIL  ${testCase.name}\n      expected rejection, scenario was accepted\n`);
    continue;
  }
  if (!testCase.expect.test(output)) {
    failures += 1;
    process.stderr.write(
      `FAIL  ${testCase.name}\n      rejected, but message did not match ${testCase.expect}\n` +
        `      got: ${output.trim()}\n`,
    );
    continue;
  }
  process.stdout.write(`ok    rejects ${testCase.name}\n`);
}

// Positive control: the unmodified sample must still pass.
const healthy = validate(SAMPLE);
if (healthy.code !== 0) {
  failures += 1;
  process.stderr.write(`FAIL  accepts the known-good sample scenario\n      ${healthy.output.trim()}\n`);
} else {
  process.stdout.write("ok    accepts the known-good sample scenario\n");
}

if (failures > 0) {
  process.stderr.write(`\n${failures} scenario policy test(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll scenario policy tests passed.\n");
