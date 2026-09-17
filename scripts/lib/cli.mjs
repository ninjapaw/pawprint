/**
 * Shared subprocess helpers for the pawprint-*.mjs CLI scripts.
 *
 * Deliberately excludes pawprint-setup.mjs's az()/gh()/graph() family: those
 * validate every argument against an allowlist regex before spawning (SetupError
 * on anything unexpected) because that script mutates tenant-wide Entra state.
 * The helpers here are for read-mostly scripts (onboarding, platform audit)
 * where a thrown error already carries enough context without that extra layer.
 */

import { execFileSync } from "node:child_process";

const WINDOWS = process.platform === "win32";
// az ships as a .cmd shim on Windows, which execFile cannot resolve on its own.
export const binary = (command) =>
  WINDOWS && command === "az" ? "az.cmd" : command;
// A shell concatenates rather than escapes, so anything containing a space has
// to carry its own quotes.
const quoted = (argument) =>
  WINDOWS && /\s/.test(argument) ? `"${argument}"` : argument;

export function run(command, args, { allowFailure = false } = {}) {
  try {
    return execFileSync(binary(command), WINDOWS ? args.map(quoted) : args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: WINDOWS,
    }).trim();
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    throw new Error(
      `${command} ${args.join(" ")}\n${error.stderr ?? error.message}`,
    );
  }
}

export const az = (args, options) => run("az", args, options);
export const gh = (args, options) => run("gh", args, options);
