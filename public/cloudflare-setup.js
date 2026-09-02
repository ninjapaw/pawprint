const form = document.querySelector("[data-cloudflare-form]");
const statusList = document.querySelector("[data-cloudflare-status]");
const message = document.querySelector("[data-cloudflare-message]");
const deployButton = document.querySelector("[data-cloudflare-deploy]");
const result = document.querySelector("[data-connector-result]");
const openCloudflareButton = document.querySelector("[data-open-cloudflare]");

function statusRow(label, value) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  return row;
}

async function refreshStatus() {
  const response = await fetch("/api/setup/overview", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Open this page through the local PawPrint Portal.");
  }
  const setup = await response.json();
  statusList.replaceChildren(
    statusRow(
      "Development",
      setup.cloudflare.environments.dev ? "Connected" : "Not connected",
    ),
    statusRow(
      "Production",
      setup.cloudflare.environments.prod ? "Connected" : "Not connected",
    ),
    statusRow(
      "Token expiry",
      setup.cloudflare.tokenExpiresOn === "no-expiry"
        ? "No expiry"
        : setup.cloudflare.tokenExpiresOn,
    ),
    statusRow(
      "Deployment workflow",
      setup.cloudflare.workflowReady ? "Ready" : "Push required",
    ),
  );
  deployButton.disabled =
    !setup.cloudflare.environments.dev || !setup.cloudflare.workflowReady;
  if (!setup.cloudflare.workflowReady) {
    message.textContent =
      "Review and push the Site workflow changes to dev before deployment.";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = form.elements.token;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  message.textContent = "Creating and verifying the restricted DNS token...";
  try {
    const response = await fetch("/api/setup/cloudflare/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Connection failed.");
    message.textContent = payload.message;
    await refreshStatus();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    token.value = "";
    button.disabled = false;
  }
});

openCloudflareButton.addEventListener("click", async () => {
  openCloudflareButton.disabled = true;
  message.textContent =
    "Opening Cloudflare account token setup in Microsoft Edge...";
  try {
    const response = await fetch("/api/setup/cloudflare/open-account-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(payload.error ?? "Could not open Cloudflare.");
    message.textContent = payload.message;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    openCloudflareButton.disabled = false;
  }
});

deployButton.addEventListener("click", async () => {
  if (
    !confirm(
      "Deploy Site infrastructure, bind Cloudflare DNS, and publish the development application?",
    )
  )
    return;
  deployButton.disabled = true;
  message.textContent = "Starting the Site deployment...";
  try {
    const response = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "site" }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(payload.error ?? "Deployment could not start.");
    result.hidden = false;
    result.querySelector("span").textContent = payload.message;
    message.textContent =
      "Deployment started. Return to the dashboard for progress.";
  } catch (error) {
    message.textContent = error.message;
    deployButton.disabled = false;
  }
});

refreshStatus().catch((error) => {
  message.textContent = error.message;
  form.querySelector("button").disabled = true;
});
