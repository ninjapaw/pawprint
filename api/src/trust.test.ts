import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { armJson } from "./azure.js";
import { backendTrust, isolatedSettings } from "./trust.js";

vi.mock("./azure.js", async (original) => ({
  ...await original<typeof import("./azure.js")>(), armJson: vi.fn(),
}));
const settings = (clientId = "pinned-provider") => ({ properties: {
  platform: { enabled: true }, httpSettings: { requireHttps: true },
  globalValidation: { requireAuthentication: true, unauthenticatedClientAction: "Return401", excludedPaths: ["/api/health"] },
  identityProviders: { azureStaticWebApps: { enabled: true, registration: { clientId } } },
} });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("cryptographic platform boundary attestation", () => {
  it("accepts only linked-only Easy Auth settings, not decoded headers", () => {
    expect(isolatedSettings(settings(), "pinned-provider")).toBe(true);
    expect(isolatedSettings(settings(), "other-site")).toBe(false);
    const alternate = settings();
    expect(isolatedSettings({ properties: {
      ...alternate.properties,
      identityProviders: { ...alternate.properties.identityProviders, azureActiveDirectory: { enabled: true } },
    } }, "pinned-provider")).toBe(false);
    for (const path of ["/api/*", "/*", "/api/shared/status"]) {
      const open = settings();
      open.properties.globalValidation.excludedPaths = [path];
      expect(isolatedSettings(open, "pinned-provider")).toBe(false);
    }
    const anonymous = settings();
    anonymous.properties.globalValidation.requireAuthentication = false;
    expect(isolatedSettings(anonymous, "pinned-provider")).toBe(false);
  });
  it("fails closed when no live boundary can be verified", async () => {
    vi.stubEnv("PORTAL_BACKEND_RESOURCE_ID", "");
    expect((await backendTrust()).state).toBe("setup-required");
    expect(armJson).not.toHaveBeenCalled();
  });
  it.each([true, false])("reads current ARM settings and verifies the actual linked resource: %s", async (matches) => {
    const backendId = "/subscriptions/10000000-0000-4000-8000-000000000001/resourceGroups/test-group/providers/Microsoft.Web/sites/test-api";
    const siteId = "/subscriptions/10000000-0000-4000-8000-000000000001/resourceGroups/test-group/providers/Microsoft.Web/staticSites/test-site";
    const pin = randomUUID();
    vi.stubEnv("PORTAL_BACKEND_RESOURCE_ID", backendId);
    vi.stubEnv("PORTAL_STATIC_SITE_RESOURCE_ID", siteId);
    vi.stubEnv("PORTAL_LINKED_BACKEND_CLIENT_ID", pin);
    vi.stubEnv("WEBSITE_SITE_NAME", "test-api");
    vi.stubEnv("WEBSITE_RESOURCE_GROUP", "test-group");
    vi.mocked(armJson).mockImplementation(async (path) =>
      path.includes("authsettingsV2") ? settings(pin) : { properties: { backendResourceId: matches ? backendId : `${backendId}-foreign` } },
    );
    expect((await backendTrust()).state).toBe(matches ? "verified" : "setup-required");
  });
});
