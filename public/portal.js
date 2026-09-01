const connection = document.querySelector("[data-connection]");
const workloadGrid = document.querySelector("[data-workloads]");
const activity = document.querySelector("[data-activity]");
const authLink = document.querySelector("[data-auth-link]");
const setupStatus = document.querySelector("[data-setup-status]");
const setupRepositories = document.querySelector("[data-setup-repositories]");
const setupMessage = document.querySelector("[data-setup-message]");
const cloudflareStatus = document.querySelector("[data-cloudflare-status]");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setConnection(label, state) {
  connection.className = `connection is-${state}`;
  connection.lastElementChild.textContent = label;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "https://github.com/ninjapaw";
  } catch {
    return "https://github.com/ninjapaw";
  }
}

function render(data) {
  const states = data.workloads.map((item) =>
    item.job?.status === "running"
      ? "in_progress"
      : item.run?.status === "completed"
        ? item.run.conclusion
        : (item.run?.status ?? "unknown"),
  );
  document.querySelector('[data-summary="ready"]').textContent = states.filter(
    (state) => state === "success",
  ).length;
  document.querySelector('[data-summary="running"]').textContent =
    states.filter((state) => ["queued", "in_progress"].includes(state)).length;
  document.querySelector('[data-summary="attention"]').textContent =
    states.filter((state) =>
      ["failure", "cancelled", "unknown"].includes(state),
    ).length;

  workloadGrid.innerHTML = data.workloads
    .map((item) => {
      const state =
        item.job?.status === "running"
          ? "in_progress"
          : item.run?.status === "completed"
            ? item.run.conclusion
            : (item.run?.status ?? "unknown");
      const when = item.run?.createdAt
        ? new Date(item.run.createdAt).toLocaleString()
        : "No run found";
      return `<article class="workload-card" data-state="${escapeHtml(state)}">
      <div class="card-head"><span class="state">${escapeHtml(state.replaceAll("_", " "))}</span><span class="run-time">${escapeHtml(item.environment)}</span></div>
      <h3>${escapeHtml(item.label)}</h3>
      <p>${escapeHtml(item.description)}</p>
      <div class="card-foot">
        <span class="run-time">${escapeHtml(when)}</span>
        <div class="card-actions">
          <a href="${escapeHtml(safeUrl(item.siteUrl))}" target="_blank" rel="noreferrer">Open site</a>
          ${item.run?.url ? `<a href="${escapeHtml(safeUrl(item.run.url))}" target="_blank" rel="noreferrer">View</a>` : ""}
          ${data.localController ? `<button type="button" data-action="${escapeHtml(item.action)}">Deploy</button>` : ""}
          ${data.hostedAdmin && data.githubAppConfigured ? (item.steps ?? []).map((step) => `<button type="button" data-hosted-workload="${escapeHtml(item.id)}" data-hosted-step="${escapeHtml(step)}">${step === "infrastructure" ? "Infrastructure" : "Deploy"}</button>`).join("") : ""}
          ${!data.localController && !(data.hostedAdmin && data.githubAppConfigured) ? `<a href="${escapeHtml(safeUrl(item.actionsUrl))}" target="_blank" rel="noreferrer">Actions</a>` : ""}
        </div>
      </div>
    </article>`;
    })
    .join("");

  if (data.jobs?.length) {
    activity.innerHTML = data.jobs
      .slice()
      .reverse()
      .map(
        (job) => `<li>
      <time>${escapeHtml(new Date(job.startedAt).toLocaleString())}</time>
      <span><strong>${escapeHtml(job.label)}</strong>: ${escapeHtml(job.stage)} (${escapeHtml(job.status)})${job.error ? ` — ${escapeHtml(job.error)}` : ""}</span>
    </li>`,
      )
      .join("");
  }
}

