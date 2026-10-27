import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePortalPreview } from "./check-portal-preview.mjs";

const target = { subscriptionId: "11111111-1111-4111-8111-111111111111", resourceGroupName: "NP-Platform-Dev-CentralUS" };
const scope = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroupName}`;

test("portal preview summarizes valid scoped changes without resource payloads or secrets", () => {
  const result = validatePortalPreview({
    status: "Succeeded",
    changes: [{
      resourceId: `${scope}/providers/Microsoft.Web/sites/portal-api`,
      changeType: "Modify",
      after: { appSettings: { secret: "never-print-this-value" } },
      delta: [{ after: "never-print-this-value" }],
    }],
  }, target);
  assert.equal(result.changeCount, 1);
  assert.deepEqual(Object.keys(result.changes[0]), ["resourceId", "changeType"]);
  assert.ok(!JSON.stringify(result).includes("never-print-this-value"));
});

test("portal preview refuses destructive, incomplete, or cross-scope changes", () => {
  for (const change of [
    { resourceId: `${scope}/providers/Microsoft.Web/sites/api`, changeType: "Delete" },
    { resourceId: `${scope}/providers/Microsoft.Web/sites/api`, changeType: "Ignore" },
    { resourceId: `${scope}/providers/Microsoft.Web/sites/api`, changeType: "Unsupported" },
    { resourceId: `${scope}-foreign/providers/Microsoft.Web/sites/api`, changeType: "Create" },
    { resourceId: `/subscriptions/${target.subscriptionId}/providers/Microsoft.Authorization/roleAssignments/foreign`, changeType: "Create" },
    { resourceId: scope, changeType: "Modify" },
  ]) assert.throws(() => validatePortalPreview({ status: "Succeeded", changes: [change] }, target));
  assert.throws(() => validatePortalPreview({ status: "Failed", changes: [] }, target));
  assert.throws(() => validatePortalPreview({ status: "Succeeded", changes: [] }, { ...target, subscriptionId: "" }));
  assert.throws(() => validatePortalPreview({ status: "Succeeded", changes: [] }, { ...target, subscriptionId: [target.subscriptionId] }));
});

test("portal preview validates canonical identifiers and exact change-count limits", () => {
  const change = { resourceId: `${scope}/providers/Microsoft.Web/sites/api`, changeType: "NoChange" };
  for (const count of [0, 500]) {
    assert.equal(validatePortalPreview({ status: "Succeeded", changes: Array(count).fill(change) }, target).changeCount, count);
  }
  assert.throws(() => validatePortalPreview({ status: "Succeeded", changes: Array(501).fill(change) }, target), /bounded change list/);
  for (const invalid of [null, [], "invalid", { resourceId: null, changeType: "Modify" }]) {
    assert.throws(() => validatePortalPreview({ status: "Succeeded", changes: [invalid] }, target), /resource changes/);
  }
  for (const suffix of ["", "Microsoft.Web/sites", "Microsoft.Web/sites/..", "Microsoft.Web/sites/../api",
    "Microsoft.Web/sites/api?secret=hidden", "Microsoft.Web/sites/api#hidden",
    "Microsoft.Web/sites/api%2fhidden", "Microsoft.Web/sites/api\thidden", "Microsoft.Web/sites/api\\hidden"]) {
    assert.throws(() => validatePortalPreview({
      status: "Succeeded", changes: [{ ...change, resourceId: `${scope}/providers/${suffix}` }],
    }, target), /invalid resource identifier/);
  }
  const resourceId = `${scope}/providers/Microsoft.Web/sites/api/config/appsettings`;
  const result = validatePortalPreview({
    status: "Succeeded",
    changes: [{ ...change, resourceId: scope.toUpperCase() }, { ...change, resourceId }],
  }, target);
  assert.equal(result.changeCount, 2);
  assert.equal(result.changes[1].resourceId, resourceId);
});

test("portal preview CLI fails explicitly without disclosing malformed report contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "pawprint-preview-test-"));
  const report = join(directory, "report.json");
  try {
    writeFileSync(report, '{"secret":"never-print-this-value", broken');
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./check-portal-preview.mjs", import.meta.url)), report,
    ], {
      env: { ...process.env, AZURE_SUBSCRIPTION_ID: target.subscriptionId, PORTAL_RESOURCE_GROUP: target.resourceGroupName },
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR: Portal what-if report is missing or invalid; contents were omitted/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("never-print-this-value"));
  } finally {
    rmSync(report);
    rmdirSync(directory);
  }
});

test("preview-only workflow has no infrastructure or code publication path", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy-portal-api.yml", import.meta.url), "utf8");
  assert.match(workflow, /preview-only:/);
  assert.match(workflow, /\n  deploy:\n    if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /az deployment group what-if/);
  assert.match(workflow, /node scripts\/check-portal-preview\.mjs/);
  assert.match(workflow, /template="\$RUNNER_TEMP\/pawprint-portal-template\.json"/);
  assert.match(workflow, /parameters="\$RUNNER_TEMP\/pawprint-portal-parameters\.json"/);
  assert.match(workflow, /az bicep build --file infra\/portal\/main\.bicep --outfile "\$template"/);
  assert.match(workflow, /az bicep build-params --file infra\/portal\/main\.dev\.bicepparam --outfile "\$parameters"/);
  assert.match(workflow, /--template-file "\$template"\s+--parameters "\$parameters"\s+githubAppEnabled=/);
  assert.match(workflow, /az deployment group what-if "\$\{args\[@\]\}"/);
  assert.match(workflow, /az deployment group create "\$\{args\[@\]\}"/);
  assert.match(workflow, /if \[\[ "\$PREVIEW_ONLY" != true \]\]/);
  assert.ok(workflow.indexOf("az deployment group what-if") < workflow.indexOf("az deployment group create"));
  for (const name of ["Sign in for Function publication", "Verify Function runtime before publication", "Deploy Function App with One Deploy", "Verify linked API and direct-host isolation"]) {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.ok(start >= 0);
    assert.match(workflow.slice(start, workflow.indexOf("\n      - ", start + 1) < 0 ? undefined : workflow.indexOf("\n      - ", start + 1)),
      /if: github\.event_name != 'workflow_dispatch' \|\| !inputs\.preview-only/);
  }
});

test("pull-request CI covers portal configuration, API code and compiled infrastructure", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /\n  pull_request:/);
  for (const script of ["portal:test", "api:test", "api:build"]) {
    assert.ok(workflow.includes(`run: npm run ${script}`));
  }
  assert.match(workflow, /files=\([^\n]*infra\/portal\/\*\*\/\*\.bicep\)/);
  assert.match(workflow, /node scripts\/check-portal-infra\.mjs/);
  assert.match(workflow, /az bicep build-params --file infra\/portal\/main\.dev\.bicepparam/);
});
