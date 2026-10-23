const grid = document.querySelector("[data-shared-services]");
const notice = document.querySelector("[data-shared-notice]");
const environmentSelect = document.querySelector("[data-shared-environment]");
const filterSelect = document.querySelector("[data-shared-filter]");
const activityList = document.querySelector("[data-shared-activity]");
const dialog = document.querySelector("[data-operation-dialog]");
const form = document.querySelector("[data-operation-form]");
const requests = new Map();
let catalog = [];
let current = null;
let pendingPreview = null;
let refreshing = false;
let lastAttempt = 0;
const html = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const timestamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not observed";
const stale = (value) => value && Date.now() - Date.parse(value) > 5 * 60000;
const source = (state, name, message) => ({ state, source: name, message, observedAt: null });

function observation(label, value) {
  if (!value) return "";
  return `<div class="observation"><dt>${html(label)}</dt><dd>
    <strong>${html(value.state)}${stale(value.observedAt) ? " · stale" : ""}</strong>
    <span>${html(value.message)}</span><small>${html(value.source)} · ${html(timestamp(value.observedAt))}</small>
  </dd></div>`;
}

function fallback(service) {
  return {
    ...service,
    desired: source("not-configured", "Static catalog · not telemetry", "Runtime desired state is not available."),
    provisioning: [source("not-configured", "Azure ARM", "No authenticated resource binding has been observed.")],
    availability: [source("unknown", "Azure Resource Health", "No authenticated availability observation.")],
    health: source("unknown", service.kind === "easm" ? "EASM coverage" : "Application probe", "Health and coverage are not inferred."),
    dns: [], workflow: null, budget: null,
  };
}

function render() {
  const filter = filterSelect.value;
  const services = current?.services ?? catalog.map(fallback);
  grid.innerHTML = services.filter((service) =>
    filter === "all" || (filter === "workload" ? service.kind === "workload" : service.kind !== "workload"),
  ).map((service) => {
    const run = service.workflow?.runs?.[0];
    const provisioning = service.provisioning ?? [];
    const actionControls = service.id === "shared-easm" ? `<div class="shared-actions">
      <p>${html(current?.actionReadiness?.message ?? "Hosted requests are disabled until workforce authentication, backend isolation, GitHub access and durable storage are configured.")}</p>
      ${(current?.actions ?? []).map((action) => `<button type="button" data-shared-action="${html(action.id)}"
        ${action.permitted && current.actionReadiness?.configured ? "" : "disabled"}
        title="${html(action.permitted ? current.actionReadiness.message : `${action.role} role required`)}">${html(action.label)}</button>`).join("")}
    </div>` : "";
    return `<article class="service-card">
      <div class="card-head"><span class="state">${html(service.kind)}</span><span class="run-time">${html(environmentSelect.value)}</span></div>
      <h3>${html(service.label)}</h3><p>${html(service.description)}</p>
      <dl class="signal-summary">
        <div><dt>Desired</dt><dd>${html(service.desired.state)}</dd></div>
        <div><dt>Provisioning</dt><dd>${html(provisioning.length === 1 ? provisioning[0].state : `${provisioning.length} bound resources`)}</dd></div>
        <div><dt>Application / coverage</dt><dd>${html(service.health.state)}${stale(service.health.observedAt) ? " · stale" : ""}</dd></div>
        <div><dt>Workflow result</dt><dd>${html(run ? `${run.status} / ${run.conclusion ?? "pending"}` : service.workflow?.state ?? "unknown")}<small>Not live health</small></dd></div>
      </dl>
      <details><summary>Sources, details &amp; reviewed actions</summary>
        <dl class="observation-list">${observation("Desired configuration", service.desired)}
          ${provisioning.map((item, index) => observation(`Provisioning ${index + 1}`, item)).join("")}
          ${(service.availability ?? []).map((item, index) => observation(`Azure availability ${index + 1}`, item)).join("")}
          ${observation("Application health / EASM coverage", service.health)}
          ${(service.dns ?? []).map((item) => observation("DNS observed", item)).join("")}
          ${observation("Workflow source", service.workflow)}
          ${observation("EASM budget readiness", service.budget)}
        </dl>${actionControls}
        ${service.workflowUrl ? `<a class="service-guide" href="${html(service.workflowUrl)}" target="_blank" rel="noreferrer">Open protected workflow ↗</a> · ` : ""}
        <a class="service-guide" href="${service.guideUrl.endsWith("/docs/portal-operations.md") ? "/operations/" : html(service.guideUrl)}" target="_blank" rel="noreferrer">Operator guide ↗</a>
      </details>
    </article>`;
  }).join("");
  grid.setAttribute("aria-busy", "false");
  renderActivity();
}

function renderActivity() {
  const entries = (current?.services ?? []).flatMap((service) => (service.workflow?.runs ?? []).slice(0, service.id === "shared-easm" ? 8 : 1)
    .map((run) => ({ when: run.createdAt, content: `<strong>${html(service.label)}</strong> · ${html(run.status)} / ${html(run.conclusion ?? "pending")} — <a href="${html(run.url)}" target="_blank" rel="noreferrer">Workflow result, not live health ↗</a>` })));
  entries.push(...[...requests.values()].map((request) => ({
    when: request.createdAt,
    content: `<strong>${html(request.actionId)} · ${html(request.state)}</strong> · <code>${html(request.requestId)}</code><br />
      ${html(request.message)} <button type="button" data-request-status="${html(request.requestId)}">Check correlation</button>`,
  })));
  entries.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
  activityList.innerHTML = entries.length ? entries.slice(0, 30).map((entry) =>
    `<li><time>${html(timestamp(entry.when))}</time><span>${entry.content}</span></li>`,
  ).join("") : "<li>No authenticated workflow observations. Missing runs are not proof of a healthy or unhealthy application.</li>";
}