async function hostedOverview() {
  const definition = await fetch("/portal-public.json").then((response) =>
    response.json(),
  );
  const authPayload = await fetch("/.auth/me", {
    headers: { Accept: "application/json" },
  }).then((response) =>
    response.ok ? response.json() : { clientPrincipal: null },
  );
  const principal = authPayload.clientPrincipal;
  const hostedAdmin =
    principal?.userRoles?.some((role) => role.toLowerCase() === "admin") ??
    false;
  let githubAppConfigured = false;
  if (hostedAdmin) {
    const status = await fetch("/api/admin/status", {
      headers: { Accept: "application/json" },
    });
    if (status.ok) {
      githubAppConfigured = Boolean((await status.json()).githubAppConfigured);
    }
  }
  const workloads = await Promise.all(
    definition.workloads.map(async (workload) => {
      const endpoint = `https://api.github.com/repos/${workload.repository}/actions/workflows/${workload.statusWorkflow}/runs?branch=dev&per_page=1`;
      const response = await fetch(endpoint, {
        headers: { Accept: "application/vnd.github+json" },
      });
      const payload = response.ok
        ? await response.json()
        : { workflow_runs: [] };
      const run = payload.workflow_runs[0];
      return {
        ...workload,
        environment: "dev",
        actionsUrl: `https://github.com/${workload.repository}/actions/workflows/${workload.statusWorkflow}`,
        run: run
          ? {
              status: run.status,
              conclusion: run.conclusion,
              createdAt: run.created_at,
              url: run.html_url,
            }
          : null,
      };
    }),
  );
  return {
    canDeploy: hostedAdmin && githubAppConfigured,
    hostedAdmin,
    githubAppConfigured,
    principal,
    workloads,
    jobs: [],
  };
}

