/**
 * Pawprint preflight.
 *
 * Checks everything a deployment depends on and reports all findings at once,
 * rather than failing at the first missing prerequisite. Read-only: it changes
 * nothing and is safe to run against production.
 *
 * Exit codes: 0 all checks passed or only warnings, 1 at least one failure.
 *
 * Usage:
 *   node scripts/pawprint-doctor.mjs
 *   node scripts/pawprint-doctor.mjs --environment prod
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stdout } from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NEEDS_SHELL = process.platform === "win32";

const style = {
  head: (text) => `\n\x1b[1m${text}\x1b[0m\n`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
};

const MARK = {
  pass: "\x1b[32mpass\x1b[0m",
  warn: "\x1b[33mwarn\x1b[0m",
  fail: "\x1b[31mfail\x1b[0m",
};

const findings = [];

function record(result, label, detail) {
  findings.push({ result, label, detail });
}

function run(binary, args) {
  const name = NEEDS_SHELL && !binary.includes(".") ? `${binary}.cmd` : binary;
  const result = spawnSync(name, args, { encoding: "utf8", shell: NEEDS_SHELL });
  if (result.status !== 0) return null;
  const output = (result.stdout || "").trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function checkTooling() {
  const node = process.versions.node;
  const major = Number(node.split(".")[0]);
  record(major >= 20 ? "pass" : "fail", "Node.js 20 or newer", `found ${node}`);

  const azVersion = run("az", ["version", "-o", "json"]);
  if (!azVersion) {
    record("fail", "Azure CLI present", "az not found on PATH");
  } else {
    record("pass", "Azure CLI present", `${azVersion["azure-cli"] ?? "unknown"}`);
    record(
      azVersion.extensions?.bicep || run("az", ["bicep", "version"]) ? "pass" : "warn",
      "Bicep available",
      "required to compile infrastructure",
    );
  }

  const ghVersion = run(NEEDS_SHELL ? "gh.exe" : "gh", ["--version"]);
  record(
    ghVersion ? "pass" : "warn",
    "GitHub CLI present",
    ghVersion ? String(ghVersion).split("\n")[0] : "optional; needed to federate CI trust",
  );
}

function checkAzure(environment) {
  const account = run("az", ["account", "show", "-o", "json"]);
  if (!account) {
    record("fail", "Signed in to Azure", "run 'az login'");
    return null;
  }
  record("pass", "Signed in to Azure", `${account.user?.name ?? "unknown"}`);
  record(
    account.state === "Enabled" ? "pass" : "fail",
    "Subscription is enabled",
    `${account.name} (${account.id}) is ${account.state}`,
  );
  return account;
}

function checkConfig(environment, account) {
  const resolver = resolve(REPO_ROOT, "scripts/pawprint-config.mjs");
  const args = [resolver, "--environment", environment, "--json"];
  if (account) args.push("--subscription", account.id);

  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const message = (result.stderr || "").trim().split("\n")[0] ?? "configuration is invalid";
    // The allowlist failing closed is expected before approval, not a broken setup.
    record(
      message.includes("approved subscriptions") || message.includes("not in the approved list") ? "warn" : "fail",
      `Configuration resolves for '${environment}'`,
      message,
    );
    return null;
  }

  const resolved = JSON.parse(result.stdout);
  record("pass", `Configuration resolves for '${environment}'`, resolved.configHash);
  return resolved;
}

function checkIdentity(resolved) {
  const admin = resolved?.resolved?.admin;
  if (!admin || admin.mode === undefined) {
    record("warn", "Admin identity configured", "run 'npm run setup' to register the admin application");
    return;
  }
  record("pass", "Admin identity configured", `mode ${admin.mode}`);

  if (admin.mode === "local") {
    record(
      admin.bindAddress === "127.0.0.1" || admin.bindAddress === "localhost" ? "pass" : "fail",
      "Local console bound to loopback",
      `bindAddress is ${admin.bindAddress ?? "unset"}`,
    );
  }
}

function checkCiTrust() {
  if (!existsSync(resolve(REPO_ROOT, ".pawprint-install.json"))) {
    record("warn", "Install manifest present", "uninstall would fall back to tag discovery");
    return;
  }
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, ".pawprint-install.json"), "utf8"));
  record("pass", "Install manifest present", `${manifest.objects?.length ?? 0} object(s) recorded`);

  const federated = (manifest.objects ?? []).filter((o) => o.kind === "federatedIdentityCredential");
  record(
    federated.length > 0 ? "pass" : "warn",
    "GitHub Actions federated trust",
    federated.length > 0
      ? federated.map((credential) => credential.displayName).join(", ")
      : "no federated credential recorded; CI cannot authenticate to Azure",
  );
}

function main() {
  const { values } = parseArgs({ options: { environment: { type: "string", default: "dev" } } });

  stdout.write(style.head(`Pawprint preflight (${values.environment})`));
  stdout.write(style.dim("Read-only. Nothing is changed.\n"));

  checkTooling();
  const account = checkAzure(values.environment);
  const resolved = checkConfig(values.environment, account);
  checkIdentity(resolved);
  checkCiTrust();

  stdout.write("\n");
  for (const finding of findings) {
    stdout.write(`   ${MARK[finding.result]}  ${finding.label.padEnd(38)} ${style.dim(finding.detail)}\n`);
  }

  const failures = findings.filter((finding) => finding.result === "fail").length;
  const warnings = findings.filter((finding) => finding.result === "warn").length;

  stdout.write(
    style.head("Summary") +
      `   ${findings.length - failures - warnings} passed, ${warnings} warning(s), ${failures} failure(s)\n`,
  );

  if (failures > 0) {
    stdout.write(style.dim("   Resolve the failures above before deploying.\n"));
    process.exit(1);
  }
}

main();
