import { afterEach, describe, expect, it, vi } from "vitest";
import { armJson, SourceError } from "./azure.js";
import { sharedOverview } from "./observations.js";
import { workflowObservation } from "./github.js";

vi.mock("./azure.js", async (original) => ({
  ...await original<typeof import("./azure.js")>(), armJson: vi.fn(),
}));
vi.mock("./github.js", () => ({
  workflowObservation: vi.fn(async () => ({
    state: "observed", source: "Synthetic GitHub fixture", observedAt: new Date().toISOString(), message: "Workflow, not health",
    runs: [{ id: 1, title: "Synthetic", status: "completed", conclusion: "success", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/ninjapaw/pawprint/actions/runs/1" }],
  })),
}));
const dns = vi.hoisted(() => ({ resolve: vi.fn(async () => ["ns.synthetic.example"]) }));
vi.mock("node:dns/promises", () => ({
  Resolver: class { resolveNs = dns.resolve; cancel() {} },
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("honest shared-service observations", () => {
  it("keeps workflow success separate from unknown application health and missing resources", async () => {
    vi.stubEnv("PORTAL_SOURCES_JSON", "");
    const services = await sharedOverview("dev");
    const service = services.find((item) => item.id === "m365profiles");
    expect(service?.workflow?.runs[0]?.conclusion).toBe("success");
    expect(workflowObservation).toHaveBeenCalledWith("ninjapaw/m365profiles", "deploy.yml", "main");
    expect(service?.health.state).toBe("unknown");
    expect(service?.provisioning[0]?.state).toBe("not-configured");
    expect(armJson).not.toHaveBeenCalled();
    const publicDns = services.find((item) => item.id === "external-dns");
    expect(publicDns?.dns).toHaveLength(3);
    expect(publicDns?.dns[0]?.message).toContain("ownership");
  });
  it("does not equate succeeded provisioning with EASM coverage, or expose budget contents", async () => {
    const scope = "/subscriptions/10000000-0000-4000-8000-000000000001/resourceGroups/NP-Platform-Dev-CentralUS";
    vi.stubEnv("PORTAL_SOURCES_JSON", JSON.stringify({
      subscriptions: { dev: "10000000-0000-4000-8000-000000000001" },
      bindings: { "shared-easm": { dev: {
        desired: "enabled", resourceIds: [`${scope}/providers/Microsoft.Easm/workspaces/fixture-observation`],
        budgetResourceId: `${scope}/providers/Microsoft.Consumption/budgets/fixture-budget`,
      } } },
    }));
    vi.mocked(armJson).mockImplementation(async (path) => {
      if (path.includes("ResourceHealth")) throw new SourceError("unavailable", 404);
      if (path.includes("budgets")) return { properties: { amount: 98765, notifications: { private: { contactEmails: ["not-exposed@example.invalid"] } } } };
      return { properties: { provisioningState: "Succeeded" } };
    });
    const services = await sharedOverview("dev");
    const easm = services.find((item) => item.id === "shared-easm");
    expect(easm?.provisioning[0]?.state).toBe("Succeeded");
    expect(easm?.health.state).toBe("unknown");
    expect(easm?.availability[0]?.state).toBe("unknown");
    expect(easm?.budget?.state).toBe("observed");
    expect(JSON.stringify(services)).not.toContain("98765");
    expect(JSON.stringify(services)).not.toContain("contactEmails");
    expect(JSON.stringify(services)).not.toContain("/subscriptions/");
  });
});
