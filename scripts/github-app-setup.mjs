import { createAppAuth } from "@octokit/auth-app";

export const GITHUB_ORGANIZATION = "ninjapaw";
export const GITHUB_APP_NAME = "NinjaPaws Pawprint Deploy";
export const GITHUB_APP_REPOSITORIES = Object.freeze([
  "m365profiles",
  "site",
  "sentinel-optimizer",
  "ninjapaws-cloud-security-dojo",
]);
export const GITHUB_APP_PERMISSIONS = Object.freeze({
  actions: "write",
  metadata: "read",
});

function exactPermissions(actual) {
  const active = Object.entries(actual ?? {})
    .filter(([, value]) => value !== "none")
    .sort(([left], [right]) => left.localeCompare(right));
  const expected = Object.entries(GITHUB_APP_PERMISSIONS).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return JSON.stringify(active) === JSON.stringify(expected);
}

export function validateInstallationAccess(
  appDetails,
  installation,
  repositoryNames,
) {
  const appPermissions = Object.fromEntries(
    Object.entries(appDetails.permissions ?? {}).filter(
      ([, value]) => value !== "none",
    ),
  );
  const appValid =
    appDetails.owner?.login?.toLowerCase() === GITHUB_ORGANIZATION &&
    appDetails.name === GITHUB_APP_NAME &&
    exactPermissions(appPermissions) &&
    Array.isArray(appDetails.events) &&
    appDetails.events.length === 0;
  const installedPermissions = Object.fromEntries(
    Object.entries(installation.permissions ?? {}).filter(
      ([, value]) => value !== "none",
    ),
  );
  const permissionsValid = exactPermissions(installedPermissions);
  const repositoriesValid =
    installation.repository_selection === "selected" &&
    JSON.stringify([...repositoryNames].sort()) ===
      JSON.stringify([...GITHUB_APP_REPOSITORIES].sort());
  return { appPermissions, appValid, permissionsValid, repositoriesValid };
}

export function createGitHubAppManifest(origin, installationState = "setup") {
  const base = new URL(origin);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") {
    throw new Error("GitHub App setup requires the loopback PawPrint Portal.");
  }
  return {
    name: GITHUB_APP_NAME,
    url: "https://github.com/ninjapaw/pawprint",
    description:
      "Dispatches allowlisted Ninja Paws development workflows from PawPrint Portal.",
    redirect_url: `${origin}/api/setup/github-app/callback`,
    setup_url: `${origin}/api/setup/github-app/installed?state=${installationState}`,
    setup_on_update: true,
    public: false,
    request_oauth_on_install: false,
    hook_attributes: {
      url: `${origin}/api/setup/github-app/webhook`,
      active: false,
    },
    default_events: [],
    default_permissions: GITHUB_APP_PERMISSIONS,
  };
}

export function validateManifestConversion(app) {
  if (
    !Number.isInteger(app?.id) ||
    app.id <= 0 ||
    !/^[a-z0-9-]+$/.test(app?.slug ?? "") ||
    typeof app?.pem !== "string" ||
    !app.pem.startsWith("-----BEGIN") ||
    !app.pem.trim().endsWith("PRIVATE KEY-----")
  ) {
    throw new Error("GitHub returned an incomplete App manifest conversion.");
  }
  return {
    id: app.id,
    slug: app.slug,
    pem: app.pem,
  };
}

async function appToken(app) {
  const auth = createAppAuth({ appId: app.id, privateKey: app.pem });
  return (await auth({ type: "app" })).token;
}

export async function githubAppRequest(app, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${await appToken(app)}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub App API ${path} returned ${response.status}.`);
  }
  return response.status === 204 ? null : response.json();
}

export async function inspectInstallation(app) {
  const appDetails = await githubAppRequest(app, "/app");
  const installations = await githubAppRequest(
    app,
    "/app/installations?per_page=100",
  );
  const installation = installations.find(
    (candidate) =>
      candidate.account?.login?.toLowerCase() === GITHUB_ORGANIZATION,
  );
  if (!installation) return null;

  const auth = createAppAuth({
    appId: app.id,
    privateKey: app.pem,
    installationId: installation.id,
  });
  const installationToken = await auth({ type: "installation" });
  const repositoriesResponse = await fetch(
    "https://api.github.com/installation/repositories?per_page=100",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${installationToken.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!repositoriesResponse.ok) {
    throw new Error(
      `GitHub installation repository audit returned ${repositoriesResponse.status}.`,
    );
  }
  const repositoryNames = (await repositoriesResponse.json()).repositories
    .map((repository) => repository.name)
    .sort();
  const { appPermissions, appValid, permissionsValid, repositoriesValid } =
    validateInstallationAccess(appDetails, installation, repositoryNames);

  return {
    id: installation.id,
    account: installation.account.login,
    repositorySelection: installation.repository_selection,
    permissions: installation.permissions,
    repositories: repositoryNames,
    appValid,
    appOwner: appDetails.owner?.login ?? null,
    appName: appDetails.name,
    appEvents: appDetails.events,
    appPermissions,
    valid: appValid && permissionsValid && repositoriesValid,
    permissionsValid,
    repositoriesValid,
  };
}
