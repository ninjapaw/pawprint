/**
 * Pawprint setup wizard.
 *
 * Detects the Azure and Entra context, lets the operator choose a directory,
 * probes whether they can actually register an application, creates the admin
 * app registration with app roles, and writes the non-secret result to
 * config/deploy.config.json.
 *
 * Every prompt shows a recommended default in brackets; pressing Enter accepts it.
 *
 * Nothing secret is ever written to disk or echoed. Credentials prefer federated
 * identity, then certificate, and only then a client secret.
 *
 * Usage:
 *   node scripts/pawprint-setup.mjs
 *   node scripts/pawprint-setup.mjs --accept-defaults
 *   node scripts/pawprint-setup.mjs --dry-run
 */

import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(REPO_ROOT, "config/deploy.config.json");

/** Well-known Entra directory role template IDs that permit app registration. */
const ROLE_TEMPLATES = {
  "62e90394-69f5-4237-9190-012177145e10": "Global Administrator",
  "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3": "Application Administrator",
  "158c047a-c907-4556-b7ef-446551a6b5f7": "Cloud Application Administrator",
};

const APP_ROLES = [
  { value: "Pawprint.Admin", description: "Configure identity, sinks and environments; perform destructive operations." },
  { value: "Pawprint.Operator", description: "Deploy, remediate and destroy runs." },
  { value: "Pawprint.Reader", description: "View pawprints and configuration." },
];

const style = {
  head: (text) => `\n\x1b[1m${text}\x1b[0m\n`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  warn: (text) => `\x1b[33m${text}\x1b[0m`,
  bad: (text) => `\x1b[31m${text}\x1b[0m`,
  good: (text) => `\x1b[32m${text}\x1b[0m`,
};

class SetupError extends Error {}

// Node refuses to spawn .cmd/.bat without a shell, and the Azure CLI on Windows
// is az.cmd. A shell is therefore unavoidable there, so every argument is
// validated against a conservative allowlist before it is passed. Input
// validation, not quoting, is the control that makes this safe.
const NEEDS_SHELL = process.platform === "win32";
const AZ_BIN = NEEDS_SHELL ? "az.cmd" : "az";
const SAFE_ARG = /^[A-Za-z0-9._:\/@=+-]*$/;

function assertSafeArgs(args) {
  for (const arg of args) {
    if (!SAFE_ARG.test(arg)) {
      throw new SetupError(
        `Refusing to pass '${arg}' to the Azure CLI: it contains characters outside the allowed set ` +
          `[A-Za-z0-9._:/@=+-]. Choose a simpler value.`,
      );
    }
  }
}

