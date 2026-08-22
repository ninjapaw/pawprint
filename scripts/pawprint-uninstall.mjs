/**
 * Pawprint uninstall.
 *
 * Reverses what the setup wizard created, using the recorded object ids in
 * .pawprint-install.json rather than matching on display names. Name matching
 * would risk deleting somebody else's application that happens to be similarly
 * named; ids cannot be ambiguous.
 *
 * Defaults to --what-if. Nothing is removed until you pass --apply.
 *
 * Usage:
 *   node scripts/pawprint-uninstall.mjs                 # show what would happen
 *   node scripts/pawprint-uninstall.mjs --apply
 *   node scripts/pawprint-uninstall.mjs --apply --purge # also empty the 30-day recycle bin
 *   node scripts/pawprint-uninstall.mjs --discover      # find tagged objects with no manifest
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stdout } from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_MANIFEST_PATH = resolve(REPO_ROOT, ".pawprint-install.json");
const LOCAL_ADMIN_PATH = resolve(REPO_ROOT, ".pawprint-local-admin.json");
const PAWPRINT_TAG = "pawprint-managed";

const NEEDS_SHELL = process.platform === "win32";
const AZ_BIN = NEEDS_SHELL ? "az.cmd" : "az";
const SAFE_ARG = /^[A-Za-z0-9._:\/@=+-]*$/;

// Graph URLs legitimately carry OData query syntax, so they get their own rule:
// pinned to the Graph host and, once encoded, restricted to a character set that
// contains nothing a shell can act on.
const SAFE_GRAPH_URL = /^https:\/\/graph\.microsoft\.com\/[A-Za-z0-9._~:\/?=%,-]*$/;

/** Percent-encodes everything a shell might interpret, including parentheses and quotes. */
function encodeODataValue(value) {
  return encodeURIComponent(value).replace(/[()'!*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const style = {
  head: (text) => `\n\x1b[1m${text}\x1b[0m\n`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  warn: (text) => `\x1b[33m${text}\x1b[0m`,
  good: (text) => `\x1b[32m${text}\x1b[0m`,
  bad: (text) => `\x1b[31m${text}\x1b[0m`,
};

class UninstallError extends Error {}

function az(args, { allowFailure = false } = {}) {
  for (const arg of args) {
    const isGraphUrl = arg.startsWith("https://graph.microsoft.com/");
    const acceptable = isGraphUrl ? SAFE_GRAPH_URL.test(arg) : SAFE_ARG.test(arg);
    if (!acceptable) throw new UninstallError(`Refusing to pass unsafe argument to Azure CLI: ${arg}`);
  }
  const result = spawnSync(AZ_BIN, args, { encoding: "utf8", shell: NEEDS_SHELL });
  if (result.error?.code === "ENOENT") throw new UninstallError("Azure CLI not found on PATH.");
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new UninstallError(`az ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").trim()}`);
  }
  const output = (result.stdout || "").trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

const graphGet = (url) => az(["rest", "--method", "get", "--url", url, "-o", "json"], { allowFailure: true });
const graphDelete = (url) => az(["rest", "--method", "delete", "--url", url, "-o", "none"], { allowFailure: true });

/** Deleted before their parent application so nothing is orphaned. */
const DELETE_ORDER = ["appRoleAssignment", "federatedIdentityCredential", "servicePrincipal", "application"];

const GRAPH_COLLECTION = {
  application: "applications",
  servicePrincipal: "servicePrincipals",
};

function loadManifest() {
  if (!existsSync(INSTALL_MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(INSTALL_MANIFEST_PATH, "utf8"));
  } catch (error) {
    throw new UninstallError(`.pawprint-install.json is unreadable: ${error.message}`);
  }
}

/** Fallback when the manifest is lost: find objects carrying the Pawprint tag. */
function discoverTagged() {
  const found = [];
  // Single query parameter only: an ampersand would need shell escaping, and the
  // extra projection is cheaper to do client-side than to make safe.
  const filter = encodeODataValue(`tags/any(t:t eq '${PAWPRINT_TAG}')`);

  for (const [kind, collection] of Object.entries(GRAPH_COLLECTION)) {
    let url = `https://graph.microsoft.com/v1.0/${collection}?%24filter=${filter}`;
    while (url) {
      const response = graphGet(url);
      for (const item of response?.value ?? []) {
        found.push({ kind, id: item.id, appId: item.appId, displayName: item.displayName });
      }
      const next = response?.["@odata.nextLink"];
      url = next && SAFE_GRAPH_URL.test(next) ? next : null;
    }
  }
  return found;
}

function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
      discover: { type: "boolean", default: false },
      "keep-local-credential": { type: "boolean", default: false },
    },
  });

  const manifest = loadManifest();
  let objects = manifest?.objects ?? [];

  if (values.discover || objects.length === 0) {
    if (!manifest) {
      stdout.write(
        style.warn(
          "No .pawprint-install.json found. Falling back to discovery by tag.\n" +
            "Only objects tagged 'pawprint-managed' are considered.\n",
        ),
      );
    }
    objects = discoverTagged();
  }

  stdout.write(style.head(values.apply ? "Pawprint uninstall" : "Pawprint uninstall (what-if)"));

  if (manifest) {
    stdout.write(
      `   instance   ${manifest.instanceId}\n` +
        `   tenant     ${manifest.tenantId}\n` +
        `   installed  ${manifest.createdAt} by ${manifest.createdBy}\n`,
    );
  }

  // --------------------------------------------------------------- directory
  stdout.write(style.head("Directory objects"));
  if (objects.length === 0) {
    stdout.write("   none found\n");
  } else {
    for (const object of objects) {
      stdout.write(`   ${object.kind.padEnd(28)} ${(object.displayName ?? "").padEnd(24)} ${object.id}\n`);
    }
  }

  // ------------------------------------------------------------ untouched
  stdout.write(style.head("Deliberately not touched"));
  stdout.write(
    style.dim(
      "   Tenant-wide settings        never modified by setup\n" +
        "   Conditional Access policies never created by setup\n" +
        "   User consent policy         never modified by setup\n" +
        "   Admin consent grants        never requested; all scopes are user-consentable\n" +
        "   Groups and memberships      never created; you assigned your own\n" +
        "   Sign-in and audit logs      retained by Entra; deliberately not erased\n",
    ),
  );

  // ------------------------------------------------------------ irreversible
  const irreversible = manifest?.irreversible ?? [];
  if (irreversible.length > 0) {
    stdout.write(style.head("Cannot be reversed"));
    for (const item of irreversible) stdout.write(`   ${style.bad("!")} ${item}\n`);
  }

  if (!values.apply) {
    stdout.write(
      style.head("What-if only") +
        "   Nothing was changed. Re-run with --apply to remove the objects listed above.\n" +
        style.dim("   Deleted applications remain restorable for 30 days; add --purge to empty that bin.\n"),
    );
    return;
  }

  // ------------------------------------------------------------------ apply
  stdout.write(style.head("Removing"));
  const ordered = [...objects].sort(
    (a, b) => DELETE_ORDER.indexOf(a.kind) - DELETE_ORDER.indexOf(b.kind),
  );

  let removed = 0;
  let failed = 0;

  for (const object of ordered) {
    const collection = GRAPH_COLLECTION[object.kind];
    if (!collection) {
      stdout.write(`   ${style.warn("skip")}  ${object.kind} ${object.id} (no known Graph collection)\n`);
      continue;
    }
    const result = graphDelete(`https://graph.microsoft.com/v1.0/${collection}/${object.id}`);
    if (result === null && graphGet(`https://graph.microsoft.com/v1.0/${collection}/${object.id}`)) {
      failed += 1;
      stdout.write(`   ${style.bad("fail")}  ${object.kind} ${object.id} still present\n`);
      continue;
    }
    removed += 1;
    stdout.write(`   ${style.good("ok")}    ${object.kind} ${object.displayName ?? object.id}\n`);

    if (values.purge && object.kind === "application") {
      graphDelete(`https://graph.microsoft.com/v1.0/directory/deletedItems/${object.id}`);
      stdout.write(`   ${style.good("ok")}    purged ${object.displayName ?? object.id} from the recycle bin\n`);
    }
  }

  // --------------------------------------------------------------- local files
  if (!values["keep-local-credential"] && existsSync(LOCAL_ADMIN_PATH)) {
    rmSync(LOCAL_ADMIN_PATH, { force: true });
    stdout.write(`   ${style.good("ok")}    removed local admin credential hash\n`);
  }
  if (existsSync(INSTALL_MANIFEST_PATH) && failed === 0) {
    rmSync(INSTALL_MANIFEST_PATH, { force: true });
    stdout.write(`   ${style.good("ok")}    removed install manifest\n`);
  }

  stdout.write(style.head("Done"));
  stdout.write(`   ${removed} removed, ${failed} failed\n`);
  if (!values.purge) {
    stdout.write(
      style.dim(
        "   Deleted applications stay restorable for 30 days. Re-run with --purge to\n" +
          "   empty the recycle bin, or leave them so the change can be undone.\n",
      ),
    );
  }
  stdout.write(
    style.dim(
      "   Azure resources are separate: each run owns a resource group tagged\n" +
        "   pawprint.expiresAt. Delete the group, or let the reaper workflow do it.\n",
    ),
  );

  if (failed > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  if (error instanceof UninstallError) {
    process.stderr.write(`\npawprint uninstall: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