async function refresh() {
  try {
    setConnection("Refreshing", "online");
    const response = await fetch("/api/overview", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Controller returned ${response.status}`);
    const data = await response.json();
    data.localController = true;
    render(data);
    setConnection(`${data.identity.github} / ${data.identity.azure}`, "online");
    await refreshSetup();
  } catch (error) {
    try {
      const hosted = await hostedOverview();
      render(hosted);
      if (hosted.principal) {
        authLink.textContent = "Sign out";
        authLink.href = "/.auth/logout?post_logout_redirect_uri=/";
      }
      const mode = hosted.canDeploy
        ? "Hosted admin ready"
        : hosted.hostedAdmin
          ? "GitHub App setup required"
          : hosted.principal
            ? "Admin role required"
            : "Hosted read-only mode";
      setConnection(mode, hosted.canDeploy ? "online" : "offline");
      document
        .querySelectorAll("[data-local-only]")
        .forEach((element) => (element.disabled = true));
      document.querySelector("[data-mode-copy]").textContent = hosted.canDeploy
        ? "Hosted actions dispatch fixed development workflows through the dedicated PawPrint GitHub App."
        : "Sign in with GitHub and use an assigned admin role, or open PawPrint Portal.cmd for local deployment actions.";
      document.querySelector("[data-local-setup]").hidden = true;
    } catch {
      setConnection("Deployment status unavailable", "offline");
      workloadGrid.innerHTML = `<p class="loading">Deployment status could not be loaded. Open GitHub Actions directly or start PawPrint Portal locally.</p>`;
    }
  }
}

function setupValue(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

async function refreshSetup() {
  const response = await fetch("/api/setup/overview", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Setup status is unavailable.");
  const setup = await response.json();
  document.querySelector("[data-local-setup]").hidden = false;
  setupStatus.innerHTML = [
    setupValue(
      "GitHub organization",
      `${setup.organization} / ${setup.github.organizationRole}`,
    ),
    setupValue("Azure subscription", setup.azure.subscription),
    setupValue("GitHub App", setup.app.slug ?? "not created"),
    setupValue("Hosted dispatch", setup.app.enabled ? "enabled" : "disabled"),
  ].join("");
  setupRepositories.innerHTML = setup.requiredRepositories
    .map(
      (repository) =>
        `<li>${escapeHtml(setup.organization)}/${escapeHtml(repository)}</li>`,
    )
    .join("");
  cloudflareStatus.innerHTML = [
    setupValue("Zone", setup.cloudflare.zoneName),
    setupValue(
      "Development",
      setup.cloudflare.environments.dev ? "stored" : "not connected",
    ),
    setupValue(
      "Production",
      setup.cloudflare.environments.prod ? "stored" : "not connected",
    ),
    setupValue(
      "Token expiry",
      setup.cloudflare.tokenExpiresOn === "no-expiry"
        ? "no expiry"
        : setup.cloudflare.tokenExpiresOn,
    ),
  ].join("");
  document.querySelector("[data-cloudflare-deploy]").disabled =
    !setup.cloudflare.environments.dev || !setup.cloudflare.workflowReady;
  const createButton = document.querySelector('[data-setup-action="create"]');
  createButton.disabled = !setup.github.canCreateApp;
  setupMessage.textContent = setup.github.canCreateApp
    ? setup.app.enabled
      ? "The dedicated App is enabled. Audit it after any installation change."
      : "Ready to create or resume the dedicated App setup."
    : "Organization owner or GitHub App manager access is required to create the App.";
}

async function setupPost(path) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ?? `Setup request failed with ${response.status}.`,
    );
  return result;
}

async function runSetupAction(action, button) {
  button.disabled = true;
  setupMessage.textContent = `${action[0].toUpperCase()}${action.slice(1)} in progress...`;
  try {
    if (action === "create") {
      const setup = await setupPost("/api/setup/github-app/start");
      const form = document.createElement("form");
      form.method = "post";
      form.action = setup.action;
      const manifest = document.createElement("input");
      manifest.type = "hidden";
      manifest.name = "manifest";
      manifest.value = JSON.stringify(setup.manifest);
      form.append(manifest);
      document.body.append(form);
      form.submit();
      return;
    }
    if (action === "audit") {
      const result = await setupPost("/api/setup/github-app/audit");
      const installation = result.installation;
      setupMessage.textContent = installation?.valid
        ? `Valid: ${installation.repositories.length} repositories and expected permissions.`
        : "Installation is absent or does not match the required repositories and permissions.";
    } else if (action === "enable") {
      const result = await setupPost("/api/setup/github-app/enable");
      setupMessage.textContent = result.message;
      await refreshSetup();
    } else if (action === "disable") {
      const result = await setupPost("/api/setup/github-app/disable");
      setupMessage.textContent = result.message;
      await refreshSetup();
    }
  } catch (error) {
    setupMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function runAction(action, button) {
  if (
    !confirm(
      action === "deploy-all"
        ? "Deploy every development workload?"
        : "Deploy this development workload?",
    )
  )
    return;
  button.disabled = true;
  try {
    const response = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? `Request failed with ${response.status}`);
    const entry = document.createElement("li");
    entry.innerHTML = `<time>${new Date().toLocaleString()}</time><span>${escapeHtml(result.message)}</span>`;
    activity.prepend(entry);
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function runHostedAction(workload, step, button) {
  if (!confirm(`Deploy ${workload} ${step} to development?`)) return;
  button.disabled = true;
  try {
    const response = await fetch("/api/actions/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workload, step }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error ?? `Request failed with ${response.status}`);
    }
    const entry = document.createElement("li");
    entry.innerHTML = `<time>${new Date().toLocaleString()}</time><span>${escapeHtml(result.message)}</span>`;
    activity.prepend(entry);
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) runAction(actionButton.dataset.action, actionButton);
  const hostedButton = event.target.closest("[data-hosted-workload]");
  if (hostedButton) {
    runHostedAction(
      hostedButton.dataset.hostedWorkload,
      hostedButton.dataset.hostedStep,
      hostedButton,
    );
  }
  const setupButton = event.target.closest("[data-setup-action]");
  if (setupButton) runSetupAction(setupButton.dataset.setupAction, setupButton);
  if (event.target.closest("[data-refresh]")) refresh();
});

refresh();
setInterval(refresh, 30000);
