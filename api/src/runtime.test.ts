import { describe, expect, it } from "vitest";
import { runtimeSources, parseResourceId } from "./runtime.js";

const dev = "10000000-0000-4000-8000-000000000001";
const prod = "20000000-0000-4000-8000-000000000002";
const resource = (subscription: string, group: string, type = "Microsoft.Easm/workspaces") =>
  `/subscriptions/${subscription}/resourceGroups/${group}/providers/${type}/test`;
const environment = (bindings: unknown) => ({ PORTAL_SOURCES_JSON: JSON.stringify({ subscriptions: { dev, prod }, bindings }) });

describe("fixed runtime source bindings", () => {
  it("does not guess missing subscription IDs or resource bindings", () => {
    expect(runtimeSources({})).toEqual({ subscriptions: {}, bindings: {} });
    expect(runtimeSources({ PORTAL_SOURCES_JSON: "invalid" })).toBeNull();
  });
  it("accepts an explicitly approved resource and omits protected financial configuration", () => {
    const value = runtimeSources(environment({
      "shared-easm": { dev: { desired: "enabled", resourceIds: [resource(dev, "NP-Platform-Dev-CentralUS")] } },
    }));
    expect(value?.bindings["shared-easm"]?.dev?.resourceIds).toHaveLength(1);
  });
  it.each([
    ["unknown-service", "NP-Platform-Dev-CentralUS", dev, "Microsoft.Easm/workspaces"],
    ["shared-easm", "foreign-group", dev, "Microsoft.Easm/workspaces"],
    ["shared-easm", "NP-Platform-Dev-CentralUS", prod, "Microsoft.Easm/workspaces"],
    ["shared-easm", "NP-Platform-Dev-CentralUS", dev, "Microsoft.KeyVault/vaults"],
  ])("rejects unreviewed service/group/subscription/type: %s", (id, group, subscription, type) => {
    expect(runtimeSources(environment({ [id]: { dev: { desired: "enabled", resourceIds: [resource(subscription, group, type)] } } }))).toBeNull();
  });
  it("preserves the training dojo's intentional prod-to-dev subscription mapping", () => {
    const binding = (subscription: string) => environment({
      "ninjapaws-cloud-security-dojo": { prod: { desired: "enabled", resourceIds: [resource(subscription, "NP-ninjapaws-dojo-Prod-CentralUS", "Microsoft.Web/sites")] } },
    });
    expect(runtimeSources(binding(dev))).not.toBeNull();
    expect(runtimeSources(binding(prod))).toBeNull();
  });
  it("refuses target URLs, secret fields, unknown environments and nested paths", () => {
    for (const binding of [
      { dev: { desired: "enabled", resourceIds: ["https://attacker.example"] } },
      { dev: { desired: "enabled", resourceIds: [], token: "not-a-real-token" } },
      { test: { desired: "enabled", resourceIds: [] } },
    ]) expect(runtimeSources(environment({ "shared-easm": binding }))).toBeNull();
    expect(parseResourceId(`${resource(dev, "NP-Platform-Dev-CentralUS")}/../secrets`)).toBeNull();
  });
  it("does not bind newly cataloged training resources without a reviewed platform mapping", () => {
    expect(runtimeSources(environment({ pawton: { dev: { desired: "enabled", resourceIds: [resource(dev, "NP-Platform-Dev-CentralUS", "Microsoft.Web/sites")] } } }))).toBeNull();
  });
});
