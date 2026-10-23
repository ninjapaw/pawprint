import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const catalog = JSON.parse(readFileSync(new URL("../../public/portal-public.json", import.meta.url), "utf8")).services;
const requestId = "10000000-0000-4000-8000-000000000001";
const observation = (state, source = "Synthetic test source", message = "Fixture only, not live telemetry") => ({
  state, source, message, observedAt: "2020-01-01T00:00:00Z",
});
function fixture(role = "reader", environment = "dev") {
  return {
    role, environment, observedAt: new Date().toISOString(), trust: { state: "verified" },
    actionReadiness: { configured: role !== "reader", message: "Synthetic readiness fixture; not a live approval." },
    actions: [
      { id: "verify", label: "Verify EASM", permitted: role !== "reader", role: "operator", write: false, discovery: false },
      { id: "run-discovery", label: "Request discovery run", permitted: role === "admin", role: "admin", write: true, discovery: true },
    ],
    services: catalog.map((service) => ({
      ...service, desired: observation(service.id === "shared-easm" ? "enabled" : "not-configured"),
      provisioning: [observation(service.id === "shared-easm" ? "Succeeded" : "not-configured")],
      availability: [observation("unknown")], health: observation("unknown"), dns: [], budget: null,
      workflow: service.id === "shared-easm" ? {
        ...observation("observed"),
        runs: [{ id: 1, title: "Synthetic completed workflow", status: "completed", conclusion: "success", createdAt: "2020-01-01T00:00:00Z", url: "https://github.com/ninjapaw/pawprint/actions/runs/1" }],
      } : null,
    })),
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/overview", (route) => route.fulfill({ status: 404, json: { error: "Synthetic hosted mode" } }));
  await page.route("**/.auth/me", (route) => route.fulfill({ json: { clientPrincipal: { identityProvider: "aad", userRoles: ["authenticated", "reader"] } } }));
  await page.route("**/api/admin/status", (route) => route.fulfill({ json: { githubAppConfigured: false } }));
  await page.route("**/api/shared/status?environment=*", (route) => route.fulfill({
    json: fixture("reader", new URL(route.request().url()).searchParams.get("environment")),
  }));
});

test("separates desired/provisioning/workflow results from unknown health with stale details", async ({ page }) => {
  const outbound = [];
  const posts = [];
  page.on("request", (request) => {
    if (request.url().includes("api.github.com")) outbound.push(request.url());
    if (request.method() === "POST") posts.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator(".service-card")).toHaveCount(5);
  const easm = page.locator(".service-card").filter({ has: page.getByRole("heading", { name: "External attack surface", exact: true }) });
  await expect(easm).toContainText("Succeeded");
  await expect(easm).toContainText("completed / success");
  await expect(easm).toContainText("unknown · stale");
  await easm.locator("summary").click();
  await expect(easm).toContainText("Synthetic test source");
  await expect(easm.getByRole("button", { name: "Verify EASM" })).toBeDisabled();
  await expect(easm.getByRole("link", { name: "Open protected workflow" })).toHaveAttribute("href", "https://github.com/ninjapaw/pawprint/actions/workflows/shared-easm.yml");
  expect(outbound).toEqual([]);
  expect(posts).toEqual([]);
});

test("filters organization workloads and changes fixed environments without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-shared-filter]").selectOption("workload");
  await expect(page.locator(".service-card")).toHaveCount(7);
  await expect(page.getByRole("heading", { name: "Code-to-Cloud security dojo", exact: true })).toBeVisible();
  await page.locator("[data-shared-environment]").selectOption("prod");
  await expect(page.locator("[data-shared-notice]")).toContainText("reader");
  await page.locator("[data-shared-filter]").selectOption("all");
  await expect(page.locator(".service-card")).toHaveCount(12);
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});

