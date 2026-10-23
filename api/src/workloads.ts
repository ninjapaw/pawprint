import { workloads } from "./catalog.generated.js";
export { workloads };

export interface WorkflowStep {
  workflow: string;
  inputs: Readonly<Record<string, string>>;
}

export interface Workload {
  repository: `ninjapaw/${string}`;
  steps: Readonly<Record<string, WorkflowStep>>;
}

export function resolveWorkflow(
  workloadId: string,
  stepId: string,
): { repository: string; workflow: WorkflowStep } | null {
  const catalog: Readonly<Record<string, Workload>> = workloads;
  if (!Object.hasOwn(catalog, workloadId)) return null;
  const workload = catalog[workloadId];
  if (!workload || !Object.hasOwn(workload.steps, stepId)) return null;
  const workflow = workload.steps[stepId];
  return workflow ? { repository: workload.repository, workflow } : null;
}
