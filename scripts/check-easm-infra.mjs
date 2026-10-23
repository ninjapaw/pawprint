import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

if (process.argv.length !== 3) {
  throw new Error("Supply the compiled platform/org.bicep ARM JSON path.");
}
const template = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(template.parameters.deployEasm.type, "bool");
assert.equal(template.parameters.deployEasm.defaultValue, false, "EASM must remain an explicit billable opt-in.");
assert.equal(template.parameters.easmLocation.defaultValue, "[parameters('location')]");
assert.equal(template.parameters.easmWorkspaceName.minLength, 1);
assert.deepEqual(template.parameters.easmAccessBindings.defaultValue, []);
assert.equal(template.parameters.easmBudget.nullable, true);
assert.equal(template.parameters.easmProtectFromDeletion.defaultValue, false);

const modules = Object.values(template.resources).filter((resource) =>
  resource.type === "Microsoft.Resources/deployments"
  && Object.values(resource.properties?.template?.resources ?? {}).some((child) => child.type === "Microsoft.Easm/workspaces"));
assert.equal(modules.length, 1, "Declare EASM once in the shared platform, not once per workload.");
const [module] = modules;
assert.equal(module.condition, "[parameters('deployEasm')]");
assert.equal(module.resourceGroup, "[parameters('resourceGroupName')]");
assert.equal(module.properties.mode, "Incremental");
assert.equal(module.properties.parameters.workspaceName.value, "[parameters('easmWorkspaceName')]");
assert.equal(module.properties.parameters.location.value, "[parameters('easmLocation')]");
assert.equal(module.properties.parameters.tags.value, "[variables('platformTags')]");
assert.equal(module.properties.parameters.accessBindings.value, "[parameters('easmAccessBindings')]");
assert.equal(module.properties.parameters.budgetConfig.value, "[parameters('easmBudget')]");
assert.equal(module.properties.parameters.protectFromDeletion.value, "[parameters('easmProtectFromDeletion')]");

const child = module.properties.template;
const resources = Object.values(child.resources);
assert.equal(resources.length, 4, "Only workspace, bounded access, budget alerts and deletion protection are declared.");
const find = (type) => resources.find((resource) => resource.type === type);
const workspace = find("Microsoft.Easm/workspaces");
assert.equal(workspace.type, "Microsoft.Easm/workspaces");
assert.equal(workspace.apiVersion, "2023-04-01-preview");
assert.equal(workspace.name, "[parameters('workspaceName')]");
assert.equal(workspace.location, "[parameters('location')]");
assert.deepEqual(workspace.properties, {});
assert.match(workspace.tags, /parameters\('tags'\)/);
assert.match(workspace.tags, /'component', 'easm'/);
assert.doesNotMatch(JSON.stringify(child), /Microsoft\.Security\/pricings|vaults\/secrets|discoveryGroups/);
assert.doesNotMatch(JSON.stringify(template.variables.platformTags), /pawprint\.(managed|runId|expiresAt|ttlHours)/);
assert.deepEqual(child.parameters.accessBindings.defaultValue, []);
assert.equal(child.parameters.budgetConfig.nullable, true);
assert.equal(child.parameters.protectFromDeletion.defaultValue, false);
assert.deepEqual(child.variables.roleDefinitionIds, {
  Reader: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
  Contributor: "b24988ac-6180-42a0-ab88-20f7382dd24c",
});
const access = find("Microsoft.Authorization/roleAssignments");
const workspaceReference = "[resourceId('Microsoft.Easm/workspaces', parameters('workspaceName'))]";
assert.equal(access.scope, workspaceReference);
assert.equal(access.copy.count, "[length(parameters('accessBindings'))]");
assert.match(access.properties.roleDefinitionId, /roleDefinitionIds/);
assert.match(access.properties.description, /Pawprint-managed EASM/);
assert.deepEqual(child.definitions.easmAccessBinding.properties.role.allowedValues.sort(), ["Contributor", "Reader"]);
const budget = find("Microsoft.Consumption/budgets");
assert.equal(budget.condition, "[not(equals(parameters('budgetConfig'), null()))]");
assert.equal(budget.properties.category, "Cost");
assert.equal(budget.properties.timeGrain, "Monthly");
assert.equal(budget.properties.amount, "[parameters('budgetConfig').monthlyAmount]");
assert.equal(budget.properties.timePeriod.startDate, "[parameters('budgetConfig').startDate]");
assert.deepEqual(budget.properties.filter.dimensions, { name: "ResourceId", operator: "In", values: [workspaceReference] });
assert.equal(child.definitions.easmBudgetConfig.properties.monthlyAmount.minValue, 1);
for (const [name, threshold, type] of [["Actual80", 80, "Actual"], ["Actual100", 100, "Actual"], ["Forecast100", 100, "Forecasted"]]) {
  const notification = budget.properties.notifications[name];
  assert.equal(notification.enabled, true);
  assert.equal(notification.operator, "GreaterThanOrEqualTo");
  assert.equal(notification.threshold, threshold);
  assert.equal(notification.thresholdType, type);
  assert.equal(notification.contactEmails, "[parameters('budgetConfig').contactEmails]");
}
const protection = find("Microsoft.Authorization/locks");
assert.equal(protection.scope, workspaceReference);
assert.equal(protection.condition, "[parameters('protectFromDeletion')]");
assert.equal(protection.properties.level, "CanNotDelete");

for (const name of ["easmWorkspaceId", "easmWorkspaceName", "easmDataPlaneEndpoint"]) {
  assert.equal(template.outputs[name].type, "string");
  assert.match(template.outputs[name].value, /^(\[if\(parameters\('deployEasm'\),)/);
  assert.match(template.outputs[name].value, /, ''\)\]$/);
}
assert.match(child.outputs.dataPlaneEndpoint.value, /dataPlaneEndpoint/);
assert.doesNotMatch(Object.keys(child.outputs).join(" "), /secret|token|password|connectionString/i);
console.log("Verified shared EASM: default-off workspace, opt-in workspace-only Reader/Contributor access, EASM-only budget alerts, optional deletion lock, safe outputs, and no ARM discovery, secrets, or Defender pricing changes.");
