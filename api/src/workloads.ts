export interface WorkflowStep {
  workflow: string;
  inputs: Readonly<Record<string, string>>;
}

export interface Workload {
  repository: `ninjapaw/${string}`;
  steps: Readonly<Record<string, WorkflowStep>>;
}

export const workloads: Readonly<Record<string, Workload>> = {
  m365profiles: {
    repository: "ninjapaw/m365profiles",
    steps: {
      infrastructure: {
        workflow: "deploy-azure-infrastructure.yml",
        inputs: { environment: "dev", operation: "deploy", "site-sku": "Free" },
      },
      application: { workflow: "deploy.yml", inputs: { environment: "dev" } },
    },
  },
  site: {
    repository: "ninjapaw/site",
    steps: {
      infrastructure: {
        workflow: "deploy-azure-infrastructure.yml",
        inputs: { environment: "dev", operation: "deploy" },
      },
      application: { workflow: "deploy.yml", inputs: { environment: "dev" } },
    },
  },
  "sentinel-optimizer": {
    repository: "ninjapaw/sentinel-optimizer",
    steps: {
      infrastructure: {
        workflow: "deploy-azure-infrastructure.yml",
        inputs: { component: "all", environment: "dev", operation: "deploy" },
      },
      application: {
        workflow: "deploy-application.yml",
        inputs: { environment: "dev" },
      },
    },
  },
  "ninjapaws-cloud-security-dojo": {
    repository: "ninjapaw/ninjapaws-cloud-security-dojo",
    steps: {
      // Scenario 1 (NGINX CVE / App Service + ACR) — scripts/deploy.sh via deploy.yml.
      application: { workflow: "deploy.yml", inputs: { stage: "full" } },
      // Reuses the repo's existing dedicated, exact-name-confirmed uninstall.yml rather than
      // adding a second, less-guarded uninstall path to deploy.yml. Note this ALSO clears the
      // repo's GitHub Environment variables (AZURE_CLIENT_ID etc.), so a redeploy after this
      // needs scripts/setup-azure-github-oidc.sh re-run before the "Deploy" button works again.
      "scenario1-uninstall": {
        workflow: "uninstall.yml",
        inputs: {
          environment: "dev",
          confirm_resource_group: "NP-ninjapaws-dojo-Dev-CentralUS",
          no_wait: "false",
        },
      },
      // Scenario 2 (SQL Server on Azure VM) is a separate architecture with its own
      // workflow — scripts/deploy-sql-scenario.sh via deploy-sql-scenario.yml.
      "scenario2-deploy": {
        workflow: "deploy-sql-scenario.yml",
        inputs: { stage: "deploy", environment: "dev" },
      },
      "scenario2-uninstall": {
        workflow: "deploy-sql-scenario.yml",
        inputs: {
          stage: "uninstall",
          environment: "dev",
          confirm_resource_group: "NP-ninjapaws-dojo-sql-Dev-CentralUS",
        },
      },
    },
  },
};

export function resolveWorkflow(workloadId: string, stepId: string): {
  repository: string;
  workflow: WorkflowStep;
} | null {
  const workload = workloads[workloadId];
  const workflow = workload?.steps[stepId];
  return workload && workflow ? { repository: workload.repository, workflow } : null;
}