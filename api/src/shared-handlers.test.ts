import { HttpRequest, InvocationContext } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendTrust } from "./trust.js";
import { sharedOverview } from "./observations.js";
import { sharedStatus, sharedPreview, sharedRequest, rolesSource } from "./shared-handlers.js";
import { adminStatus, dispatch, health } from "./handlers.js";

vi.mock("./trust.js", () => ({ backendTrust: vi.fn() }));
vi.mock("./observations.js", () => ({ sharedOverview: vi.fn(async () => []) }));
const context = new InvocationContext({ functionName: "shared-test", logHandler: () => undefined });
const principal = (role = "admin", provider = "aad") => Buffer.from(JSON.stringify({
  identityProvider: provider, userId: "synthetic-operator", userDetails: "synthetic", userRoles: ["authenticated", role],
})).toString("base64");
function request(role = "admin", headers: Record<string, string> = {}, data: unknown = {}) {
  return new HttpRequest({
    url: "https://direct-function.example/api/shared/status?environment=dev", method: "POST",
    headers: { "x-ms-client-principal": principal(role), origin: "https://portal.example", "content-type": "application/json", ...headers },
    body: { string: JSON.stringify(data) },
  });
}
beforeEach(() => {
  vi.stubEnv("PORTAL_AUTH_MODE", "workforce");
  vi.stubEnv("PORTAL_ENTRA_TENANT_ID", "10000000-0000-4000-8000-000000000001");
  vi.stubEnv("PORTAL_ENTRA_CLIENT_ID", "20000000-0000-4000-8000-000000000002");
  vi.stubEnv("PORTAL_ALLOWED_ORIGIN", "https://portal.example");
  vi.mocked(backendTrust).mockResolvedValue({
    state: "verified", source: "Synthetic ARM fixture", observedAt: "2026-10-01T00:00:00Z", message: "Fixture only",
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("shared route trust and authorization", () => {
  it("never turns a spoofed decoded header into private status without verified isolation", async () => {
    vi.mocked(backendTrust).mockResolvedValue({
      state: "setup-required", source: "Azure ARM", observedAt: "2026-10-01T00:00:00Z", message: "Isolation not verified",
    });
    expect(await sharedStatus(request(), context)).toMatchObject({ status: 503 });
    expect(await adminStatus(request(), context)).toMatchObject({ status: 503 });
    expect(await dispatch(request(), context)).toMatchObject({ status: 503 });
    expect(sharedOverview).not.toHaveBeenCalled();
  });
  it("does not expose shared routes while the legacy provider model is active", async () => {
    vi.stubEnv("PORTAL_AUTH_MODE", "legacy");
    expect(await sharedStatus(request(), context)).toMatchObject({ status: 503 });
    expect(sharedOverview).not.toHaveBeenCalled();
  });
  it("denies unknown roles and GitHub identities even with a forged admin role", async () => {
    expect(await sharedStatus(request("Owner"), context)).toMatchObject({ status: 403 });
    expect(await sharedStatus(request("admin", { "x-ms-client-principal": principal("admin", "github") }), context)).toMatchObject({ status: 403 });
    expect(await dispatch(request("admin", { "x-ms-client-principal": principal("admin", "github") }), context)).toMatchObject({ status: 403 });
    expect(sharedOverview).not.toHaveBeenCalled();
  });
  it("allows a trusted reader to view only, never create previews or requests", async () => {
    expect(await sharedStatus(request("reader"), context)).toMatchObject({ status: 200 });
    expect(await sharedPreview(request("reader"), context)).toMatchObject({ status: 403 });
    expect(await sharedRequest(request("reader"), context)).toMatchObject({ status: 403 });
  });
  it("rejects cross-origin, missing-origin and non-JSON requests before touching operation storage", async () => {
    for (const origin of ["https://foreign.example", ""]) {
      expect(await sharedPreview(request("admin", { origin }), context)).toMatchObject({ status: 403 });
    }
    expect(await sharedPreview(request("admin", { "content-type": "text/plain" }), context)).toMatchObject({ status: 415 });
  });
  it("rejects arbitrary browser targets and environments", async () => {
    expect(await sharedPreview(request("admin", {}, { actionId: "verify", environment: "dev", url: "https://arbitrary.example" }), context)).toMatchObject({ status: 400 });
    expect(await sharedPreview(request("admin", {}, { actionId: "verify", environment: "test" }), context)).toMatchObject({ status: 400 });
  });
  it("rejects cross-tenant role source claims and keeps health minimal", async () => {
    expect(await rolesSource(request("admin", {}, {
      identityProvider: "aad", claims: [{ typ: "tid", val: "30000000-0000-4000-8000-000000000003" }, { typ: "roles", val: "PawPrint.Admin" }],
    }), context)).toMatchObject({ status: 200, jsonBody: { roles: [] } });
    expect(await health(request(), context)).toMatchObject({ status: 200, jsonBody: { status: "ok" } });
  });
});
