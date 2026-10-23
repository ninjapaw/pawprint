import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operationStore, type ActionRecord } from "./operations.js";

const mocks = vi.hoisted(() => ({
  container: vi.fn(), blob: vi.fn(), properties: vi.fn(), upload: vi.fn(), download: vi.fn(),
  acquire: vi.fn(), release: vi.fn(),
}));
vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: class {
    getContainerClient(name: string) {
      mocks.container(name);
      return {
        getProperties: mocks.properties,
        getBlockBlobClient: (name: string) => {
          mocks.blob(name);
          return {
            uploadData: mocks.upload, downloadToBuffer: mocks.download,
            getBlobLeaseClient: () => ({ leaseId: "synthetic-lease", acquireLease: mocks.acquire, releaseLease: mocks.release }),
          };
        },
      };
    }
  },
}));
beforeEach(() => {
  vi.stubEnv("PORTAL_ACTION_RECORDS_BLOB_ENDPOINT", "https://portalfixture.blob.core.windows.net");
  mocks.properties.mockResolvedValue({});
  mocks.acquire.mockResolvedValue({});
  mocks.release.mockResolvedValue({});
  mocks.upload.mockResolvedValue({});
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
const value = (): ActionRecord => ({
  requestId: randomUUID(), actionId: "verify", environment: "dev", state: "preview",
  actorHash: createHash("sha256").update("synthetic").digest("hex"),
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
});
describe("private Blob conditional records and leases", () => {
  it("uses the fixed private container and conditional create", async () => {
    const store = operationStore();
    expect(store).not.toBeNull();
    const record = value();
    await store?.ready();
    await store?.create(record);
    expect(mocks.container).toHaveBeenCalledWith("portal-operation-records");
    expect(mocks.blob).toHaveBeenCalledWith(`${record.requestId}.json`);
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ conditions: { ifNoneMatch: "*" } }));
  });
  it("serializes record writes with a server Blob lease and always releases it", async () => {
    const store = operationStore();
    const record = value();
    mocks.download.mockResolvedValue(Buffer.from(JSON.stringify(record)));
    await store?.locked(record.requestId, async (current, save) => {
      await save({ ...current, state: "requesting" });
    });
    expect(mocks.acquire).toHaveBeenCalledWith(30, expect.anything());
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ conditions: { leaseId: "synthetic-lease" } }));
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("rejects public records, arbitrary storage endpoints and invalid IDs", async () => {
    const store = operationStore();
    mocks.properties.mockResolvedValue({ blobPublicAccess: "container" });
    await expect(store?.ready()).rejects.toMatchObject({ status: 503 });
    await expect(store?.read("../arbitrary")).rejects.toMatchObject({ status: 400 });
    vi.stubEnv("PORTAL_ACTION_RECORDS_BLOB_ENDPOINT", "https://foreign.example");
    expect(operationStore()).toBeNull();
  });
  it("does not run a dispatch callback when a durable lease cannot be acquired", async () => {
    const store = operationStore();
    const callback = vi.fn();
    mocks.acquire.mockRejectedValue(new Error("lease conflict"));
    await expect(store?.locked(randomUUID(), callback)).rejects.toMatchObject({ status: 409 });
    expect(callback).not.toHaveBeenCalled();
  });
});
