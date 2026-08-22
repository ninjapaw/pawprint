/**
 * Pawprint connector detection and planning.
 *
 * Detects which environments are reachable, shows what each permission tier
 * would cost in consent terms, and reports which capabilities each tier unlocks.
 *
 * Nothing is requested or granted here. Consent is incremental: a permission is
 * only ever asked for when a capability you enabled actually needs it.
 *
 * Usage:
 *   node scripts/pawprint-connect.mjs                     # detect and report
 *   node scripts/pawprint-connect.mjs --plan microsoft365=read,azure=write
 *   node scripts/pawprint-connect.mjs --capabilities      # capability matrix
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stdout } from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = resolve(REPO_ROOT, "config/connectors.catalog.json");
const CONFIG_PATH = resolve(REPO_ROOT, "config/deploy.config.json");

const TIER_ORDER = ["none", "read", "write", "admin"];

const NEEDS_SHELL = process.platform === "win32";
const AZ_BIN = NEEDS_SHELL ? "az.cmd" : "az";

const style = {
  head: (text) => `\n\x1b[1m${text}\x1b[0m\n`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  warn: (text) => `\x1b[33m${text}\x1b[0m`,
  good: (text) => `\x1b[32m${text}\x1b[0m`,
  bad: (text) => `\x1b[31m${text}\x1b[0m`,
};

class ConnectError extends Error {}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function azProbe(args) {
  const result = spawnSync(AZ_BIN, args, { encoding: "utf8", shell: NEEDS_SHELL });
  if (result.status !== 0) return null;
  const output = (result.stdout || "").trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

/** Read-only presence checks. None of these require more than sign-in already grants. */
function detect() {
  const account = azProbe(["account", "show", "-o", "json"]);

  const detected = {
    azure: account
      ? { present: true, detail: `${account.name} (${account.id})`, subscriptionId: account.id }
      : { present: false, detail: "not signed in to Azure" },
    microsoft365: { present: false, detail: "requires an Azure or Graph sign-in to probe" },
    github: { present: false, detail: "no GitHub CLI session" },
  };

  if (account) {
    const organisation = azProbe([
      "rest",
      "--method",
      "get",
      "--url",
      "https://graph.microsoft.com/v1.0/organization",
      "-o",
      "json",
    ])?.value?.[0];
    if (organisation) {
      const domain = organisation.verifiedDomains?.find((entry) => entry.isDefault)?.name;
      detected.microsoft365 = {
        present: true,
        detail: `${organisation.displayName}${domain ? ` (${domain})` : ""}`,
        tenantId: organisation.id,
      };
    }
  }

  const ghBin = NEEDS_SHELL ? "gh.exe" : "gh";
  const gh = spawnSync(ghBin, ["auth", "status"], { encoding: "utf8", shell: NEEDS_SHELL });
  if (gh.status === 0) {
    const combined = `${gh.stdout ?? ""}${gh.stderr ?? ""}`;
    const host = combined.match(/([A-Za-z0-9.-]+)\s*$/m);
    detected.github = {
      present: true,
      detail: combined.includes("github.com") ? "github.com" : (host?.[1] ?? "authenticated"),
    };
  }

  return detected;
}

function loadEnabledTiers() {
  if (!existsSync(CONFIG_PATH)) return {};
  const config = readJson(CONFIG_PATH);
  return config.defaults?.connectors ?? {};
}

function tierAtLeast(actual, required) {
  return TIER_ORDER.indexOf(actual ?? "none") >= TIER_ORDER.indexOf(required);
}

function reportDetection(catalog, detected) {
  stdout.write(style.head("Detected environments"));
  for (const [key, connector] of Object.entries(catalog.connectors)) {
    const state = detected[key] ?? { present: false, detail: "no probe available" };
    const marker = state.present ? style.good("found") : style.dim("absent");
    stdout.write(`   ${connector.title.padEnd(26)} ${marker.padEnd(20)} ${state.detail}\n`);
  }
}

function reportTiers(catalog, connectorKey) {
  const connector = catalog.connectors[connectorKey];
  if (!connector) throw new ConnectError(`Unknown connector '${connectorKey}'.`);

  stdout.write(style.head(`${connector.title} — permission tiers`));
  stdout.write(style.dim(`   ${connector.description}\n`));

  for (const tierName of TIER_ORDER) {
    const tier = connector.tiers[tierName];
    if (!tier) continue;

    const consentMarker =
      tier.consent === "admin"
        ? style.warn("admin consent required")
        : tier.consent === "user"
          ? style.good("user consent only")
          : style.dim("no consent step");

    stdout.write(`\n   ${tierName.toUpperCase().padEnd(6)} ${consentMarker}\n`);
    stdout.write(`          ${tier.summary}\n`);

    for (const permission of tier.permissions) {
      const kind =
        permission.type === "application"
          ? style.warn("application")
          : permission.type === "delegated"
            ? style.good("delegated ")
            : permission.type;
      const scope = permission.scope ? ` @${permission.scope}` : "";
      stdout.write(`          ${kind}  ${permission.name}${scope}\n`);
      stdout.write(style.dim(`                      ${permission.rationale}\n`));
    }

    if (tier.note) stdout.write(style.dim(`          note: ${tier.note}\n`));
  }
}

