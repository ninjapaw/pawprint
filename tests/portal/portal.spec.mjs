import { expect, test } from "@playwright/test";

const overview = {
  canDeploy: true,
  identity: { github: "operator", azure: "NinjaPaws Dev" },
  workloads: [
    ["m365profiles", "M365 Profiles", "success"],
    ["site", "Ninja Paws Site", "success"],
    ["sentinel-optimizer", "Sentinel Optimizer", "in_progress"],
    ["ninjapaws-cloud-security-dojo", "Cloud Security Dojo", "failure"],
  ].map(([id, label, state]) => ({
    id,
    label,
    description: `${label} deployment status.`,
    environment: "dev",
    siteUrl: "https://example.com/",
    actionsUrl: "https://github.com/ninjapaw",
    action: id,
    run: {
      status: state === "in_progress" ? state : "completed",
      conclusion: state === "in_progress" ? null : state,
      createdAt: "2026-09-01T00:00:00Z",
      url: "https://github.com/ninjapaw",
    },
  })),
  jobs: [],
};

const setupOverview = {
  organization: "ninjapaw",
  appName: "NinjaPaws Pawprint Deploy",
  requiredPermissions: { actions: "write", metadata: "read" },
  requiredRepositories: [
    "m365profiles",
    "site",
    "sentinel-optimizer",
    "ninjapaws-cloud-security-dojo",
  ],
  github: {
    membershipState: "active",
    organizationRole: "admin",
    canCreateApp: true,
  },
  azure: { subscription: "NinjaPaws Dev", keyVault: "np-pawprint-dev-kv" },
  app: { slug: null, enabled: false, installed: false },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/setup/overview", (route) =>
    route.fulfill({ json: setupOverview }),
  );
  await page.goto("/");
});

test("shows fixed GitHub App permissions and repositories", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "GitHub App setup" }),
  ).toBeVisible();
  await expect(page.getByText("GitHub Actions")).toBeVisible();
  await expect(page.getByText("write", { exact: true })).toBeVisible();
  await expect(page.locator("[data-setup-repositories] li")).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "Create and install App" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Audit and enable" }),
  ).toBeEnabled();
});

test("shows workload state and authenticated controls", async ({ page }) => {
  await expect(
    page.getByRole("heading", { name: "Ship with receipts." }),
  ).toBeVisible();
  await expect(page.locator(".workload-card")).toHaveCount(4);
  await expect(page.getByText("operator / NinjaPaws Dev")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Deploy all development workloads" }),
  ).toBeEnabled();
  await expect(page.locator('[data-summary="ready"]')).toHaveText("2");
});

test("fits the viewport without horizontal overflow", async ({ page }) => {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("offers Entra and GitHub only as invited operator identities", async ({ page }) => {
  await page.goto("/login/");
  await expect(page.getByRole("heading", { name: "Choose your identity." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Microsoft Entra" }))
    .toHaveAttribute("href", "/.auth/login/aad?post_login_redirect_uri=/");
  await expect(page.getByRole("link", { name: "Continue with GitHub" }))
    .toHaveAttribute("href", "/.auth/login/github?post_login_redirect_uri=/");
});
