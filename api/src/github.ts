import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { createHash } from "node:crypto";
import { cached } from "./cache.js";
import { SourceError } from "./azure.js";
import { isRecord } from "./runtime.js";

export interface GitHubAppConfiguration {
  appId: string;
  installationId: string;
  privateKey: string;
}

let authKey = "";
let authenticate: ReturnType<typeof createAppAuth> | undefined;
const boundedRequest = request.defaults({
  request: {
    fetch: (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) =>
      fetch(url, { ...options, signal: AbortSignal.timeout(8000), redirect: "error" }),
  },
});

async function installationToken(configuration: GitHubAppConfiguration, repository: string, write: boolean) {
  const [owner, repo] = repository.split("/");
  if (owner !== "ninjapaw" || !repo || !/^[a-z0-9][a-z0-9-]*$/.test(repo)) throw new SourceError("unavailable");
  const key = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  if (!authenticate || key !== authKey) {
    authenticate = createAppAuth({
      appId: configuration.appId, privateKey: configuration.privateKey,
      installationId: Number(configuration.installationId),
      request: boundedRequest,
    });
    authKey = key;
  }
  const installation = await authenticate({
    type: "installation", repositoryNames: [repo],
    permissions: { actions: write ? "write" : "read", metadata: "read" },
  });
  return { owner, repo, token: installation.token };
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
  ref: "main" = "main",
): Promise<void> {
  const { owner, repo, token } = await installationToken(configuration, repository, true);
  await boundedRequest(
    "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    {
      owner,
      repo,
      workflow_id: workflow,
      ref,
      inputs,
      headers: {
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      request: { timeout: 8000, signal: AbortSignal.timeout(8000) },
    },
  );
}

export interface WorkflowRun {
  id: number;
  title: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
}
export interface WorkflowObservation {
  state: "observed" | "not-configured" | "access-needed" | "rate-limited" | "unavailable";
  source: string;
  observedAt: string;
  runs: WorkflowRun[];
  message: string;
}
const readCached = cached<WorkflowObservation>(60000);
const readinessCached = cached<boolean>(60000, 8);

export function githubFailureState(error: unknown): WorkflowObservation["state"] {
  const status = isRecord(error) ? error.status : undefined;
  const response = isRecord(error) && isRecord(error.response) ? error.response : null;
  const headers = response && isRecord(response.headers) ? response.headers : {};
  if (status === 429 || (status === 403 && (headers["x-ratelimit-remaining"] === "0" || typeof headers["retry-after"] === "string"))) return "rate-limited";
  return status === 401 || status === 403 || status === 404 ? "access-needed" : "unavailable";
}

export function verifyDispatchAccess(configuration: GitHubAppConfiguration, repository: string, workflow: string): Promise<boolean> {
  return readinessCached(`${configuration.appId}:${configuration.installationId}:${repository}:${workflow}`, async () => {
    try {
      const { owner, repo, token } = await installationToken(configuration, repository, true);
      const result = await boundedRequest("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", {
        owner, repo, workflow_id: workflow,
        headers: { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
        request: { timeout: 8000, signal: AbortSignal.timeout(8000) },
      });
      return result.data.state === "active";
    } catch {
      return false;
    }
  });
}

export async function workflowObservation(repository: string, workflow: string, ref: "main"): Promise<WorkflowObservation> {
  const configuration = githubConfiguration();
  if (!configuration) return {
    state: "not-configured", source: "GitHub App · Actions", observedAt: new Date().toISOString(), runs: [],
    message: "A narrowly installed GitHub App is required. No anonymous browser polling is used.",
  };
  return readCached(`${repository}:${workflow}:${ref}:${configuration.appId}:${configuration.installationId}`, async () => {
    const base = { source: "GitHub App · Actions", observedAt: new Date().toISOString() };
    try {
      const { owner, repo, token } = await installationToken(configuration, repository, false);
      const result = await boundedRequest("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
        owner, repo, workflow_id: workflow, branch: ref, per_page: 50,
        headers: { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
        request: { timeout: 8000, signal: AbortSignal.timeout(8000) },
      });
      const runs = result.data.workflow_runs.flatMap((run) => {
        if (typeof run.id !== "number" || !Number.isSafeInteger(run.id) || typeof run.display_title !== "string"
          || typeof run.created_at !== "string" || typeof run.status !== "string") return [];
        return [{
          id: run.id,
          title: repository === "ninjapaw/pawprint" && workflow === "shared-easm.yml" ? run.display_title.slice(0, 300) : "Workflow run",
          status: run.status,
          conclusion: run.conclusion ?? null, createdAt: run.created_at,
          url: `https://github.com/${repository}/actions/runs/${run.id}`,
        }];
      });
      return { ...base, state: "observed", runs, message: runs.length ? "Main-branch workflow results may include dev and prod; they are not live application health." : "No matching main-branch workflow run was found." };
    } catch (error) {
      return {
        ...base, state: githubFailureState(error),
        runs: [], message: "Workflow observations are unavailable; installation access, rate limits or network readiness may need attention.",
      };
    }
  });
}
