import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";

export interface GitHubAppConfiguration {
  appId: string;
  installationId: string;
  privateKey: string;
}

export function githubConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): GitHubAppConfiguration | null {
  if (environment.GITHUB_APP_ENABLED?.toLowerCase() !== "true") return null;
  const appId = environment.GITHUB_APP_ID?.trim();
  const installationId = environment.GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKey = environment.GITHUB_APP_PRIVATE_KEY?.replaceAll(
    "\\n",
    "\n",
  ).trim();
  if (!appId || !/^\d+$/.test(appId) || Number(appId) <= 0) return null;
  if (
    !installationId ||
    !/^\d+$/.test(installationId) ||
    Number(installationId) <= 0
  )
    return null;
  if (
    !privateKey?.startsWith("-----BEGIN") ||
    !privateKey.endsWith("PRIVATE KEY-----")
  )
    return null;
  return { appId, installationId, privateKey };
}

export async function dispatchWorkflow(
  configuration: GitHubAppConfiguration,
  repository: string,
  workflow: string,
  inputs: Readonly<Record<string, string>>,
): Promise<void> {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error("Invalid allowlisted repository.");

  const auth = createAppAuth({
    appId: configuration.appId,
    privateKey: configuration.privateKey,
    installationId: Number(configuration.installationId),
  });
  const installation = await auth({ type: "installation" });
  await request(
    "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    {
      owner,
      repo,
      workflow_id: workflow,
      ref: "dev",
      inputs,
      headers: {
        authorization: `Bearer ${installation.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
}
