import { createHash, randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { managedIdentity } from "./azure.js";
import { githubConfiguration, dispatchWorkflow, workflowObservation, verifyDispatchAccess } from "./github.js";
import { isEnvironment, isRecord, runtimeSources, uuidPattern, type Environment } from "./runtime.js";
import type { ClientPrincipal, PortalRole } from "./auth.js";

export const sharedActions = [
  { id: "validate", label: "Validate configuration", role: "operator", write: false, discovery: false },
  { id: "plan", label: "Review plan", role: "operator", write: false, discovery: false },
  { id: "what-if", label: "Azure what-if", role: "operator", write: false, discovery: false },
  { id: "discovery-plan", label: "Review discovery plan", role: "operator", write: false, discovery: false },
  { id: "verify", label: "Verify EASM", role: "operator", write: false, discovery: false },
  { id: "register-provider", label: "Request provider registration", role: "admin", write: true, discovery: false },
  { id: "deploy", label: "Request EASM deployment", role: "admin", write: true, discovery: false },
  { id: "discovery-apply", label: "Request discovery group application", role: "admin", write: true, discovery: true },
  { id: "run-discovery", label: "Request discovery run", role: "admin", write: true, discovery: true },
] as const;
export type SharedActionId = typeof sharedActions[number]["id"];
export type RequestState = "preview" | "requesting" | "accepted" | "uncertain" | "rejected";
export interface ActionRecord {
  requestId: string;
  actionId: SharedActionId;
  environment: Environment;
  actorHash: string;
  createdAt: string;
  expiresAt: string;
  state: RequestState;
}
export interface RecordStore {
  ready(): Promise<void>;
  create(record: ActionRecord): Promise<void>;
  read(id: string): Promise<ActionRecord | null>;
  locked<T>(id: string, run: (record: ActionRecord, save: (record: ActionRecord) => Promise<void>) => Promise<T>): Promise<T>;
}
export class OperationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const actorHash = (principal: ClientPrincipal) => createHash("sha256")
  .update(`${principal.identityProvider}:${principal.userId}`).digest("hex");

export function parseActionRecord(value: unknown): ActionRecord | null {
  if (!isRecord(value) || typeof value.requestId !== "string" || !uuidPattern.test(value.requestId)
    || !isEnvironment(value.environment) || typeof value.actorHash !== "string" || !/^[a-f0-9]{64}$/.test(value.actorHash)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return null;
  const action = sharedActions.find((item) => item.id === value.actionId);
  const state = value.state;
  if (!action || (state !== "preview" && state !== "requesting" && state !== "accepted" && state !== "uncertain" && state !== "rejected")) return null;
  return {
    requestId: value.requestId, environment: value.environment, actorHash: value.actorHash,
    actionId: action.id, state, createdAt: value.createdAt, expiresAt: value.expiresAt,
  };
}

class BlobRecordStore implements RecordStore {
  private readonly container;
  constructor(endpoint: string) {
    this.container = new BlobServiceClient(endpoint, managedIdentity, {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 8000 },
    }).getContainerClient("portal-operation-records");
  }
  private blob(id: string) {
    if (!uuidPattern.test(id)) throw new OperationError(400, "Invalid request ID.");
    return this.container.getBlockBlobClient(`${id}.json`);
  }
  async ready() {
    const properties = await this.container.getProperties({ abortSignal: AbortSignal.timeout(8000) });
    if (properties.blobPublicAccess) throw new OperationError(503, "Operation records must be private.");
  }
  async create(record: ActionRecord) {
    await this.blob(record.requestId).uploadData(Buffer.from(JSON.stringify(record)), {
      conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" },
      abortSignal: AbortSignal.timeout(8000),
    });
  }
  async read(id: string): Promise<ActionRecord | null> {
    try {
      const data = await this.blob(id).downloadToBuffer(0, 8192, { abortSignal: AbortSignal.timeout(8000) });
      const value: unknown = JSON.parse(data.toString("utf8"));
      const record = parseActionRecord(value);
      if (!record || record.requestId !== id) throw new OperationError(503, "The operation record is invalid; dispatch is blocked.");
      return record;
    } catch (error) {
      if (isRecord(error) && error.statusCode === 404) return null;
      throw error;
    }
  }
  async locked<T>(id: string, run: (record: ActionRecord, save: (record: ActionRecord) => Promise<void>) => Promise<T>): Promise<T> {
    const blob = this.blob(id);
    const lease = blob.getBlobLeaseClient();
    try {
      await lease.acquireLease(30, { abortSignal: AbortSignal.timeout(8000) });
    } catch {
      throw new OperationError(409, "This request is being processed or its durable lease is unavailable. Check the same request ID; do not create an automatic retry.");
    }
    try {
      const record = await this.read(id);
      if (!record) throw new OperationError(404, "Unknown operation request.");
      return await run(record, async (next) => {
        await blob.uploadData(Buffer.from(JSON.stringify(next)), {
          conditions: { leaseId: lease.leaseId }, blobHTTPHeaders: { blobContentType: "application/json" },
          abortSignal: AbortSignal.timeout(8000),
        });
      });
    } finally {
      await lease.releaseLease({ abortSignal: AbortSignal.timeout(8000) }).catch(() => undefined);
    }
  }
}

export function operationStore(): RecordStore | null {
  const endpoint = process.env.PORTAL_ACTION_RECORDS_BLOB_ENDPOINT?.trim();
  return endpoint && /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/?$/.test(endpoint)
    ? new BlobRecordStore(endpoint) : null;
}

export function actionReadiness(environment: Environment): { configured: boolean; message: string } {
  const source = runtimeSources()?.bindings["shared-easm"]?.[environment];
  const reviewed = process.env.PORTAL_EASM_REVIEWED_ENVIRONMENTS?.split(",").map((item) => item.trim()) ?? [];
  if (process.env.PORTAL_SHARED_ACTIONS_ENABLED !== "true" || !reviewed.includes(environment)) return {
    configured: false, message: "Hosted EASM requests are disabled until this environment's protected configuration and cost/discovery gates have been reviewed.",
  };
  if (source?.desired !== "enabled" || !source.resourceIds.length) return {
    configured: false, message: "An enabled, approved EASM runtime binding is required. Protected scopes are not edited in the browser.",
  };
  if (!operationStore() || !githubConfiguration()) return {
    configured: false, message: "A private durable record container and dedicated GitHub App are required. Use the protected workflow link.",
  };
  return {
    configured: true, message: "Runtime review is declared; preview still verifies GitHub access and private record storage. Protected GitHub Environment gates remain authoritative.",
  };
}

function permitted(role: PortalRole, actionId: SharedActionId) {
  const action = sharedActions.find((item) => item.id === actionId);
  return action && role !== "reader" && (action.role !== "admin" || role === "admin") ? action : null;
}

export async function createPreview(store: RecordStore, principal: ClientPrincipal, role: PortalRole, actionId: SharedActionId, environment: Environment) {
  const action = permitted(role, actionId);
  if (!action) throw new OperationError(403, "This role cannot request that operation.");
  const readiness = actionReadiness(environment);
  if (!readiness.configured) throw new OperationError(503, readiness.message);
  const configuration = githubConfiguration();
  if (!configuration || !await verifyDispatchAccess(configuration, "ninjapaw/pawprint", "shared-easm.yml")) {
    throw new OperationError(503, "The dedicated App cannot obtain repository-scoped Actions write access to an active fixed EASM workflow. Open the protected workflow instead.");
  }
  await store.ready();
  const record: ActionRecord = {
    requestId: randomUUID(), actionId, environment, actorHash: actorHash(principal),
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), state: "preview",
  };
  await store.create(record);
  return {
    ...publicRecord(record), action,
    repository: "ninjapaw/pawprint", workflow: "shared-easm.yml", ref: environment === "prod" ? "main" : "dev",
    notice: "This request uses the CURRENT protected Environment EASM_CONFIG_JSON, not a scope snapshot. Scopes, seeds, budgets and subscriptions cannot be edited here. GitHub approvals, cost and discovery gates still apply. Confirming requests a workflow; it does not prove that a run has started.",
  };
}

