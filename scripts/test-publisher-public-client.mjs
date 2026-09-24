import assert from "node:assert/strict";
import {
  assertGraphUrl,
  desiredApplication,
  planApplication,
  provisionPublicClient,
  validateManifest,
} from "./publisher-public-client.mjs";

const tenant = "11111111-2222-4333-8444-555555555555";
const resourceId = "22222222-2222-4333-8444-555555555555";
const scopeId = "33333333-2222-4333-8444-555555555555";
const appId = "44444444-2222-4333-8444-555555555555";
const objectId = "55555555-2222-4333-8444-555555555555";
const manifest = {
  schemaVersion: "1.0.0",
  key: "synthetic-public-client",
  displayName: "Synthetic client",
  description: "Test only",
  redirectUris: ["http://localhost:8400"],
  permissions: [{ resourceAppId: resourceId, scopes: ["read"] }],
  info: {
    marketingUrl: "https://example.test/",
    privacyStatementUrl: "https://example.test/privacy",
    termsOfServiceUrl: "https://example.test/terms",
    supportUrl: "https://example.test/support",
  },
};
const resource = {
  appId: resourceId,
  oauth2PermissionScopes: [{ id: scopeId, value: "read", isEnabled: true }],
};
const desired = desiredApplication(manifest, [resource]);
assert.equal(desired.signInAudience, "AzureADMultipleOrgs");
assert.equal(desired.isFallbackPublicClient, true);
assert.deepEqual(desired.requiredResourceAccess[0].resourceAccess, [
  { id: scopeId, type: "Scope" },
]);
assert.equal(desired.passwordCredentials, undefined);
assert.throws(
  () => validateManifest({ ...manifest, clientSecret: "forbidden" }),
  /Invalid/,
);
assert.throws(
  () =>
    validateManifest({ ...manifest, redirectUris: ["https://attacker.test/"] }),
  /Invalid/,
);
assert.throws(
  () =>
    validateManifest({
      ...manifest,
      permissions: [...manifest.permissions, ...manifest.permissions],
    }),
  /Duplicate/,
);
assert.throws(
  () =>
    desiredApplication(manifest, [{ ...resource, oauth2PermissionScopes: [] }]),
  /unavailable/,
);
assert.throws(
  () => assertGraphUrl("https://attacker.test/v1.0/applications"),
  /non-Graph/,
);
assert.throws(
  () => planApplication(desired, [{ displayName: desired.displayName }]),
  /unmanaged/,
);
const current = { ...structuredClone(desired), id: objectId, appId };
assert.equal(planApplication(desired, [current]).action, "found");
assert.throws(() => planApplication(desired, [current, current]), /Multiple/);
assert.throws(
  () => planApplication(desired, [{ ...current, passwordCredentials: [{}] }]),
  /confidential/,
);
assert.throws(
  () =>
    planApplication(desired, [
      {
        ...current,
        requiredResourceAccess: [
          {
            resourceAppId: resourceId,
            resourceAccess: [{ id: scopeId, type: "Role" }],
          },
        ],
      },
    ]),
  /additional permissions/,
);
assert.equal(
  planApplication(desired, [{ ...current, description: "old" }]).action,
  "update",
);

let stored;
const writes = [];
const request = async (method, url, body) => {
  if (method !== "GET") writes.push({ method, url, body });
  if (url.includes("servicePrincipals")) return { value: [resource] };
  if (method === "POST") {
    stored = { ...structuredClone(body), id: objectId, appId };
    return stored;
  }
  if (method === "PATCH") {
    Object.assign(stored, body);
    return undefined;
  }
  if (url.endsWith(`/${objectId}`)) return stored;
  return { value: stored ? [stored] : [] };
};
const options = { manifest, tenantId: tenant, activeTenantId: tenant, request };
assert.equal(
  (await provisionPublicClient({ ...options, mode: "plan" })).action,
  "create",
);
assert.equal(writes.length, 0);
assert.equal(
  (await provisionPublicClient({ ...options, mode: "apply" })).verified,
  true,
);
assert.equal(writes.length, 1);
assert.equal(
  (await provisionPublicClient({ ...options, mode: "apply" })).action,
  "found",
);
assert.equal(writes.length, 1);
stored.description = "old";
assert.equal(
  (await provisionPublicClient({ ...options, mode: "apply" })).action,
  "update",
);
assert.equal(writes.length, 2);
assert.equal(
  (await provisionPublicClient({ ...options, mode: "apply" })).action,
  "found",
);
assert.equal(writes.length, 2);
await assert.rejects(
  provisionPublicClient({ ...options, tenantId: resourceId, mode: "apply" }),
  /tenant/,
);
await assert.rejects(
  provisionPublicClient({
    ...options,
    mode: "plan",
    request: async () => ({
      value: [],
      "@odata.nextLink": "https://attacker.test/v1.0/",
    }),
  }),
  /non-Graph/,
);
assert.equal(writes.length, 2);
console.log(
  "Public-client validation, ownership, permission, tenant, pagination, dry-run, read-back and two-run idempotency checks passed.",
);