function reportCapabilities(catalog, enabled) {
  stdout.write(style.head("Capabilities"));

  const available = [];
  const unavailable = [];

  for (const [key, capability] of Object.entries(catalog.capabilities)) {
    const unmet = capability.requires.filter(
      (requirement) => !tierAtLeast(enabled[requirement.connector], requirement.minTier),
    );
    (unmet.length === 0 ? available : unavailable).push({ key, capability, unmet });
  }

  stdout.write(`\n   ${style.good("Available")} (${available.length})\n`);
  for (const entry of available) {
    stdout.write(`      ${entry.key.padEnd(32)} ${entry.capability.title}\n`);
  }
  if (available.length === 0) stdout.write(style.dim("      none\n"));

  stdout.write(`\n   ${style.dim("Unavailable")} (${unavailable.length})\n`);
  for (const entry of unavailable) {
    const needs = entry.unmet
      .map((requirement) => `${requirement.connector}=${requirement.minTier}`)
      .join(", ");
    stdout.write(`      ${entry.key.padEnd(32)} ${entry.capability.title}\n`);
    stdout.write(style.dim(`      ${"".padEnd(32)} needs ${needs}\n`));
    stdout.write(style.dim(`      ${"".padEnd(32)} without it: ${entry.capability.degraded}\n`));
  }
}

function parsePlan(plan) {
  const tiers = {};
  for (const pair of plan.split(",")) {
    const [connector, tier] = pair.split("=").map((part) => part.trim());
    if (!connector || !tier) throw new ConnectError(`Malformed plan entry '${pair}'. Use connector=tier.`);
    if (!TIER_ORDER.includes(tier)) {
      throw new ConnectError(`Unknown tier '${tier}'. Valid tiers: ${TIER_ORDER.join(", ")}.`);
    }
    tiers[connector] = tier;
  }
  return tiers;
}

function reportConsentCost(catalog, planned) {
  stdout.write(style.head("Consent this plan would require"));

  let adminConsentNeeded = false;
  let applicationPermissions = 0;

  for (const [connectorKey, tierName] of Object.entries(planned)) {
    const connector = catalog.connectors[connectorKey];
    if (!connector) throw new ConnectError(`Unknown connector '${connectorKey}'.`);

    // Tiers are cumulative, so the cost of a plan is every tier up to the chosen one.
    for (const candidate of TIER_ORDER.slice(0, TIER_ORDER.indexOf(tierName) + 1)) {
      const tier = connector.tiers[candidate];
      if (!tier) continue;
      if (tier.consent === "admin" && tier.permissions.length > 0) adminConsentNeeded = true;
      applicationPermissions += tier.permissions.filter((p) => p.type === "application").length;
    }
    stdout.write(`   ${connector.title.padEnd(26)} ${tierName}\n`);
  }

  stdout.write("\n");
  stdout.write(
    adminConsentNeeded
      ? style.warn("   A directory administrator must consent for the organisation.\n")
      : style.good("   No admin consent required. The signed-in user can consent for themselves.\n"),
  );

  if (applicationPermissions > 0) {
    stdout.write(
      style.warn(
        `   ${applicationPermissions} application permission(s) requested. These are standing access\n` +
          "   that ignores Conditional Access and the signed-in user's own limits. Prefer a\n" +
          "   delegated tier unless you genuinely need unattended operation.\n",
      ),
    );
  } else {
    stdout.write(style.dim("   All permissions are delegated, so access never exceeds the signed-in user.\n"));
  }

  stdout.write(
    style.dim(
      "\n   Nothing was requested. Consent is incremental: a permission is asked for only\n" +
        "   when a capability you enabled actually needs it.\n",
    ),
  );
}

function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      connector: { type: "string" },
      capabilities: { type: "boolean", default: false },
    },
  });

  const catalog = readJson(CATALOG_PATH);

  if (values.connector) {
    reportTiers(catalog, values.connector);
    return;
  }

  if (values.plan) {
    const planned = parsePlan(values.plan);
    reportConsentCost(catalog, planned);
    reportCapabilities(catalog, planned);
    return;
  }

  const detected = detect();
  reportDetection(catalog, detected);

  const enabled = loadEnabledTiers();
  reportCapabilities(catalog, enabled);

  stdout.write(style.head("Next"));
  stdout.write(
    "   See what a tier costs before enabling it:\n" +
      "     node scripts/pawprint-connect.mjs --connector microsoft365\n" +
      "   Model a plan without requesting anything:\n" +
      "     node scripts/pawprint-connect.mjs --plan microsoft365=read,azure=write\n",
  );
}

try {
  main();
} catch (error) {
  if (error instanceof ConnectError) {
    process.stderr.write(`\npawprint connect: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
