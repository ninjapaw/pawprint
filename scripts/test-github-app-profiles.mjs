import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  createGitHubAppManifest,
  GITHUB_APP_REPOSITORIES,
  githubAppProfileSummary,
  resolveGitHubAppProfile,
  validateInstallationAccess,
} from "./github-app-setup.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configured = JSON.parse(readFileSync(resolve(root, "config", "portal-github-app.json"), "utf8"));
const configuration = {
  defaultProfile: "legacy",
  hostedShared: {
    appName: "NinjaPaws Pawprint Deploy",
    repositories: [...GITHUB_APP_REPOSITORIES, "pawprint"],
  },
};
const appDetails = {
  owner: { login: "ninjapaw" }, name: "NinjaPaws Pawprint Deploy",
  permissions: { actions: "write", metadata: "read" }, events: [],
};
const installation = { repository_selection: "selected", permissions: { actions: "write", metadata: "read" } };
const shared = resolveGitHubAppProfile("hosted-shared", configuration);
const matches = (value) => value.appValid && value.permissionsValid && value.repositoriesValid;
const cli = (args = [], input) => spawnSync(process.execPath, ["scripts/portal-github-app-profile.mjs", ...args], {
  cwd: root, encoding: "utf8", input, timeout: 20000,
});

describe("explicit GitHub App desired profiles", () => {
  it("keeps the legacy default at exactly four repositories and rejects expansion there", () => {
    assert.equal(resolveGitHubAppProfile("legacy").id, "legacy");
    assert.equal(resolveGitHubAppProfile().id, configured.defaultProfile);
    assert.equal(GITHUB_APP_REPOSITORIES.length, 4);
    assert(matches(validateInstallationAccess(appDetails, installation, GITHUB_APP_REPOSITORIES)));
    assert.equal(validateInstallationAccess(appDetails, installation, [...GITHUB_APP_REPOSITORIES, "pawprint"]).repositoriesValid, false);
  });
  it("accepts the same dedicated App's explicitly selected hosted five-repository installation", () => {
    const result = validateInstallationAccess(appDetails, installation, shared.repositories, shared);
    assert(matches(result));
    assert.equal(result.profile, "hosted-shared");
    assert.deepEqual(result.missingRepositories, []);
    assert.deepEqual(result.unexpectedRepositories, []);
  });
  it("permits optional new catalog repositories only when each is explicitly added to desired configuration", () => {
    const approved = structuredClone(configuration);
    approved.hostedShared.repositories.push("pawton", "php2shell-cloud-defense-dojo", "code-to-cloud-security-dojo");
    const expanded = resolveGitHubAppProfile("hosted-shared", approved);
    assert.equal(expanded.repositories.length, 8);
    assert(matches(validateInstallationAccess(appDetails, installation, expanded.repositories, expanded)));
    const notApproved = validateInstallationAccess(appDetails, installation, expanded.repositories, shared);
    assert.equal(notApproved.repositoriesValid, false);
    assert.equal(notApproved.unexpectedRepositories.length, 3);
  });
  it("supports an explicitly narrower EASM-only selected installation without requiring org-wide access", () => {
    const approved = structuredClone(configuration);
    approved.hostedShared.repositories = ["pawprint"];
    const minimal = resolveGitHubAppProfile("hosted-shared", approved);
    assert(matches(validateInstallationAccess(appDetails, installation, ["pawprint"], minimal)));
    assert(githubAppProfileSummary(minimal).unselectedCatalogRepositories.includes("pawton"));
  });
  it("rejects missing pawprint, duplicates, foreign/unknown repositories and permission widening in desired configuration", () => {
    for (const repositories of [[], ["site"], ["pawprint", "pawprint"], ["pawprint", "arbitrary-repository"], ["ninjapaw/pawprint"]]) {
      const invalid = structuredClone(configuration);
      invalid.hostedShared.repositories = repositories;
      assert.throws(() => resolveGitHubAppProfile("hosted-shared", invalid));
    }
    const widened = structuredClone(configuration);
    widened.hostedShared.permissions = { contents: "write" };
    assert.throws(() => resolveGitHubAppProfile("hosted-shared", widened));
    assert.throws(() => resolveGitHubAppProfile("unknown"));
  });
  it("still rejects all-repository access, extra permissions, a foreign owner, webhooks or an unreviewed App name", () => {
    assert.equal(validateInstallationAccess(appDetails, { ...installation, repository_selection: "all" }, shared.repositories, shared).repositoriesValid, false);
    assert.equal(validateInstallationAccess(appDetails, { ...installation, permissions: { ...installation.permissions, contents: "read" } }, shared.repositories, shared).permissionsValid, false);
    for (const changed of [
      { ...appDetails, owner: { login: "foreign" } },
      { ...appDetails, events: ["push"] },
      { ...appDetails, name: "Unreviewed App" },
      { ...appDetails, permissions: { ...appDetails.permissions, members: "read" } },
    ]) assert.equal(validateInstallationAccess(changed, installation, shared.repositories, shared).appValid, false);
    assert.equal(validateInstallationAccess(appDetails, installation, GITHUB_APP_REPOSITORIES, shared).missingRepositories[0], "pawprint");
  });
  it("uses the selected profile in manifest review without adding permissions or installation mutations", () => {
    const manifest = createGitHubAppManifest("http://127.0.0.1:4173", "synthetic-state", shared);
    assert.equal(manifest.name, shared.appName);
    assert.deepEqual(manifest.default_permissions, { actions: "write", metadata: "read" });
    assert.deepEqual(manifest.default_events, []);
    assert.equal(manifest.public, false);
    assert.equal(manifest.hook_attributes.active, false);
    assert.throws(() => createGitHubAppManifest("https://untrusted.example", "state", shared), /loopback/);
  });
  it("prints offline desired state and validates supplied snapshots without claiming live readiness", () => {
    const summary = cli(["--profile", "hosted-shared"]);
    assert.equal(summary.status, 0, summary.stderr);
    assert.equal(JSON.parse(summary.stdout).liveInstallationVerified, false);
    const desired = resolveGitHubAppProfile("hosted-shared");
    const snapshot = { appDetails: { ...appDetails, name: desired.appName }, installation, repositories: desired.repositories };
    const accepted = cli(["--profile", "hosted-shared", "--audit-stdin"], JSON.stringify(snapshot));
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).matchesDesiredProfile, true);
    assert.equal(JSON.parse(accepted.stdout).liveInstallationVerified, false);
    const rejected = cli(["--profile", "legacy", "--audit-stdin"], JSON.stringify(snapshot));
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).matchesDesiredProfile, false);
    assert.equal(cli(["--profile", "unknown"]).status, 1);
  });
  it("binds every loopback audit/enable and manifest path to the same operator-selected profile", () => {
    const controller = readFileSync(resolve(root, "scripts", "pawprint-portal.mjs"), "utf8");
    assert.match(controller, /const githubAppProfile = resolveGitHubAppProfile\(process\.env\.PAWPRINT_GITHUB_APP_PROFILE\)/);
    const audits = [...controller.matchAll(/await inspectInstallation\(([^)]*)\)/g)];
    assert.equal(audits.length, 3);
    for (const [, argumentsText] of audits) assert.match(argumentsText, /, githubAppProfile$/);
    assert.match(controller, /createGitHubAppManifest\(origin, installationState, githubAppProfile\)/);
    assert.match(controller, /profile: githubAppProfile\.id/);
  });
  it("rejects malformed snapshot permission values without echoing potential credentials", () => {
    const snapshot = {
      appDetails: { ...appDetails, permissions: { private_key: "synthetic-never-echo" } },
      installation, repositories: shared.repositories,
    };
    const result = cli(["--profile", "hosted-shared", "--audit-stdin"], JSON.stringify(snapshot));
    assert.equal(result.status, 1);
    assert(!`${result.stdout}${result.stderr}`.includes("synthetic-never-echo"));
  });
});
