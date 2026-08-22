/**
 * Validates scenario manifests against the schema and enforces catalog policy.
 *
 * Schema validation proves the manifest is well formed. Policy validation
 * proves it is safe to publish: bounded lifetime, declared blast radius, and
 * evidence that is actually observed rather than assumed.
 *
 * Usage:
 *   node scripts/validate-scenario.mjs scenarios/**\/scenario.json
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Ceiling no scenario may exceed, whatever its manifest asks for. */
const TTL_CEILING_HOURS = 168;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * Translates a glob to an anchored regex.
 *   `**​/` matches zero or more leading path segments
 *   `**`  matches across segment boundaries
 *   `*`   matches within a single segment
 */
function globToRegExp(pattern) {
  let expression = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      const doubled = pattern[index + 1] === "*";
      if (doubled && pattern[index + 2] === "/") {
        expression += "(?:[^/]+/)*";
        index += 2;
      } else if (doubled) {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
      continue;
    }

    expression += character.replace(/[.+^${}()|[\]\\?]/, "\\$&");
  }

  return new RegExp(`^${expression}$`);
}

/**
 * Expands globs in-process. Windows cmd does not expand them for npm scripts,
 * so relying on the shell would make the validator behave differently per
 * platform. Supports ** and *.
 */
function expandGlobs(patterns) {
  const results = [];

  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      results.push(pattern);
      continue;
    }

    const normalized = pattern.split("\\").join("/");
    const segments = normalized.split("/");
    const fixedDepth = segments.findIndex((segment) => segment.includes("*"));
    const root = segments.slice(0, fixedDepth).join("/") || ".";
    const expression = globToRegExp(normalized);

    const walk = (directory) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const path = join(directory, entry.name);
        const comparable = path.split(sep).join("/").replace(/^\.\//, "");
        if (entry.isDirectory()) {
          walk(path);
        } else if (expression.test(comparable)) {
          results.push(path);
        }
      }
    };

    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // Missing root directory simply yields no matches.
    }
  }

  return [...new Set(results)].sort();
}

/**
 * Policy rules applied on top of schema validation. Each returns an error
 * string, or null when the scenario complies.
 */
const POLICIES = [
  {
    id: "teardown-declared",
    check: (s) =>
      s.stages?.includes("destroy")
        ? null
        : "stages must include 'destroy'. Every scenario must be able to release its resources.",
  },
  {
    id: "ttl-bounded",
    check: (s) => {
      const ttl = s.safety?.defaultTtlHours;
      const max = s.safety?.maxTtlHours;
      if (typeof ttl !== "number" || ttl <= 0) return "safety.defaultTtlHours must be a positive number.";
      if (ttl > TTL_CEILING_HOURS) return `safety.defaultTtlHours ${ttl} exceeds the ${TTL_CEILING_HOURS} hour ceiling.`;
      if (typeof max === "number" && max < ttl)
        return `safety.maxTtlHours (${max}) is below safety.defaultTtlHours (${ttl}).`;
      return null;
    },
  },
  {
    id: "vulnerable-requires-disclaimer",
    check: (s) =>
      s.safety?.intentionallyVulnerable && !s.safety?.disclaimer
        ? "safety.disclaimer is required when safety.intentionallyVulnerable is true."
        : null,
  },
  {
    id: "public-ingress-justified",
    check: (s) =>
      s.safety?.publicIngress && !(s.safety?.ingressJustification ?? "").trim()
        ? "safety.ingressJustification is required when safety.publicIngress is true."
        : null,
  },
  {
    id: "endpoints-match-ingress",
    check: (s) => {
      const hasPublicEndpoint = (s.endpoints ?? []).some((endpoint) => endpoint.public);
      if (hasPublicEndpoint && !s.safety?.publicIngress) {
        return "an endpoint is marked public but safety.publicIngress is false. The declared blast radius must match reality.";
      }
      return null;
    },
  },
  {
    id: "evidence-from-runtime",
    check: (s) => {
      const sources = new Set((s.assertions ?? []).map((assertion) => assertion.source));
      if (sources.size === 1 && sources.has("config")) {
        return "every assertion reads from 'config'. At least one assertion must observe the running system, otherwise the scenario proves only what it requested.";
      }
      return null;
    },
  },
  {
    id: "critical-parameters-versioned",
    check: (s) => {
      const offenders = Object.entries(s.parameters ?? {})
        .filter(([, spec]) => spec.critical && spec.default === undefined && !spec.required)
        .map(([name]) => name);
      return offenders.length
        ? `critical parameter(s) ${offenders.join(", ")} declare neither a default nor required:true. ` +
            "A critical value must be versioned in the manifest or explicitly demanded, never silently defaulted at runtime."
        : null;
    },
  },
  {
    id: "cost-declared",
    check: (s) =>
      typeof s.cost?.estimatedPerHour === "number" && s.cost.estimatedPerHour >= 0
        ? null
        : "cost.estimatedPerHour must be declared. Adopters deploy into their own subscription.",
  },
  {
    id: "remediation-is-verified",
    check: (s) => {
      const stages = new Set(s.stages ?? []);
      if (!stages.has("remediate")) return null;
      const verified = (s.assertions ?? []).some((assertion) => assertion.stage === "verify");
      return verified
        ? null
        : "a scenario that remediates must also assert in the 'verify' stage that the condition cleared.";
    },
  },
];

function main() {
  const patterns = process.argv.slice(2);
  if (patterns.length === 0) {
    process.stderr.write("usage: node scripts/validate-scenario.mjs <scenario.json | glob ...>\n");
    process.exit(2);
  }

  const targets = expandGlobs(patterns);
  if (targets.length === 0) {
    process.stderr.write(`No scenario manifests matched: ${patterns.join(", ")}\n`);
    process.exit(1);
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(readJson(resolve(REPO_ROOT, "schema/scenario.schema.json")));

  let failures = 0;

  for (const target of targets) {
    let scenario;
    try {
      scenario = readJson(target);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAIL  ${target}\n      ${error.message}\n`);
      continue;
    }

    if (!validate(scenario)) {
      failures += 1;
      const detail = validate.errors
        .map((error) => `      schema ${error.instancePath || "/"} ${error.message}`)
        .join("\n");
      process.stderr.write(`FAIL  ${target}\n${detail}\n`);
      continue;
    }

    const violations = POLICIES.map((policy) => {
      const error = policy.check(scenario);
      return error ? `      policy ${policy.id}: ${error}` : null;
    }).filter(Boolean);

    if (violations.length) {
      failures += 1;
      process.stderr.write(`FAIL  ${target}\n${violations.join("\n")}\n`);
      continue;
    }

    const ingress = scenario.safety.publicIngress ? "public ingress" : "no public ingress";
    const vulnerable = scenario.safety.intentionallyVulnerable ? "intentionally vulnerable" : "hardened";
    process.stdout.write(
      `ok    ${scenario.id} v${scenario.version}  ` +
        `${vulnerable}, ${ingress}, ttl ${scenario.safety.defaultTtlHours}h, ` +
        `~${scenario.cost.estimatedPerHour} ${scenario.cost.currency}/hr\n`,
    );
  }

  if (failures > 0) {
    process.stderr.write(`\n${failures} scenario(s) failed validation.\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll scenarios passed schema and policy validation.\n");
}

main();