test("shows setup-needed instead of a live-success fallback when trusted API is unavailable", async ({ page }) => {
  await page.route("**/api/shared/status?environment=*", (route) => route.fulfill({
    status: 503, json: { state: "setup-required", error: "Backend isolation is not verified." },
  }));
  await page.goto("/");
  await expect(page.locator("[data-shared-notice]")).toContainText("Backend isolation is not verified");
  await expect(page.locator(".service-card")).toHaveCount(5);
  await expect(page.locator(".signal-summary").first()).toContainText("not-configured");
  await expect(page.locator(".signal-summary").first()).toContainText("unknown");
  await expect(page.locator("[data-shared-action]")).toHaveCount(0);
});

test("serves the operator guide locally without an external documentation framework", async ({ page }) => {
  await page.goto("/operations/");
  await expect(page.getByRole("heading", { name: "PawPrint shared-services console", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stage Entra workforce authentication intentionally", exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});

test("requires reviewed confirmation and reports accepted, not started or completed", async ({ page }) => {
  let confirmations = 0;
  const posts = [];
  await page.route("**/api/shared/status?environment=*", (route) => route.fulfill({ json: fixture("admin") }));
  await page.route("**/api/shared/preview", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: {
      requestId, state: "preview", actionId: "verify", environment: "dev", repository: "ninjapaw/pawprint", workflow: "shared-easm.yml", ref: "dev",
      createdAt: new Date().toISOString(), action: { label: "Verify EASM", write: false, discovery: false },
      notice: "Uses CURRENT protected configuration; scopes cannot be edited here.",
    } });
  });
  await page.route("**/api/shared/requests", async (route) => {
    confirmations += 1;
    const body = route.request().postDataJSON();
    expect(body).toEqual({ requestId, confirmProtectedConfiguration: true, approveWrite: false, approveDiscovery: false });
    await route.fulfill({ status: 202, json: {
      requestId, actionId: "verify", environment: "dev", state: "accepted", createdAt: new Date().toISOString(),
      message: "GitHub accepted the request. No run has yet been correlated; started/completed is not implied.",
    } });
  });
  await page.goto("/");
  const easm = page.locator(".service-card").first();
  await easm.locator("summary").click();
  await easm.getByRole("button", { name: "Verify EASM" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("CURRENT protected configuration");
  await page.getByRole("button", { name: "Confirm workflow request" }).click();
  expect(confirmations).toBe(0);
  await page.getByLabel("I confirm this uses the current protected configuration", { exact: false }).check();
  await page.getByRole("button", { name: "Confirm workflow request" }).click();
  await expect(page.locator("[data-operation-message]")).toContainText("GitHub accepted");
  await expect(page.getByRole("button", { name: "Confirm workflow request" })).toBeDisabled();
  expect(confirmations).toBe(1);
  expect(posts).toEqual([{ actionId: "verify", environment: "dev" }]);
});

test("retains uncertainty and the UUID without automatic dispatch retry", async ({ page }) => {
  let confirmations = 0;
  await page.route("**/api/shared/status?environment=*", (route) => route.fulfill({ json: fixture("admin") }));
  await page.route("**/api/shared/preview", (route) => route.fulfill({ status: 201, json: {
    requestId, state: "preview", actionId: "verify", environment: "dev", repository: "ninjapaw/pawprint", workflow: "shared-easm.yml", ref: "dev",
    createdAt: new Date().toISOString(), action: { label: "Verify EASM", write: false, discovery: false }, notice: "Current protected configuration.",
  } }));
  await page.route("**/api/shared/requests", async (route) => {
    confirmations += 1;
    await route.fulfill({ status: 503, json: { error: "Uncertain GitHub response." } });
  });
  await page.goto("/");
  await page.locator(".service-card").first().locator("summary").click();
  await page.getByRole("button", { name: "Verify EASM", exact: true }).click();
  await page.getByLabel("I confirm this uses the current protected configuration", { exact: false }).check();
  await page.getByRole("button", { name: "Confirm workflow request" }).click();
  await expect(page.locator("[data-operation-message]")).toContainText("No automatic redispatch");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-shared-activity]")).toContainText(requestId);
  await expect(page.locator("[data-shared-activity]")).toContainText("uncertain");
  expect(confirmations).toBe(1);
});
