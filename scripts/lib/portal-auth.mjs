import assert from "node:assert/strict";

const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function validatePortalAuth(auth) {
  assert(auth && ["legacy", "workforce"].includes(auth.mode), "Unknown portal authentication mode.");
  assert(Object.keys(auth).every((key) => ["mode", "tenantId", "clientId", "migrationReviewed"].includes(key)), "Unexpected authentication settings.");
  assert.equal(typeof auth.migrationReviewed, "boolean", "Migration review must be an explicit boolean.");
  for (const id of [auth.tenantId, auth.clientId]) assert(typeof id === "string" && (id === "" || guid.test(id)), "Authentication IDs must be blank or GUIDs.");
  if (auth.mode === "workforce") {
    assert.equal(auth.migrationReviewed, true, "Workforce migration must be intentionally reviewed; this flag is not evidence of live verification.");
    assert(guid.test(auth.tenantId) && guid.test(auth.clientId), "A single approved tenant and dedicated workforce app ID are required.");
    assert.notEqual(auth.tenantId, auth.clientId, "Tenant and app IDs must be distinct.");
  }
  return auth;
}

export function configurePortalAuth(base, settings) {
  const auth = validatePortalAuth(settings);
  const result = structuredClone(base);
  result.globalHeaders["Content-Security-Policy"] = result.globalHeaders["Content-Security-Policy"].replace(" https://api.github.com", "");
  if (auth.mode === "legacy") return result;
  result.auth = {
    rolesSource: "/api/shared/roles",
    identityProviders: {
      azureActiveDirectory: {
        registration: {
          openIdIssuer: `https://login.microsoftonline.com/${auth.tenantId}/v2.0`,
          clientIdSettingName: "PORTAL_ENTRA_CLIENT_ID",
          clientSecretSettingName: "OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID",
        },
      },
    },
  };
  result.routes = [
    { route: "/.auth/login/github*", statusCode: 404 },
    ...result.routes.map((route) => route.route === "/api/shared/roles"
      ? { route: "/api/shared/roles", allowedRoles: ["anonymous"] }
      : route.route === "/*"
        ? { ...route, allowedRoles: ["reader", "operator", "admin"] }
        : route),
  ];
  return result;
}
