import { readFileSync } from "node:fs";
import {
  githubAppProfileSummary,
  resolveGitHubAppProfile,
  validateInstallationAccess,
} from "./github-app-setup.mjs";

try {
  let profileId;
  let audit = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const option = process.argv[index];
    if (option === "--profile" && profileId === undefined) {
      profileId = process.argv[++index];
      if (!profileId || profileId.startsWith("--")) throw new Error("--profile requires a profile ID.");
    } else if (option === "--audit-stdin" && !audit) {
      audit = true;
    } else {
      throw new Error("Usage: node scripts/portal-github-app-profile.mjs [--profile legacy|hosted-shared] [--audit-stdin]");
    }
  }
  const profile = resolveGitHubAppProfile(profileId);
  const result = githubAppProfileSummary(profile);
  if (audit) {
    const input = readFileSync(0, "utf8");
    if (input.length > 128 * 1024) throw new Error("Audit snapshot is too large.");
    const snapshot = JSON.parse(input);
    const permissionMap = (value) => value && typeof value === "object" && !Array.isArray(value)
      && Object.values(value).every((permission) => ["none", "read", "write"].includes(permission));
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || Object.keys(snapshot).some((key) => !["appDetails", "installation", "repositories"].includes(key))
      || !snapshot.appDetails || !snapshot.installation || !Array.isArray(snapshot.repositories)
      || !permissionMap(snapshot.appDetails.permissions) || !permissionMap(snapshot.installation.permissions)
      || !snapshot.repositories.every((repository) => typeof repository === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(repository))) {
      throw new Error("Supply appDetails, installation and repository names only; no tokens or private keys.");
    }
    const validation = validateInstallationAccess(snapshot.appDetails, snapshot.installation, snapshot.repositories, profile);
    const matchesDesiredProfile = validation.appValid && validation.permissionsValid && validation.repositoriesValid;
    Object.assign(result, { auditSource: "provided offline snapshot", matchesDesiredProfile, validation });
    if (!matchesDesiredProfile) process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch {
  process.stderr.write("GitHub App profile check failed. Use a configured legacy/hosted-shared profile and an audit snapshot containing only App metadata, installation metadata and repository names. No live service was contacted.\n");
  process.exitCode = 1;
}
