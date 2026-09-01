import { describe, expect, it } from "vitest";
import { resolveWorkflow } from "./workloads.js";

describe("workflow allowlist", () => {
  it("resolves a known development action", () => {
    expect(resolveWorkflow("site", "application")).toEqual({
      repository: "ninjapaw/site",
      workflow: { workflow: "deploy.yml", inputs: { environment: "dev" } },
    });
  });

  it("rejects browser-supplied workflow names", () => {
    expect(resolveWorkflow("site", "../../arbitrary.yml")).toBeNull();
    expect(resolveWorkflow("unknown", "application")).toBeNull();
  });
});