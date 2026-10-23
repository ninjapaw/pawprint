import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubConfiguration, dispatchWorkflow, workflowObservation, verifyDispatchAccess } from "./github.js";
import { createPreview, confirmRequest, requestStatus, parseActionRecord, type ActionRecord, type RecordStore } from "./operations.js";
import type { ClientPrincipal } from "./auth.js";

vi.mock("./github.js", () => ({
  githubConfiguration: vi.fn(), dispatchWorkflow: vi.fn(), workflowObservation: vi.fn(),
  verifyDispatchAccess: vi.fn(),
}));
const principal: ClientPrincipal = { identityProvider: "aad", userId: "synthetic", userDetails: "synthetic", userRoles: ["authenticated", "admin"] };
const hash = createHash("sha256").update("aad:synthetic").digest("hex");
const record = (state: ActionRecord["state"] = "preview"): ActionRecord => ({
  requestId: randomUUID(), actionId: "verify", environment: "dev", actorHash: hash,
  state, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
});
class SharedDurableFixture implements RecordStore {
  records = new Map<string, ActionRecord>();
  savingFails = false;
  finalSaveFails = false;
  private queue: Promise<unknown> = Promise.resolve();
  async ready() {}
  async create(value: ActionRecord) {
    if (this.records.has(value.requestId)) throw new Error("conditional create conflict");
    this.records.set(value.requestId, value);
  }
  async read(id: string) { return this.records.get(id) ?? null; }
  async locked<T>(id: string, run: (value: ActionRecord, save: (next: ActionRecord) => Promise<void>) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const value = this.records.get(id);
      if (!value) throw new Error("not found");
      return run(value, async (next) => {
        if (this.savingFails || (this.finalSaveFails && next.state !== "requesting")) throw new Error("storage unavailable");
        this.records.set(id, next);
      });
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
const confirmation = { confirmProtectedConfiguration: true, approveWrite: false, approveDiscovery: false };

beforeEach(() => {
  vi.stubEnv("PORTAL_SHARED_ACTIONS_ENABLED", "true");
  vi.stubEnv("PORTAL_EASM_REVIEWED_ENVIRONMENTS", "dev,prod");
  vi.stubEnv("PORTAL_ACTION_RECORDS_BLOB_ENDPOINT", "https://portalfixture.blob.core.windows.net");
  vi.stubEnv("PORTAL_SOURCES_JSON", JSON.stringify({
    subscriptions: { dev: "10000000-0000-4000-8000-000000000001" },
    bindings: { "shared-easm": { dev: {
      desired: "enabled",
      resourceIds: ["/subscriptions/10000000-0000-4000-8000-000000000001/resourceGroups/NP-Platform-Dev-CentralUS/providers/Microsoft.Easm/workspaces/fixture"],
    } } },
  }));
  vi.mocked(githubConfiguration).mockReturnValue({ appId: "1", installationId: "2", privateKey: "synthetic-only" });
  vi.mocked(dispatchWorkflow).mockResolvedValue(undefined);
  vi.mocked(verifyDispatchAccess).mockResolvedValue(true);
  vi.mocked(workflowObservation).mockResolvedValue({
    state: "observed", source: "Synthetic GitHub fixture", observedAt: new Date().toISOString(), runs: [], message: "Not live",
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("durable bounded EASM requests", () => {
  it("creates a server-generated durable preview without dispatching", async () => {
    const store = new SharedDurableFixture();
    const preview = await createPreview(store, principal, "operator", "verify", "dev");
    expect(store.records.has(preview.requestId)).toBe(true);
    expect(preview.notice).toContain("CURRENT protected Environment");
    expect(preview).not.toHaveProperty("actorHash");
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });
  it("does not create a ready preview when active workflow Actions write access cannot be verified", async () => {
    vi.mocked(verifyDispatchAccess).mockResolvedValue(false);
    const store = new SharedDurableFixture();
    await expect(createPreview(store, principal, "admin", "deploy", "dev")).rejects.toMatchObject({ status: 503 });
    expect(store.records.size).toBe(0);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });
  it("fails closed for disabled configuration or missing operation storage", async () => {
    const store = new SharedDurableFixture();
    vi.stubEnv("PORTAL_SHARED_ACTIONS_ENABLED", "false");
    await expect(createPreview(store, principal, "admin", "deploy", "dev")).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("PORTAL_SHARED_ACTIONS_ENABLED", "true");
    vi.stubEnv("PORTAL_ACTION_RECORDS_BLOB_ENDPOINT", "");
    await expect(createPreview(store, principal, "admin", "deploy", "dev")).rejects.toMatchObject({ status: 503 });
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });
  it("never dispatches a Reader's preview or an Operator's privileged action", async () => {
    const store = new SharedDurableFixture();
    await expect(createPreview(store, principal, "reader", "verify", "dev")).rejects.toMatchObject({ status: 403 });
    await expect(createPreview(store, principal, "operator", "run-discovery", "dev")).rejects.toMatchObject({ status: 403 });
  });
  it("dispatches the exact fixed workflow/ref with the UUID only once across concurrent instances/retries", async () => {
    const store = new SharedDurableFixture();
    const value = record();
    await store.create(value);
    const [first, second] = await Promise.all([
      confirmRequest(store, principal, "operator", value.requestId, confirmation),
      confirmRequest(store, principal, "operator", value.requestId, confirmation),
    ]);
    expect(first.state).toBe("accepted");
    expect(second.state).toBe("accepted");
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(dispatchWorkflow).toHaveBeenCalledWith(expect.anything(), "ninjapaw/pawprint", "shared-easm.yml", {
      environment: "dev", operation: "verify", request_id: value.requestId, approve_write: "false", approve_discovery: "false",
    }, "dev");
  });
  it("returns persisted uncertainty after a crashed requesting state without re-dispatch", async () => {
    const store = new SharedDurableFixture();
    const value = record("requesting");
    await store.create(value);
    expect((await confirmRequest(store, principal, "admin", value.requestId, confirmation)).state).toBe("uncertain");
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });
  it("cannot dispatch before the requesting intent is durably persisted", async () => {
    const store = new SharedDurableFixture();
    const value = record();
    await store.create(value);
    store.savingFails = true;
    await expect(confirmRequest(store, principal, "admin", value.requestId, confirmation)).rejects.toThrow("storage unavailable");
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });
  it("persists an uncertain GitHub timeout and never blindly retries", async () => {
    const store = new SharedDurableFixture();
    const value = record();
    await store.create(value);
    vi.mocked(dispatchWorkflow).mockRejectedValue(new Error("network outcome unknown"));
    expect((await confirmRequest(store, principal, "admin", value.requestId, confirmation)).state).toBe("uncertain");
    expect((await confirmRequest(store, principal, "admin", value.requestId, confirmation)).state).toBe("uncertain");
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
  });
  it("preserves the requesting marker if the post-dispatch persistence fails", async () => {
    const store = new SharedDurableFixture();
    const value = record();
    await store.create(value);
    store.finalSaveFails = true;
    expect((await confirmRequest(store, principal, "admin", value.requestId, confirmation)).state).toBe("uncertain");
    expect((await store.read(value.requestId))?.state).toBe("requesting");
    await confirmRequest(store, principal, "admin", value.requestId, confirmation);
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
  });
  it("records a definitive rejection without turning it into an accepted request", async () => {
    const store = new SharedDurableFixture();
    const value = record();
    await store.create(value);
    vi.mocked(dispatchWorkflow).mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    expect((await confirmRequest(store, principal, "admin", value.requestId, confirmation)).state).toBe("rejected");
  });
  it("requires independent write and discovery confirmations", async () => {
    const store = new SharedDurableFixture();
    const value: ActionRecord = { ...record(), actionId: "run-discovery" };
    await store.create(value);
    await expect(confirmRequest(store, principal, "admin", value.requestId, { ...confirmation, approveWrite: true })).rejects.toMatchObject({ status: 400 });
    await confirmRequest(store, principal, "admin", value.requestId, { ...confirmation, approveWrite: true, approveDiscovery: true });
    expect(dispatchWorkflow).toHaveBeenCalledWith(expect.anything(), "ninjapaw/pawprint", "shared-easm.yml", {
      environment: "dev", operation: "run-discovery", request_id: value.requestId, approve_write: "true", approve_discovery: "true",
    }, "dev");
  });
  it("rejects expired previews, different operators and invalid durable records", async () => {
    const store = new SharedDurableFixture();
    const value: ActionRecord = { ...record(), expiresAt: "2000-01-01T00:00:00Z" };
    await store.create(value);
    await expect(confirmRequest(store, principal, "admin", value.requestId, confirmation)).rejects.toMatchObject({ status: 409 });
    await expect(confirmRequest(store, { ...principal, userId: "another-operator" }, "admin", value.requestId, confirmation)).rejects.toMatchObject({ status: 403 });
    expect(parseActionRecord({ ...value, actionId: "delete" })).toBeNull();
  });
  it("correlates only an exact fixed workflow/ref title with the request UUID", async () => {
    const store = new SharedDurableFixture();
    const value = record("accepted");
    await store.create(value);
    const title = `Shared EASM - dev - verify - ${value.requestId}`;
    vi.mocked(workflowObservation).mockResolvedValue({
      state: "observed", source: "Synthetic GitHub fixture", observedAt: new Date().toISOString(), message: "",
      runs: [title, `${title}-foreign`].map((name, index) => ({
        id: index + 1, title: name, status: "completed", conclusion: "success", createdAt: new Date().toISOString(),
        url: `https://github.com/ninjapaw/pawprint/actions/runs/${index + 1}`,
      })),
    });
    const status = await requestStatus(store, principal, value.requestId);
    expect(status.workflow.runs).toHaveLength(1);
    expect(status.state).toBe("accepted");
    expect(workflowObservation).toHaveBeenCalledWith("ninjapaw/pawprint", "shared-easm.yml", "dev");
  });
});
