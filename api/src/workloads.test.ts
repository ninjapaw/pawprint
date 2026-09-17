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

  it("resolves the dojo's per-scenario deploy and uninstall actions", () => {
    expect(
      resolveWorkflow("ninjapaws-cloud-security-dojo", "scenario1-uninstall"),
    ).toEqual({
      repository: "ninjapaw/ninjapaws-cloud-security-dojo",
      workflow: {
        workflow: "uninstall.yml",
        inputs: {
          environment: "dev",
          confirm_resource_group: "NP-ninjapaws-dojo-Dev-CentralUS",
          no_wait: "false",
        },
      },
    });
    expect(
      resolveWorkflow("ninjapaws-cloud-security-dojo", "scenario2-deploy"),
    ).toEqual({
      repository: "ninjapaw/ninjapaws-cloud-security-dojo",
      workflow: {
        workflow: "deploy-sql-scenario.yml",
        inputs: { stage: "deploy", environment: "dev" },
      },
    });
    expect(
      resolveWorkflow("ninjapaws-cloud-security-dojo", "scenario2-uninstall"),
    ).toEqual({
      repository: "ninjapaw/ninjapaws-cloud-security-dojo",
      workflow: {
        workflow: "deploy-sql-scenario.yml",
        inputs: {
          stage: "uninstall",
          environment: "dev",
          confirm_resource_group: "NP-ninjapaws-dojo-sql-Dev-CentralUS",
        },
      },
    });
  });
});
