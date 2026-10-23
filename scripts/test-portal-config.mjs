import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { configurePortalAuth } from "./lib/portal-auth.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const base = read("public/staticwebapp.config.json");
const workforce = {
  mode: "workforce", tenantId: "10000000-0000-4000-8000-000000000001",
  clientId: "20000000-0000-4000-8000-000000000002", migrationReviewed: true,
};

describe("staged portal authentication", () => {
  it("keeps legacy invitations and providers unless an intentional migration is configured", () => {
    const result = configurePortalAuth(base, read("config/portal-auth.json"));
    assert.equal(result.auth, undefined);
    assert.deepEqual(result.routes.find((route) => route.route === "/*").allowedRoles, ["admin"]);
  });
  it("builds a tenant-specific workforce provider using ONLY the SWA managed identity setting", () => {
    const result = configurePortalAuth(base, workforce);
    const registration = result.auth.identityProviders.azureActiveDirectory.registration;
    assert.equal(registration.openIdIssuer, `https://login.microsoftonline.com/${workforce.tenantId}/v2.0`);
    assert.equal(registration.clientSecretSettingName, "OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID");
    assert.equal(result.auth.rolesSource, "/api/shared/roles");
    assert.deepEqual(result.routes.find((route) => route.route === "/*").allowedRoles, ["reader", "operator", "admin"]);
    assert.equal(result.routes[0].route, "/.auth/login/github*");
    assert.equal(result.routes[0].statusCode, 404);
    assert(!JSON.stringify(result).includes("https://api.github.com"));
  });
  it("refuses an unreviewed, common/multitenant or malformed registration", () => {
    assert.throws(() => configurePortalAuth(base, { ...workforce, migrationReviewed: false }));
    assert.throws(() => configurePortalAuth(base, { ...workforce, tenantId: "common" }));
    assert.throws(() => configurePortalAuth(base, { ...workforce, clientId: "" }));
  });
});
describe("single-source catalog and runtime schema", () => {
  it("accepts disabled/not-configured source examples without fabricated resource IDs", () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(read("schema/portal.sources.schema.json"));
    assert(validate(read("config/portal.sources.example.json")), JSON.stringify(validate.errors));
    assert(!validate({ subscriptions: {}, bindings: { arbitrary: {} } }));
    assert(!validate({ subscriptions: {}, bindings: { "shared-easm": { dev: { desired: "enabled", resourceIds: [], token: "never-accepted" } } } }));
  });
  it("keeps Azure bindings and protected configuration out of public projections", () => {
    const projected = read("public/portal-public.json");
    assert.equal(projected.services.length, 12);
    const text = JSON.stringify(projected);
    for (const privateField of ["subscriptionRef", "/subscriptions/", "resourceGroups", "EASM_CONFIG_JSON", "PRIVATE_KEY"]) assert(!text.includes(privateField));
    assert.equal(projected.workloads.length, 4);
    assert(projected.services.find((service) => service.id === "pawton").description.includes("write-capable"));
    assert.equal(projected.services.find((service) => service.id === "code-to-cloud-security-dojo").statusWorkflow, "deploy.yml");
  });
});
