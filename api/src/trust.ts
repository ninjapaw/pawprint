import { armJson, SourceError } from "./azure.js";
import { cached } from "./cache.js";
import { isRecord, parseResourceId } from "./runtime.js";

export interface BackendTrust {
  state: "verified" | "setup-required" | "access-needed" | "unavailable";
  source: string;
  observedAt: string;
  message: string;
}
const readCached = cached<BackendTrust>(60000, 4);
const result = (state: BackendTrust["state"], message: string): BackendTrust => ({
  state, message, source: "Azure ARM · linked backend + Easy Auth v2", observedAt: new Date().toISOString(),
});

export function isolatedSettings(value: unknown, clientId: string): boolean {
  if (!isRecord(value) || !isRecord(value.properties)) return false;
  const { platform, globalValidation, identityProviders, httpSettings } = value.properties;
  if (!isRecord(platform) || platform.enabled !== true || platform.configFilePath
    || !isRecord(globalValidation) || globalValidation.requireAuthentication !== true
    || !["Return401", "Return403"].includes(String(globalValidation.unauthenticatedClientAction))
    || !isRecord(httpSettings) || httpSettings.requireHttps !== true
    || !isRecord(identityProviders)) return false;
  const excluded = globalValidation.excludedPaths;
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.some((path) => path !== "/api/health"))) return false;
  const swa = identityProviders.azureStaticWebApps;
  if (!isRecord(swa) || swa.enabled !== true || !isRecord(swa.registration) || swa.registration.clientId !== clientId) return false;
  return Object.entries(identityProviders).every(([name, provider]) =>
    name === "azureStaticWebApps" || (name === "customOpenIdConnectProviders"
      ? isRecord(provider) && Object.keys(provider).length === 0
      : isRecord(provider) && provider.enabled === false),
  );
}

export async function backendTrust(): Promise<BackendTrust> {
  const backendId = process.env.PORTAL_BACKEND_RESOURCE_ID ?? "";
  const siteId = process.env.PORTAL_STATIC_SITE_RESOURCE_ID ?? "";
  const linkedClientId = process.env.PORTAL_LINKED_BACKEND_CLIENT_ID?.trim();
  const backend = parseResourceId(backendId);
  const site = parseResourceId(siteId);
  if (!backend || !site || !linkedClientId || linkedClientId.length > 256
    || backend.type.toLowerCase() !== "microsoft.web/sites"
    || site.type.toLowerCase() !== "microsoft.web/staticsites"
    || backend.name.toLowerCase() !== process.env.WEBSITE_SITE_NAME?.toLowerCase()
    || backend.group.toLowerCase() !== process.env.WEBSITE_RESOURCE_GROUP?.toLowerCase()) {
    return result("setup-required", "Pin this Function, the existing static site and its linked-provider client ID. No private observations have been read.");
  }
  return readCached(`${backendId}:${siteId}:${linkedClientId}`, async () => {
    try {
      const [settings, link] = await Promise.all([
        armJson(`${backendId}/config/authsettingsV2?api-version=2025-03-01`),
        armJson(`${siteId}/linkedBackends/production?api-version=2025-03-01`),
      ]);
      const linkedId = isRecord(link) && isRecord(link.properties) ? link.properties.backendResourceId : null;
      if (!isolatedSettings(settings, linkedClientId) || typeof linkedId !== "string"
        || linkedId.toLowerCase() !== backendId.toLowerCase()) {
        return result("setup-required", "Linked-only backend authentication is not verified. Shared routes remain closed.");
      }
      return result("verified", "Current ARM configuration requires the pinned SWA provider; no alternate provider or private-route authentication exception is allowed.");
    } catch (error) {
      return result(error instanceof SourceError && error.state === "access-needed" ? "access-needed" : "unavailable",
        "Unable to verify the current linked backend authentication settings. Shared routes remain closed.");
    }
  });
}
