const inventoryRoot = document.querySelector("[data-platform-inventory]");
const accessGrid = document.querySelector("[data-access-grid]");
const ownerWarning = document.querySelector("[data-owner-warning]");
const message = document.querySelector("[data-platform-message]");
const dialog = document.querySelector("[data-lifecycle-dialog]");
const accessDialog = document.querySelector("[data-access-dialog]");
const assignmentForm = document.querySelector("[data-assignment-form]");
let platform = null;
let activeFilter = "all";
let activeAccessConnector = null;

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderAccess(access, operator) {
  accessGrid.replaceChildren();
  const identity = element("div", "access-item");
  identity.append(
    element("strong", "", "Signed in"),
    element(
      "span",
      "",
      operator?.userPrincipalName ??
        operator?.displayName ??
        "Unknown operator",
    ),
  );
  const azure = element("div", "access-item");
  azure.append(
    element("strong", "", "Azure RBAC"),
    element(
      "span",
      "",
      access.azureRoles.length
        ? [...new Set(access.azureRoles.map((role) => role.role))].join(", ")
        : "No assignments visible",
    ),
  );
  const entra = element("div", "access-item");
  entra.append(
    element("strong", "", "Entra roles"),
    element(
      "span",
      "",
      access.directoryRoles.length
        ? access.directoryRoles.map((role) => role.displayName).join(", ")
        : "No directory roles visible",
    ),
  );
  accessGrid.append(identity, azure, entra);
  ownerWarning.hidden = !access.hasOwnerRole;
}

function openLifecycle(connector, action) {
  dialog.querySelector("[data-dialog-mode]").textContent =
    `${connector.automation} / ${action}`;
  dialog.querySelector("[data-dialog-title]").textContent = connector.title;
  dialog.querySelector("[data-dialog-summary]").textContent =
    connector.guidance.summary;
  const steps = dialog.querySelector("[data-dialog-steps]");
  steps.replaceChildren(
    ...connector.guidance.manualSteps.map((step) => element("li", "", step)),
  );
  const link = dialog.querySelector("[data-dialog-link]");
  link.href = connector.guidance.url;
  link.textContent =
    connector.automation === "guided"
      ? "Open guided provider step"
      : "Continue authorization";
  dialog.showModal();
}

