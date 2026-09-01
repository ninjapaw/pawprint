import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGitHubAppManifest,
  GITHUB_APP_PERMISSIONS,
  GITHUB_APP_REPOSITORIES,
  validateInstallationAccess,
  validateManifestConversion,
} from "./github-app-setup.mjs";

const manifest = createGitHubAppManifest(
  "http://127.0.0.1:4173",
  "install-state",
);
assert.deepEqual(manifest.default_permissions, {
  actions: "write",
  metadata: "read",
});
assert.deepEqual(manifest.default_events, []);
assert.equal(manifest.hook_attributes.active, false);
assert.equal(manifest.public, false);
assert.equal(manifest.request_oauth_on_install, false);
assert.equal(
  manifest.setup_url,
  "http://127.0.0.1:4173/api/setup/github-app/installed?state=install-state",
);
assert.equal(GITHUB_APP_REPOSITORIES.length, 4);
assert.equal(Object.keys(GITHUB_APP_PERMISSIONS).length, 2);
assert.throws(() => createGitHubAppManifest("https://example.com"), /loopback/);
assert.deepEqual(
  validateManifestConversion({
    id: 123,
    slug: "pawprint-deploy",
    pem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  }),
  {
    id: 123,
    slug: "pawprint-deploy",
    pem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  },
);
assert.throws(() => validateManifestConversion({ id: 123 }), /incomplete/);
const appDetails = {
  owner: { login: "ninjapaw" },
  name: "NinjaPaws Pawprint Deploy",
  permissions: { actions: "write", metadata: "read" },
  events: [],
};
const installation = {
  repository_selection: "selected",
  permissions: { actions: "write", metadata: "read" },
};
assert.equal(
  validateInstallationAccess(appDetails, installation, GITHUB_APP_REPOSITORIES)
    .appValid,
  true,
);
assert.equal(
  validateInstallationAccess(
    {
      ...appDetails,
      permissions: { ...appDetails.permissions, contents: "read" },
    },
    installation,
    GITHUB_APP_REPOSITORIES,
  ).appValid,
  false,
);
assert.equal(
  validateInstallationAccess(appDetails, installation, [
    ...GITHUB_APP_REPOSITORIES,
    "unexpected-repository",
  ]).repositoriesValid,
  false,
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controller = readFileSync(
  resolve(root, "scripts/pawprint-portal.mjs"),
  "utf8",
);
const workflow = readFileSync(
  resolve(root, ".github/workflows/deploy-portal-api.yml"),
  "utf8",
);
assert.match(controller, /const remaining = await json\("az"/);
assert.doesNotMatch(controller, /const remaining = await optionalJson\("az"/);
assert.ok(
  controller.indexOf('"--settings", "GITHUB_APP_ENABLED=false"') <
    controller.lastIndexOf(
      'setGitHubVariable("PAWPRINT_GITHUB_APP_ENABLED", "false")',
    ),
  "Azure must disable before the GitHub desired-state variable changes",
);
assert.match(workflow, /env:\s+GITHUB_APP_ENABLED:/);
assert.doesNotMatch(workflow, /githubAppId="\$\{\{ vars\./);
process.stdout.write(
  "ok    GitHub App manifest is private and least-privilege\n",
);