function az(args, { allowFailure = false } = {}) {
  assertSafeArgs(args);
  const result = spawnSync(AZ_BIN, args, { encoding: "utf8", shell: NEEDS_SHELL });
  if (result.error && result.error.code === "ENOENT") {
    throw new SetupError("Azure CLI not found on PATH. Install it, or run with --mode local.");
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new SetupError(`az ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").trim()}`);
  }
  const output = (result.stdout || "").trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function graph(url, { allowFailure = true } = {}) {
  return az(["rest", "--method", "get", "--url", url, "-o", "json"], { allowFailure });
}

async function main() {
  const { values } = parseArgs({
    options: {
      "accept-defaults": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      mode: { type: "string" },
    },
  });

  const rl = createInterface({ input: stdin, output: stdout });
  const acceptDefaults = values["accept-defaults"];
  const dryRun = values["dry-run"];

  /** Prompt showing a default in brackets; Enter accepts it. */
  const ask = async (question, fallback) => {
    if (acceptDefaults) {
      stdout.write(`${question} [${fallback}]: ${fallback}\n`);
      return fallback;
    }
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
    return answer === "" ? fallback : answer;
  };

  const confirm = async (question, fallback = "y") => {
    const answer = (await ask(`${question} (y/n)`, fallback)).toLowerCase();
    return answer.startsWith("y");
  };

  try {
    stdout.write(style.head("Pawprint setup"));
    stdout.write(
      style.dim(
        "Recommended defaults are shown in brackets. Press Enter to accept.\n" +
          "Nothing secret is written to disk or printed.\n",
      ),
    );

    // Local mode exists precisely for operators with no Azure access, so it must
    // not require an Azure sign-in to reach.
    if (values.mode === "local") {
      await configureLocalMode({ ask, dryRun });
      rl.close();
      return;
    }

    // ---------------------------------------------------------------- detect
    stdout.write(style.head("1. Detecting your Azure context"));
    const account = az(["account", "show", "-o", "json"], { allowFailure: true });
    if (!account) {
      throw new SetupError("Not signed in to Azure. Run 'az login' first, or choose local mode with --mode local.");
    }
    stdout.write(
      `   subscription  ${account.name} (${account.id})\n` +
        `   home tenant   ${account.tenantId}\n` +
        `   signed in as  ${account.user?.name ?? "unknown"}\n`,
    );

    // ------------------------------------------------------------ auth mode
    stdout.write(style.head("2. Choosing an authentication mode"));
    stdout.write(
      style.dim(
        "   entra           Workforce tenant sign-in. Recommended.\n" +
          "   local           Generated credential bound to 127.0.0.1. Air-gapped or no-Azure use.\n" +
          "   entra-external  External ID (CIAM) tenant. Advanced; see docs/IDENTITY.md.\n",
      ),
    );
    const mode = values.mode ?? (await ask("   Mode", "entra"));

    if (mode === "local") {
      await configureLocalMode({ ask, dryRun });
      rl.close();
      return;
    }

    if (mode === "entra-external") {
      stdout.write(
        style.warn(
          "\n   External ID tenants have 7-day log retention, no Identity Protection,\n" +
            "   no PIM, sharply reduced Conditional Access, and MAU billing for every\n" +
            "   admin. For an admin console this is usually the wrong choice.\n" +
            "   See docs/IDENTITY.md for the full comparison.\n",
        ),
      );
      if (!(await confirm("   Continue with an external tenant anyway?", "n"))) {
        throw new SetupError("Cancelled. Re-run and choose 'entra' to use your workforce tenant.");
      }
    }

    // --------------------------------------------------------- pick tenant
    stdout.write(style.head("3. Choosing a directory"));
    const tenants = az(["account", "tenant", "list", "-o", "json"], { allowFailure: true }) ?? [];
    const listed = tenants.length > 0 ? tenants : [{ tenantId: account.tenantId }];

    // az account tenant list often omits the display name and domain, which
    // makes the picker useless. Fill in what Graph can tell us about the tenant
    // we are currently signed in to.
    const organisation = graph("https://graph.microsoft.com/v1.0/organization")?.value?.[0];
    for (const tenant of listed) {
      if (tenant.tenantId !== account.tenantId) continue;
      tenant.displayName ??= organisation?.displayName;
      tenant.defaultDomain ??= organisation?.verifiedDomains?.find((domain) => domain.isDefault)?.name;
    }

    listed.forEach((tenant, index) => {
      const bound = tenant.tenantId === account.tenantId;
      const domain = tenant.defaultDomain ?? tenant.domains?.[0] ?? tenant.tenantId;
      const kind = String(domain).includes("ciamlogin.com") ? " (external)" : "";
      stdout.write(
        `   [${index + 1}] ${(tenant.displayName ?? "unnamed").padEnd(32)} ${String(domain).padEnd(34)}` +
          `${bound ? style.good("bound to subscription") : ""}${kind}\n`,
      );
    });
    stdout.write(`   [n] Create a new tenant\n`);

    const defaultIndex = String(Math.max(1, listed.findIndex((t) => t.tenantId === account.tenantId) + 1));
    const choice = await ask("   Directory", defaultIndex);

    if (choice.toLowerCase() === "n") {
      // Creating a directory has billing and governance consequences. It must
      // never happen because someone held down Enter.
      stdout.write(
        style.warn(
          "\n   Creating a tenant is a governance decision, not a setup step.\n" +
            "   It adds a directory to govern, licence, monitor and offboard from.\n\n",
        ) +
          "   Create it deliberately, then re-run this wizard and select it:\n" +
          "     Workforce tenant:  https://entra.microsoft.com  >  Manage tenants  >  Create\n" +
          "     External tenant:   az rest --method post \\\n" +
          "       --url https://graph.microsoft.com/beta/tenantRelationships/managedTenants\n\n" +
          "   Before you do, read docs/IDENTITY.md. In almost every case the tenant\n" +
          "   already bound to your subscription is the correct answer.\n",
      );
      throw new SetupError("No directory selected.");
    }

    const selected = listed[Number(choice) - 1];
    if (!selected) throw new SetupError(`'${choice}' is not one of the listed directories.`);
    const tenantId = selected.tenantId;

    // ----------------------------------------------------- probe permissions
    stdout.write(style.head("4. Checking your permissions"));
    const roles = graph("https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.directoryRole");
    const held = (roles?.value ?? [])
      .map((role) => ROLE_TEMPLATES[role.roleTemplateId])
      .filter(Boolean);

    if (held.length > 0) {
      stdout.write(`   ${style.good("ok")}  You hold: ${held.join(", ")}\n`);
    } else {
      stdout.write(
        style.warn(
          "   Could not confirm a role that permits app registration.\n" +
            "   Application Administrator or Cloud Application Administrator is sufficient.\n" +
            "   Global Administrator is not required and is not requested.\n" +
            "   Some tenants also allow all users to register applications.\n",
        ),
      );
      if (!(await confirm("   Attempt registration anyway?", "y"))) {
        throw new SetupError("Cancelled. Ask a directory admin to grant Application Administrator.");
      }
    }

    // ----------------------------------------------------- register the app
    stdout.write(style.head("5. Registering the admin application"));
    const appName = await ask("   Application name", "pawprint-admin");
    const redirectUri = await ask("   Loopback redirect URI", "http://localhost:7878/auth/callback");
    const requireAssignment = await confirm("   Require explicit user or group assignment to sign in?", "y");

    const manifest = {
      displayName: appName,
      signInAudience: "AzureADMyOrg",
      web: { redirectUris: [redirectUri] },
      appRoles: APP_ROLES.map((role) => ({
        id: randomUUID(),
        allowedMemberTypes: ["User"],
        displayName: role.value,
        value: role.value,
        description: role.description,
        isEnabled: true,
      })),
    };

    if (dryRun) {
      stdout.write(style.dim(`\n   dry run, not creating:\n${JSON.stringify(manifest, null, 2)}\n`));
      rl.close();
      return;
    }

    const manifestPath = resolve(REPO_ROOT, ".pawprint-app-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const created = az(["ad", "app", "create", "--display-name", appName, "-o", "json"]);
    const clientId = created?.appId;
    if (!clientId) throw new SetupError("Application was created but no appId was returned.");

    az(["ad", "app", "update", "--id", clientId, "--web-redirect-uris", redirectUri], { allowFailure: true });
    az(["ad", "sp", "create", "--id", clientId, "-o", "none"], { allowFailure: true });
    if (requireAssignment) {
      az(["ad", "sp", "update", "--id", clientId, "--set", "appRoleAssignmentRequired=true"], { allowFailure: true });
    }

    stdout.write(`   ${style.good("ok")}  Registered ${appName}\n   client id  ${clientId}\n`);
    stdout.write(
      style.dim(
        "   No client secret was created. Federated identity credentials are used for CI,\n" +
          "   and interactive sign-in needs no application credential at all.\n",
      ),
    );

    // -------------------------------------------------------- write config
    stdout.write(style.head("6. Writing configuration"));
    const authority =
      mode === "entra-external"
        ? `https://${(selected.defaultDomain ?? "").split(".")[0]}.ciamlogin.com`
        : `https://login.microsoftonline.com/${tenantId}`;

    writeConfig({
      admin: {
        mode,
        tenantId,
        clientId,
        authority,
        credential: "federated",
        requireAssignment,
        appRoles: APP_ROLES.map((role) => role.value),
        sessionMinutes: 60,
      },
    });

    stdout.write(
      `   ${style.good("ok")}  config/deploy.config.json updated with tenantId, clientId and authority.\n` +
        style.dim("   These are identifiers, not secrets, and are safe to commit.\n"),
    );

    stdout.write(style.head("Next steps"));
    stdout.write(
      "   1. Assign Pawprint.Admin to a group, not to individuals, so your existing\n" +
        "      joiner-mover-leaver process governs access.\n" +
        "   2. Apply a Conditional Access policy to this application.\n" +
        "   3. Optionally enable the durable evidence store:\n" +
        "      modules/evidence-store/main.bicep with immutable: true\n",
    );
  } finally {
    rl.close();
  }
}

async function configureLocalMode({ ask, dryRun }) {
  stdout.write(style.head("Local mode"));
  stdout.write(
    style.warn(
      "   Local mode is convenient, not secure. It exists so Pawprint works without\n" +
        "   Azure, not so you can skip identity. Do not expose it to a network.\n",
    ),
  );

  const bindAddress = await ask("   Bind address", "127.0.0.1");
  if (bindAddress !== "127.0.0.1" && bindAddress !== "localhost") {
    stdout.write(
      style.bad(
        `   Binding to ${bindAddress} exposes the console beyond this machine.\n` +
          "   Use entra mode for anything reachable over a network.\n",
      ),
    );
  }

  const username = await ask("   Admin username", "pawprint-admin");
  const password = randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");

  if (dryRun) {
    stdout.write(style.dim("   dry run, no credential stored.\n"));
    return;
  }

  writeConfig({
    admin: {
      mode: "local",
      bindAddress,
      sessionMinutes: 60,
      credential: "none",
    },
  });

  // Only the salted hash is persisted. The password is displayed once and is
  // unrecoverable; re-run the wizard to issue a new one.
  writeFileSync(
    resolve(REPO_ROOT, ".pawprint-local-admin.json"),
    JSON.stringify({ username, salt, hash, algorithm: "scrypt", createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );

  stdout.write(
    `\n   ${style.good("Credential generated. This is shown once and cannot be recovered.")}\n\n` +
      `      username  ${username}\n` +
      `      password  ${password}\n\n` +
      style.dim("   Only a salted scrypt hash was stored, in .pawprint-local-admin.json (git-ignored).\n"),
  );
}

function writeConfig(patch) {
  const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : { configVersion: "1.0.0" };
  const merged = {
    ...existing,
    defaults: { ...(existing.defaults ?? {}), ...patch },
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  if (error instanceof SetupError) {
    process.stderr.write(`\npawprint setup: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