async function openAccess(connector) {
  activeAccessConnector = connector.id;
  accessDialog.querySelector("[data-access-title]").textContent =
    connector.title;
  const accessMessage = accessDialog.querySelector("[data-access-message]");
  const assignmentList = accessDialog.querySelector("[data-assignment-list]");
  accessMessage.textContent = "Loading assignments...";
  assignmentList.replaceChildren();
  accessDialog.showModal();
  try {
    const response = await fetch(
      `/api/setup/platform/access?connector=${encodeURIComponent(connector.id)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok)
      throw new Error("Enterprise application access is unavailable.");
    const access = await response.json();
    assignmentForm.hidden = !access.provisioned;
    if (!access.provisioned) {
      accessMessage.textContent =
        "The gallery enterprise application is not provisioned. Complete Onboard first.";
      return;
    }
    accessMessage.textContent = access.canManage
      ? "Assign users through app roles and prefer security groups for ongoing membership."
      : "Read-only. Cloud Application Administrator or Application Administrator is required to change assignments.";

    const principalSelect = assignmentForm.elements.principalId;
    const roleSelect = assignmentForm.elements.appRoleId;
    principalSelect.replaceChildren(
      ...access.principals.map((principal) => {
        const option = element(
          "option",
          "",
          `${principal.type}: ${principal.label}`,
        );
        option.value = principal.id;
        return option;
      }),
    );
    roleSelect.replaceChildren(
      ...access.appRoles.map((role) => {
        const option = element("option", "", role.label || "Default access");
        option.value = role.id;
        return option;
      }),
    );
    assignmentForm.querySelector("button").disabled =
      !access.canManage || !access.principals.length || !access.appRoles.length;
    assignmentList.replaceChildren(
      ...access.assignments.map((assignment) => {
        const row = element("div", "assignment-row");
        const label = element(
          "span",
          "",
          `${assignment.principalType}: ${assignment.principalDisplayName}`,
        );
        const remove = element("button", "", "Remove");
        remove.type = "button";
        remove.disabled = !access.canManage;
        remove.addEventListener("click", async () => {
          if (!confirm(`Remove access for ${assignment.principalDisplayName}?`))
            return;
          await mutateAccess("remove", { assignmentId: assignment.id });
          await openAccess(connector);
        });
        row.append(label, remove);
        return row;
      }),
    );
    if (!access.assignments.length) {
      assignmentList.append(
        element("p", "", "No user or group assignments found."),
      );
    }
  } catch (error) {
    accessMessage.textContent = error.message;
    assignmentForm.hidden = true;
  }
}

async function mutateAccess(action, values) {
  const response = await fetch(`/api/setup/platform/access/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectorId: activeAccessConnector, ...values }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Access update failed.");
  message.textContent = payload.message;
}

function connectorCard(connector) {
  const card = element("article", "platform-connector");
  card.dataset.category = connector.category;
  card.dataset.state = connector.state;
  const heading = element("div", "platform-connector-heading");
  const title = element("div");
  title.append(
    element("span", "state-label", connector.state.replaceAll("-", " ")),
    element("h2", "", connector.title),
  );
  heading.append(
    title,
    element("span", "automation-label", connector.automation),
  );

  const details = element("div", "connector-details");
  const permission = element("div");
  permission.append(
    element("strong", "", "Least privilege"),
    element("span", "", `Read: ${connector.permissions.read.join(", ")}`),
    element("span", "", `Manage: ${connector.permissions.manage.join(", ")}`),
  );
  const ownership = element("div");
  ownership.append(
    element("strong", "", "IaC ownership"),
    element("span", "", `Shared: ${connector.iac.shared.join(", ")}`),
    element(
      "span",
      "",
      `Independent: ${connector.iac.repositoryOwned.join(", ")}`,
    ),
  );
  details.append(permission, ownership);

  const resources = element("p", "connector-resources");
  resources.textContent = connector.resources.length
    ? `Found: ${connector.resources.map((resource) => resource.name).join(", ")}`
    : "No matching resource discovered.";
  const access = element(
    "p",
    connector.canManage ? "manage-access" : "read-only-access",
    connector.canManage
      ? "Your current role permits management in this control plane."
      : "Read-only: a listed least-privilege management role is required to change this connector.",
  );

  const actions = element("div", "lifecycle-actions");
  for (const action of connector.lifecycle) {
    const button = element("button", "", action);
    button.type = "button";
    button.addEventListener("click", () => {
      if (action === "scan") return scan();
      if (action === "access") return openAccess(connector);
      return openLifecycle(connector, action);
    });
    actions.append(button);
  }
  card.append(heading, details, resources, access, actions);
  return card;
}

function renderInventory() {
  const visible = platform.inventory.filter(
    (connector) =>
      activeFilter === "all" || connector.category === activeFilter,
  );
  inventoryRoot.replaceChildren(...visible.map(connectorCard));
  for (const state of [
    "managed",
    "pre-existing",
    "needs-action",
    "eligible",
    "unavailable",
  ]) {
    document.querySelector(`[data-count="${state}"]`).textContent =
      platform.inventory.filter(
        (connector) => connector.state === state,
      ).length;
  }
}

async function scan() {
  message.textContent = "Scanning platform connections...";
  try {
    const response = await fetch("/api/setup/platform/overview", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error("Open this page through the local PawPrint Portal.");
    platform = await response.json();
    renderAccess(platform.access, platform.operator);
    renderInventory();
    document
      .querySelectorAll('[data-platform-iac="apply"]')
      .forEach((button) => (button.disabled = !platform.access.canManageAzure));
    message.textContent = `Scanned ${platform.inventory.length} connector paths at ${new Date(platform.scannedAt).toLocaleString()}.`;
  } catch (error) {
    message.textContent = error.message;
  }
}

document
  .querySelector("[data-platform-refresh]")
  .addEventListener("click", scan);
assignmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = assignmentForm.querySelector("button");
  button.disabled = true;
  try {
    await mutateAccess("assign", {
      principalId: assignmentForm.elements.principalId.value,
      appRoleId: assignmentForm.elements.appRoleId.value,
    });
    const connector = platform.inventory.find(
      (candidate) => candidate.id === activeAccessConnector,
    );
    await openAccess(connector);
  } catch (error) {
    accessDialog.querySelector("[data-access-message]").textContent =
      error.message;
  } finally {
    button.disabled = false;
  }
});
document.querySelectorAll("[data-platform-iac]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.platformIac;
    if (
      action === "apply" &&
      !confirm(
        "Apply only the platform connectors declared in infra/platform-connectors/main.dev.bicepparam?",
      )
    ) {
      return;
    }
    button.disabled = true;
    message.textContent = `${action === "preview" ? "Previewing" : "Applying"} declared connector IaC...`;
    try {
      const response = await fetch(`/api/setup/platform/iac/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error ?? "IaC operation failed.");
      message.textContent = payload.message;
      await scan();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
});
document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((candidate) =>
        candidate.classList.toggle("is-active", candidate === button),
      );
    if (platform) renderInventory();
  });
});

scan();
