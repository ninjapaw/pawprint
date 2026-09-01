const form = document.querySelector("[data-first-run-form]");
const steps = [...document.querySelectorAll("[data-step]")];
const progress = document.querySelector("[data-wizard-progress]");
const back = document.querySelector("[data-wizard-back]");
const next = document.querySelector("[data-wizard-next]");
const message = document.querySelector("[data-wizard-message]");
let currentStep = 0;
let setup = null;
const subscriptionOverrides = {};
const locationOverrides = {};

const environmentLabels = {
  dev: "Development",
  prod: "Production",
  qa: "QA",
  test: "Testing",
};

function selectedEnvironments() {
  return [...form.querySelectorAll('input[name="environment"]:checked')].map(
    (input) => input.value,
  );
}

function option(value, label) {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function subscriptionOptions(selected) {
  return setup.subscriptions.map((subscription) => {
    const item = option(subscription.id, subscription.name);
    item.selected = subscription.id === selected;
    return item;
  });
}

function locationOptions(selected) {
  return setup.locations
    .slice()
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map((location) => {
      const item = option(
        location.name,
        `${location.displayName} (${location.name})`,
      );
      item.selected = location.name === selected;
      return item;
    });
}

function renderProgress() {
  const labels = [
    "Scope",
    "Subscriptions",
    "Regions",
    "Names",
    "Governance",
    "Review",
  ];
  progress.replaceChildren(
    ...labels.map((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${index + 1}. ${label}`;
      button.className =
        index === currentStep
          ? "is-active"
          : index < currentStep
            ? "is-complete"
            : "";
      button.disabled = index > currentStep;
      button.addEventListener("click", () => showStep(index));
      return button;
    }),
  );
}

function showStep(index) {
  currentStep = index;
  steps.forEach((step, position) => (step.hidden = position !== index));
  back.disabled = index === 0;
  next.hidden = index === steps.length - 1;
  if (index === 1) renderOverrides();
  if (index === 2) renderLocationOverrides();
  if (index === 3) generateNames();
  if (index === 5) renderReview();
  renderProgress();
}

async function renderCost() {
  const panel = document.querySelector("[data-cost-panel]");
  const subscriptionId = form.elements.managementSubscriptionId.value;
  const subscription = setup.subscriptions.find(
    (item) => item.id === subscriptionId,
  );
  panel.querySelector("strong").textContent =
    `Loading ${subscription?.name ?? "subscription"}`;
  panel.querySelector("span").textContent =
    "Querying month-to-date actual cost and budget.";
  const response = await fetch(
    `/api/setup/first-run/cost?subscription=${encodeURIComponent(subscriptionId)}`,
  );
  const cost = await response.json();
  if (cost.monthToDate === null) {
    panel.querySelector("strong").textContent = "Cost unavailable";
    panel.querySelector("span").textContent =
      `${cost.unavailableReason ?? "Cost Management Reader may be required."} Deployment can continue.`;
    return;
  }
  const money = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: cost.currency ?? "USD",
  });
  panel.querySelector("strong").textContent =
    `${money.format(cost.monthToDate)} spent this month`;
  panel.querySelector("span").textContent =
    cost.budget === null
      ? "No monthly subscription budget was found. Add one before broad deployment."
      : `${money.format(cost.remaining)} remaining of ${money.format(cost.budget)} monthly budget.`;
}

function renderOverrides() {
  const root = document.querySelector("[data-environment-overrides]");
  const management = form.elements.managementSubscriptionId.value;
  root.replaceChildren(
    ...selectedEnvironments().map((environment) => {
      const row = document.createElement("label");
      row.dataset.environmentSubscription = environment;
      const title = document.createElement("span");
      title.textContent = `${environmentLabels[environment]} subscription`;
      const select = document.createElement("select");
      select.append(
        ...subscriptionOptions(
          subscriptionOverrides[environment] ?? management,
        ),
      );
      select.addEventListener(
        "change",
        () => (subscriptionOverrides[environment] = select.value),
      );
      row.append(title, select);
      return row;
    }),
  );
}

function renderLocationOverrides() {
  const root = document.querySelector("[data-location-overrides]");
  const defaultLocation = form.elements.defaultLocation.value;
  root.replaceChildren(
    ...selectedEnvironments().map((environment) => {
      const row = document.createElement("label");
      row.dataset.environmentLocation = environment;
      const title = document.createElement("span");
      title.textContent = `${environmentLabels[environment]} region`;
      const select = document.createElement("select");
      select.append(
        ...locationOptions(locationOverrides[environment] ?? defaultLocation),
      );
      select.addEventListener(
        "change",
        () => (locationOverrides[environment] = select.value),
      );
      row.append(title, select);
      return row;
    }),
  );
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20) || "platform"
  );
}

function stableSuffix(value) {
  let hash = 2166136261;
  for (const character of value)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36).slice(0, 5);
}

function generatedNames() {
  const prefix = slug(form.elements.organizationPrefix.value).slice(0, 6);
  const workload = slug(form.elements.platformName.value);
  const location = form.elements.defaultLocation.value || "centralus";
  const environment = selectedEnvironments()[0] ?? "dev";
  const base = `${prefix}-${workload}-${environment}-${location}`;
  const unique = stableSuffix(`${base}:${form.elements.namingPrompt.value}`);
  return {
    "Resource group": `rg-${base}`.slice(0, 90),
    "Static Web App": `stapp-${base}`.slice(0, 40),
    "Function App": `func-${base}`.slice(0, 60),
    "Key Vault": `kv-${prefix}-${workload}-${environment}`.slice(0, 24),
    "Log Analytics": `log-${base}`.slice(0, 63),
    "Application Insights": `appi-${base}`.slice(0, 260),
    "Storage account": `${prefix}${workload}${environment}${unique}`
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 24),
  };
}

function generateNames() {
  const root = document.querySelector("[data-name-preview]");
  root.replaceChildren(
    ...Object.entries(generatedNames()).map(([type, name]) => {
      const row = document.createElement("div");
      const label = document.createElement("strong");
      const value = document.createElement("code");
      label.textContent = type;
      value.textContent = name;
      row.append(label, value);
      return row;
    }),
  );
}

function buildPlan() {
  const environments = selectedEnvironments();
  const environmentOverrides = {};
  for (const environment of environments) {
    environmentOverrides[environment] = {
      subscriptionId:
        document.querySelector(
          `[data-environment-subscription="${environment}"] select`,
        )?.value ||
        subscriptionOverrides[environment] ||
        form.elements.managementSubscriptionId.value,
      location:
        document.querySelector(
          `[data-environment-location="${environment}"] select`,
        )?.value ||
        locationOverrides[environment] ||
        form.elements.defaultLocation.value,
    };
  }
  return {
    environments,
    managementSubscriptionId: form.elements.managementSubscriptionId.value,
    defaultLocation: form.elements.defaultLocation.value,
    environmentOverrides,
    organizationName: form.elements.organizationName.value,
    organizationPrefix: form.elements.organizationPrefix.value,
    platformName: form.elements.platformName.value,
    namingPrompt: form.elements.namingPrompt.value,
    allowRecreate: form.elements.allowRecreate.checked,
    connectors: [
      ...form.querySelectorAll('input[name="connector"]:checked'),
    ].map((input) => input.value),
    tags: {
      owner: form.elements.tagOwner.value,
      costCenter: form.elements.tagCostCenter.value,
      dataClassification: form.elements.tagClassification.value,
    },
    generatedNames: generatedNames(),
  };
}

function renderReview() {
  const plan = buildPlan();
  const subscriptionName = (id) =>
    setup.subscriptions.find((item) => item.id === id)?.name ?? id;
  const root = document.querySelector("[data-plan-review]");
  const rows = [
    [
      "Environments",
      plan.environments.map((item) => environmentLabels[item]).join(", "),
    ],
    [
      "Management subscription",
      subscriptionName(plan.managementSubscriptionId),
    ],
    ["Default region", plan.defaultLocation],
    ["Naming convention", `${plan.organizationPrefix} / ${plan.platformName}`],
    ["Connectors", plan.connectors.join(", ") || "None"],
    [
      "Delete and re-create",
      plan.allowRecreate
        ? "Allowed with per-operation confirmation"
        : "Not allowed",
    ],
  ];
  root.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("strong");
      const detail = document.createElement("span");
      term.textContent = label;
      detail.textContent = value;
      row.append(term, detail);
      return row;
    }),
  );
}

function validateStep() {
  if (currentStep === 0 && !selectedEnvironments().length)
    return "Select at least one environment.";
  const controls = [
    ...steps[currentStep].querySelectorAll("input, select, textarea"),
  ];
  const invalid = controls.find((control) => !control.checkValidity());
  if (invalid) {
    invalid.reportValidity();
    return "Complete the required fields.";
  }
  return null;
}

back.addEventListener("click", () => showStep(Math.max(0, currentStep - 1)));
next.addEventListener("click", () => {
  const problem = validateStep();
  if (problem) {
    message.textContent = problem;
    return;
  }
  showStep(Math.min(steps.length - 1, currentStep + 1));
});
document
  .querySelector("[data-generate-names]")
  .addEventListener("click", generateNames);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "Saving local setup plan...";
  const response = await fetch("/api/setup/first-run/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPlan()),
  });
  const payload = await response.json();
  message.textContent = response.ok
    ? `Saved locally at ${new Date(payload.plan.savedAt).toLocaleString()}. Continue to Platform connections to preview IaC.`
    : (payload.error ?? "The setup plan could not be saved.");
});

async function initialize() {
  const response = await fetch("/api/setup/first-run/overview", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error("Open this wizard through the local PawPrint Portal.");
  setup = await response.json();
  const defaultSubscription =
    setup.subscriptions.find((item) => item.isDefault) ??
    setup.subscriptions[0];
  form.elements.managementSubscriptionId.append(
    ...subscriptionOptions(defaultSubscription?.id),
  );
  form.elements.defaultLocation.append(...locationOptions("centralus"));
  if (setup.savedPlan) {
    form
      .querySelectorAll('input[name="environment"]')
      .forEach(
        (input) =>
          (input.checked = setup.savedPlan.environments.includes(input.value)),
      );
    form.elements.managementSubscriptionId.value =
      setup.savedPlan.managementSubscriptionId;
    form.elements.defaultLocation.value = setup.savedPlan.defaultLocation;
    form.elements.organizationName.value = setup.savedPlan.organizationName;
    form.elements.organizationPrefix.value = setup.savedPlan.organizationPrefix;
    form.elements.platformName.value = setup.savedPlan.platformName;
    form.elements.namingPrompt.value = setup.savedPlan.namingPrompt;
    form.elements.allowRecreate.checked = setup.savedPlan.allowRecreate;
    form
      .querySelectorAll('input[name="connector"]')
      .forEach(
        (input) =>
          (input.checked = setup.savedPlan.connectors.includes(input.value)),
      );
    form.elements.tagOwner.value = setup.savedPlan.tags?.owner ?? "";
    form.elements.tagCostCenter.value = setup.savedPlan.tags?.costCenter ?? "";
    form.elements.tagClassification.value =
      setup.savedPlan.tags?.dataClassification ?? "";
    for (const [environment, values] of Object.entries(
      setup.savedPlan.environmentOverrides ?? {},
    )) {
      subscriptionOverrides[environment] = values.subscriptionId;
      locationOverrides[environment] = values.location;
    }
  }
  form.elements.managementSubscriptionId.addEventListener("change", () => {
    renderCost();
    renderOverrides();
  });
  form.elements.defaultLocation.addEventListener(
    "change",
    renderLocationOverrides,
  );
  await renderCost();
  showStep(0);
}

initialize().catch((error) => {
  message.textContent = error.message;
  next.disabled = true;
});
