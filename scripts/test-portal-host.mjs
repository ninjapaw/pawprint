import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validatePortalHost } from "./check-portal-host.mjs";

const target = {
  subscriptionId: "11111111-1111-4111-8111-111111111111",
  resourceGroupName: "NP-Platform-Dev-CentralUS",
  functionAppName: "np-pawprint-api-dev-centralus",
  nodeVersion: "24.19.0",
};
const metadata = {
  id: `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroupName}/providers/Microsoft.Web/sites/${target.functionAppName}`,
  hostName: `${target.functionAppName}.azurewebsites.net`,
  runtimeName: "node",
  runtimeVersion: "24",
};

test("publication verifies the selected Function, runtime and Azure-assigned hostname", () => {
  assert.deepEqual(validatePortalHost(metadata, target), {
    origin: `https://${metadata.hostName}`, nodeMajor: "24",
  });
  const hostName = `${target.functionAppName}-abc123.centralus-01.azurewebsites.net`;
  assert.equal(validatePortalHost({
    ...metadata, id: metadata.id.toUpperCase(), hostName: hostName.toUpperCase(),
  }, target).origin, `https://${hostName}`);
});

test("publication refuses old, missing, malformed or non-Node runtimes", () => {
  for (const patch of [
    { runtimeVersion: "22" }, { runtimeVersion: null }, { runtimeVersion: 24 },
    { runtimeName: "python" }, { runtimeName: null },
  ]) {
    assert.throws(() => validatePortalHost({ ...metadata, ...patch }, target), /reviewed portal IaC runtime upgrade/);
  }
});

test("publication refuses foreign resources, arbitrary origins and output injection", () => {
  for (const id of [
    metadata.id.replace(target.resourceGroupName, `${target.resourceGroupName}-foreign`),
    metadata.id.replace(target.functionAppName, "other-app"),
    metadata.id.replace(target.subscriptionId, "22222222-2222-4222-8222-222222222222"),
  ]) assert.throws(() => validatePortalHost({ ...metadata, id }, target), /selected Function resource/);
  for (const hostName of [
    "other-app.azurewebsites.net", `${metadata.hostName}.attacker.example`,
    `https://${metadata.hostName}`, `${metadata.hostName}/api`,
    `${metadata.hostName}\norigin=https://attacker.example`, `${metadata.hostName}:443`,
    `${target.functionAppName}.scm.azurewebsites.net`, `${target.functionAppName}.foreign.azurewebsites.net`, null,
  ]) assert.throws(() => validatePortalHost({ ...metadata, hostName }, target), /Azure-assigned public-cloud hostname/);
  for (const value of [null, [], {}, { ...metadata, id: null }]) {
    assert.throws(() => validatePortalHost(value, target), /selected Function resource/);
  }
});

test("publication refuses unpinned or malformed deployment targets", () => {
  for (const patch of [
    { subscriptionId: "" }, { resourceGroupName: "foreign/child" }, { resourceGroupName: "group." },
    { functionAppName: "app.example" }, { nodeVersion: ">=24" }, { nodeVersion: "" },
    { subscriptionId: [target.subscriptionId] }, { resourceGroupName: [target.resourceGroupName] },
    { functionAppName: 123 }, { nodeVersion: [target.nodeVersion] },
  ]) assert.throws(() => validatePortalHost(metadata, { ...target, ...patch }), /explicit valid target/);
});

test("publication CLI emits only a verified origin and fails without leaking report contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "pawprint-host-test-"));
  const report = join(directory, "host.json");
  const invoke = () => spawnSync(process.execPath, [
    fileURLToPath(new URL("./check-portal-host.mjs", import.meta.url)), report,
  ], {
    env: {
      ...process.env, AZURE_SUBSCRIPTION_ID: target.subscriptionId,
      PORTAL_RESOURCE_GROUP: target.resourceGroupName, PORTAL_FUNCTION_APP: target.functionAppName,
    },
    encoding: "utf8",
  });
  try {
    writeFileSync(report, JSON.stringify({ ...metadata, privateSetting: "never-print-this-value" }));
    const valid = invoke();
    assert.ifError(valid.error);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout.trim(), `origin=https://${metadata.hostName}`);
    assert.equal(valid.stderr, "");
    writeFileSync(report, JSON.stringify({ ...metadata, runtimeVersion: "22", privateSetting: "never-print-this-value" }));
    const old = invoke();
    assert.ifError(old.error);
    assert.equal(old.status, 1);
    assert.equal(old.stdout, "");
    assert.match(old.stderr, /reviewed portal IaC runtime upgrade/);
    writeFileSync(report, '{"privateSetting":"never-print-this-value", broken');
    const malformed = invoke();
    assert.ifError(malformed.error);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /metadata is missing or invalid; contents were omitted/);
    for (const result of [valid, old, malformed]) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes("never-print-this-value"));
    }
  } finally {
    rmSync(report);
    rmdirSync(directory);
  }
});

test("the runtime gate follows the same pinned Node version as both packages", () => {
  const version = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
  for (const path of ["../package.json", "../api/package.json"]) {
    const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    assert.equal(manifest.engines.node, version);
  }
  const infrastructure = readFileSync(new URL("../infra/portal/api.bicep", import.meta.url), "utf8");
  assert.match(infrastructure, /loadTextContent\('\.\.\/\.\.\/\.node-version'\)/);
  assert.match(infrastructure, /version: nodeRuntimeVersion/);
});

test("publication and direct-host verification consume the runtime-checked Azure endpoint", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy-portal-api.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("- name: Verify Function runtime before publication");
  const publish = workflow.indexOf("- name: Deploy Function App with One Deploy");
  assert.ok(gate >= 0 && gate < publish);
  assert.match(workflow, /hostName:defaultHostName,runtimeName:functionAppConfig\.runtime\.name,runtimeVersion:functionAppConfig\.runtime\.version/);
  assert.match(workflow, /node scripts\/check-portal-host\.mjs "\$report" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /PORTAL_API_ORIGIN: \$\{\{ steps\.publication-target\.outputs\.origin \}\}/);
  assert.match(workflow, /"\$PORTAL_API_ORIGIN\/api\/admin\/status"/);
  assert.match(workflow, /"\$PORTAL_API_ORIGIN\/api\/shared\/status"/);
  assert.ok(!workflow.includes("https://np-pawprint-api-dev-centralus.azurewebsites.net"));
  assert.match(workflow, /probe=\([^\n]*--connect-timeout 10[^\n]*--max-time 30[^\n]*--retry 4[^\n]*--retry-max-time 150\)/);
  assert.equal(workflow.match(/curl "\$\{probe\[@\]\}"/g)?.length, 3);
  for (const source of [".node-version", "scripts/check-portal-host.mjs", "scripts/check-portal-infra.mjs", "scripts/check-portal-preview.mjs"]) {
    assert.ok(workflow.includes(`      - ${source}\n`), `${source} must trigger API deployment validation.`);
  }
});