async function jsonRequest(path, options = {}) {
  const result = await fetch(path, {
    ...options, signal: AbortSignal.timeout(12000),
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    credentials: "same-origin",
  });
  if (!result.headers.get("content-type")?.includes("application/json")) throw new Error("An authenticated JSON API response is required. Check sign-in and linked-backend setup.");
  const payload = await result.json();
  if (!result.ok) {
    const error = new Error(payload.error ?? payload.message ?? `API unavailable (${result.status}).`);
    error.response = payload;
    throw error;
  }
  return payload;
}

async function refresh(force = false) {
  if (refreshing || document.hidden || (!force && Date.now() - lastAttempt < 60000)) return;
  refreshing = true;
  lastAttempt = Date.now();
  const environment = environmentSelect.value;
  notice.textContent = "Checking authenticated sources. Viewing never requests a workflow.";
  try {
    if (!catalog.length) {
      const definition = await jsonRequest("/portal-public.json");
      catalog = definition.services;
    }
    const data = await jsonRequest(`/api/shared/status?environment=${environment}`);
    if (environmentSelect.value !== environment) return;
    current = data;
    notice.textContent = `${data.role} · ${data.trust.state} backend boundary · observed ${timestamp(data.observedAt)}. Sources cached up to 60 seconds; observations older than five minutes are marked stale.`;
  } catch (error) {
    if (current) current = { ...current, actions: [], actionReadiness: { configured: false, message: "Current authorization/source readiness is unavailable. Hosted shared requests are disabled." } };
    notice.textContent = `Setup / access needed: ${error.message} No live-success fallback is used.${current ? " Previously returned observations retain their timestamps." : ""}`;
  } finally {
    if (environmentSelect.value === environment) render();
    refreshing = false;
    if (environmentSelect.value !== environment) void refresh(true);
  }
}

async function preview(actionId, button) {
  button.disabled = true;
  try {
    pendingPreview = await jsonRequest("/api/shared/preview", {
      method: "POST", body: JSON.stringify({ actionId, environment: environmentSelect.value }),
    });
    form.reset();
    form.querySelector('[type="submit"]').disabled = false;
    document.querySelector("[data-operation-description]").textContent =
      `${pendingPreview.action.label} · ${pendingPreview.environment} · ${pendingPreview.repository} / ${pendingPreview.workflow} @ ${pendingPreview.ref}`;
    document.querySelector("[data-operation-notice]").textContent = pendingPreview.notice;
    document.querySelector("[data-operation-id]").textContent = pendingPreview.requestId;
    document.querySelector("[data-operation-message]").textContent = "A durable preview has been recorded. No workflow has been requested.";
    document.querySelector("[data-write-confirmation]").hidden = !pendingPreview.action.write;
    document.querySelector("[data-discovery-confirmation]").hidden = !pendingPreview.action.discovery;
    form.elements.write.required = pendingPreview.action.write;
    form.elements.discovery.required = pendingPreview.action.discovery;
    dialog.showModal();
  } catch (error) {
    notice.textContent = `Preview unavailable: ${error.message} Use the protected workflow link.`;
  } finally { button.disabled = false; }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingPreview) return;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  const request = pendingPreview;
  pendingPreview = null;
  try {
    const result = await jsonRequest("/api/shared/requests", {
      method: "POST",
      body: JSON.stringify({
        requestId: request.requestId, confirmProtectedConfiguration: form.elements.protected.checked,
        approveWrite: form.elements.write.checked, approveDiscovery: form.elements.discovery.checked,
      }),
    });
    requests.set(result.requestId, result);
    document.querySelector("[data-operation-message]").textContent = result.message;
  } catch (error) {
    if (error.response?.requestId === request.requestId && error.response.state === "rejected") {
      requests.set(request.requestId, error.response);
      document.querySelector("[data-operation-message]").textContent = error.response.message;
      renderActivity();
      return;
    }
    const message = `Outcome not established: ${error.message} Check this same request ID before making any new request. No automatic redispatch.`;
    requests.set(request.requestId, { ...request, state: "uncertain", message });
    document.querySelector("[data-operation-message]").textContent = message;
  }
  if (requests.size > 20) requests.delete(requests.keys().next().value);
  renderActivity();
});
document.querySelector("[data-operation-cancel]").addEventListener("click", () => { pendingPreview = null; dialog.close(); });
dialog.addEventListener("cancel", () => { pendingPreview = null; });
document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;
  const action = event.target.closest("[data-shared-action]");
  if (action) void preview(action.dataset.sharedAction, action);
  const status = event.target.closest("[data-request-status]");
  if (status) {
    status.disabled = true;
    try {
      const result = await jsonRequest(`/api/shared/requests/${status.dataset.requestStatus}`);
      const run = result.workflow.runs[0];
      requests.set(result.requestId, {
        ...result, message: run ? `Correlated workflow: ${run.status} / ${run.conclusion ?? "pending"}. Not application health.` : result.message,
      });
      renderActivity();
    } catch (error) {
      notice.textContent = `Correlation unavailable: ${error.message} Do not blindly retry the operation.`;
      status.disabled = false;
    }
  }
});
environmentSelect.addEventListener("change", () => {
  current = null;
  render();
  void refresh(true);
});
filterSelect.addEventListener("change", render);
document.querySelector("[data-shared-refresh]").addEventListener("click", () => void refresh(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); else render(); }, 60000);
void refresh();
