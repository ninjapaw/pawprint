import { HttpRequest } from "@azure/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workforceRoles, sharedRole } from "./auth.js";

const tenant = "10000000-0000-4000-8000-000000000001";
const client = "20000000-0000-4000-8000-000000000002";
const payload = (role: string) => ({
  identityProvider: "aad",
  claims: [
    { typ: "tid", val: tenant }, { typ: "iss", val: `https://login.microsoftonline.com/${tenant}/v2.0` },
    { typ: "aud", val: client }, { typ: "roles", val: role },
  ],
});

beforeEach(() => {
  vi.stubEnv("PORTAL_AUTH_MODE", "workforce");
  vi.stubEnv("PORTAL_ENTRA_TENANT_ID", tenant);
  vi.stubEnv("PORTAL_ENTRA_CLIENT_ID", client);
});
afterEach(() => vi.unstubAllEnvs());

describe("single-tenant workforce role mapping", () => {
  it.each([
    ["PawPrint.Reader", ["reader"]], ["PawPrint.Operator", ["reader", "operator"]],
    ["PawPrint.Admin", ["reader", "operator", "admin"]], ["authenticated", []], ["Owner", []],
  ])("maps only the explicit app role %s", (role, expected) => expect(workforceRoles(payload(role))).toEqual(expected));
  it("denies foreign tenant, issuer, audience, provider and missing claims", () => {
    const valid = payload("PawPrint.Admin");
    for (const index of [0, 1, 2]) {
      const invalid = structuredClone(valid);
      const claim = invalid.claims[index];
      if (claim) claim.val = "untrusted";
      expect(workforceRoles(invalid)).toEqual([]);
    }
    expect(workforceRoles({ ...valid, identityProvider: "github" })).toEqual([]);
    expect(workforceRoles({ ...valid, claims: [{ typ: "email", val: "admin@ninjapaws.org" }] })).toEqual([]);
  });
  it("never assigns roles by email suffix or login alone", () => {
    expect(workforceRoles({ identityProvider: "aad", userDetails: "admin@ninjapaws.org", claims: [] })).toEqual([]);
    const request = new HttpRequest({ url: "https://portal.example/api/shared/status", method: "GET", headers: {
      "x-ms-client-principal": Buffer.from(JSON.stringify({
        identityProvider: "aad", userId: "test", userDetails: "admin@ninjapaws.org", userRoles: ["authenticated", "Owner"],
      })).toString("base64"),
    } });
    expect(sharedRole(request)).toBeNull();
  });
  it("supports the documented trusted rolesSource claim shape without assuming raw JWT fields exist", () => {
    expect(workforceRoles({
      identityProvider: "aad",
      claims: [
        { typ: "http://schemas.microsoft.com/identity/claims/tenantid", val: tenant },
        { typ: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role", val: "PawPrint.Reader" },
      ],
    })).toEqual(["reader"]);
  });
  it("does not silently migrate the existing invitation model", () => {
    vi.stubEnv("PORTAL_AUTH_MODE", "legacy");
    expect(workforceRoles(payload("PawPrint.Admin"))).toEqual([]);
  });
});