function publicRecord(record: ActionRecord) {
  return {
    requestId: record.requestId, actionId: record.actionId, environment: record.environment,
    state: record.state === "requesting" ? "uncertain" : record.state,
    createdAt: record.createdAt, expiresAt: record.expiresAt,
  };
}

export async function confirmRequest(
  store: RecordStore, principal: ClientPrincipal, role: PortalRole, requestId: string,
  confirmation: { confirmProtectedConfiguration: boolean; approveWrite: boolean; approveDiscovery: boolean },
) {
  return store.locked(requestId, async (record, save) => {
    if (record.actorHash !== actorHash(principal)) throw new OperationError(403, "This request belongs to another operator.");
    const action = permitted(role, record.actionId);
    if (!action) throw new OperationError(403, "This role cannot request that operation.");
    if (record.state !== "preview") return {
      ...publicRecord(record), message: "Existing durable request returned. No duplicate dispatch was sent.",
    };
    if (Date.parse(record.expiresAt) < Date.now()) throw new OperationError(409, "Preview expired. Review a new preview before requesting this operation.");
    const readiness = actionReadiness(record.environment);
    if (!readiness.configured) throw new OperationError(503, readiness.message);
    if (!confirmation.confirmProtectedConfiguration || (action.write && !confirmation.approveWrite)
      || (action.discovery && !confirmation.approveDiscovery)) throw new OperationError(400, "Explicit protected-configuration, write and discovery confirmations are required for the selected action.");
    const configuration = githubConfiguration();
    if (!configuration) throw new OperationError(503, "GitHub App configuration is unavailable.");
    const requesting: ActionRecord = { ...record, state: "requesting" };
    await save(requesting);
    let state: RequestState;
    try {
      await dispatchWorkflow(configuration, "ninjapaw/pawprint", "shared-easm.yml", {
        environment: record.environment, operation: record.actionId, request_id: record.requestId,
        approve_write: action.write ? "true" : "false", approve_discovery: action.discovery ? "true" : "false",
      }, record.environment === "prod" ? "main" : "dev");
      state = "accepted";
    } catch (error) {
      const status = isRecord(error) ? error.status : undefined;
      state = typeof status === "number" && status >= 400 && status < 500 && status !== 408 ? "rejected" : "uncertain";
    }
    try {
      await save({ ...record, state });
    } catch {
      state = "uncertain";
    }
    return {
      ...publicRecord({ ...record, state }),
      message: state === "accepted" ? "GitHub accepted the request. No run has yet been correlated; started/completed is not implied."
        : state === "rejected" ? "GitHub rejected the request. Review workflow access and protection settings before making a new intentional request."
          : "The dispatch outcome is uncertain. Check this request ID and the protected workflow. Do not blindly redispatch.",
    };
  });
}

export async function requestStatus(store: RecordStore, principal: ClientPrincipal, requestId: string) {
  const record = await store.read(requestId);
  if (!record) throw new OperationError(404, "Unknown operation request.");
  if (record.actorHash !== actorHash(principal)) throw new OperationError(403, "This request belongs to another operator.");
  const workflow = await workflowObservation("ninjapaw/pawprint", "shared-easm.yml", record.environment === "prod" ? "main" : "dev");
  const title = `Shared EASM - ${record.environment} - ${record.actionId} - ${record.requestId}`;
  return {
    ...publicRecord(record), workflow: { ...workflow, runs: workflow.runs.filter((run) => run.title === title) },
    message: "Correlation searches the fixed workflow/ref and exact request title in the latest 50 runs. No match is not proof of failure; check GitHub before another request.",
  };
}
