import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readConfiguration = (path) =>
  JSON.parse(readFileSync(join(root, path), "utf8"));
const profileConfiguration = readConfiguration("config/portal-github-app.json");
const approvedRepositories = new Set([
  ...readConfiguration("config/portal.json").workloads.map((workload) => workload.repository),
  ...readConfiguration("config/portal-services.json").services.map((service) => service.repository).filter(Boolean),
].map((repository) => {
  if (!/^ninjapaw\/[a-z0-9][a-z0-9-]*$/.test(repository)) {
    throw new Error("Unsafe repository in the reviewed portal catalog.");
  }
  return repository.slice("ninjapaw/".length);
}));

export function resolveGitHubAppProfile(
  profileId = profileConfiguration.defaultProfile,
  configuration = profileConfiguration,
) {
  if (!configuration || !["legacy", "hosted-shared"].includes(configuration.defaultProfile)
    || Object.keys(configuration).some((key) => !["defaultProfile", "hostedShared"].includes(key))) {
    throw new Error("Invalid portal GitHub App profile configuration.");
  }
  if (profileId === "legacy") return Object.freeze({
    id: "legacy", appName: GITHUB_APP_NAME,
    repositories: GITHUB_APP_REPOSITORIES, permissions: GITHUB_APP_PERMISSIONS,
  });
  if (profileId !== "hosted-shared") throw new Error("Unknown GitHub App profile; choose legacy or hosted-shared explicitly.");
  const desired = configuration.hostedShared;
  if (!desired || Object.keys(desired).some((key) => !["appName", "repositories"].includes(key))
    || typeof desired.appName !== "string" || !desired.appName.trim() || desired.appName.length > 100
    || !Array.isArray(desired.repositories) || !desired.repositories.includes("pawprint")
    || new Set(desired.repositories).size !== desired.repositories.length
    || desired.repositories.some((repository) => !approvedRepositories.has(repository))) {
    throw new Error("The hosted-shared profile requires pawprint and an explicit, unique subset of reviewed catalog repositories; permissions cannot be broadened.");
  }
  return Object.freeze({
    id: "hosted-shared", appName: desired.appName.trim(),
    repositories: Object.freeze([...desired.repositories]), permissions: GITHUB_APP_PERMISSIONS,
  });
}

export function githubAppProfileSummary(profile) {
  return {
    profile: profile.id,
    organization: GITHUB_ORGANIZATION,
    appName: profile.appName,
    repositorySelection: "selected",
    desiredRepositories: profile.repositories,
    permissions: profile.permissions,
    unselectedCatalogRepositories: [...approvedRepositories].filter((repository) => !profile.repositories.includes(repository)).sort(),
    liveInstallationVerified: false,
  };
}

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
  profile = resolveGitHubAppProfile("legacy"),
) {
  const appPermissions = Object.fromEntries(
    Object.entries(appDetails.permissions ?? {}).filter(
      ([, value]) => value !== "none",
    ),
  );
  const appValid =
    appDetails.owner?.login?.toLowerCase() === GITHUB_ORGANIZATION &&
    appDetails.name === profile.appName &&
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
      JSON.stringify([...profile.repositories].sort());
  const missingRepositories = profile.repositories.filter((repository) => !repositoryNames.includes(repository));
  const unexpectedRepositories = repositoryNames.filter((repository) => !profile.repositories.includes(repository));
  return {
    appPermissions, appValid, permissionsValid, repositoriesValid,
    profile: profile.id, requiredRepositories: profile.repositories,
    missingRepositories, unexpectedRepositories,
  };
}

export function createGitHubAppManifest(origin, installationState = "setup", profile = resolveGitHubAppProfile("legacy")) {
  const base = new URL(origin);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") {
    throw new Error("GitHub App setup requires the loopback PawPrint Portal.");
  }
  return {
    name: profile.appName,
    url: "https://github.com/ninjapaw/pawprint",
    description:
      profile.id === "legacy"
        ? "Dispatches allowlisted Ninja Paws development workflows from PawPrint Portal."
        : "Runs fixed shared-service workflows and observes explicitly selected Ninja Paws workload workflows.",
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

export async function inspectInstallation(app, profile = resolveGitHubAppProfile("legacy")) {
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
  const validation =
    validateInstallationAccess(appDetails, installation, repositoryNames, profile);

  return {
    id: installation.id,
    account: installation.account.login,
    repositorySelection: installation.repository_selection,
    permissions: installation.permissions,
    repositories: repositoryNames,
    ...validation,
    appOwner: appDetails.owner?.login ?? null,
    appName: appDetails.name,
    appEvents: appDetails.events,
    valid: validation.appValid && validation.permissionsValid && validation.repositoriesValid,
  };
}
