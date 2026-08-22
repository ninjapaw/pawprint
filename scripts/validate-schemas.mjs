/**
 * Compiles every schema and validates the sample fixtures against them.
 *
 * Compiling catches invalid schemas early, which matters because JSON Schema
 * uses ECMA-262 regex and silently tolerates constructs that never match.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

// The schemas target draft 2020-12; ajv's default export only implements draft-07.
const Ajv2020 = _Ajv2020.default ?? _Ajv2020;
const addFormats = _addFormats.default ?? _addFormats;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(REPO_ROOT, "schema");
const SAMPLE_DIR = join(REPO_ROOT, "samples");

/** Sample file suffix -> schema that must validate it. */
const SAMPLE_BINDINGS = [
  { suffix: ".pawprint.json", schema: "pawprint.schema.json" },
  { suffix: ".scenario.json", schema: "scenario.schema.json" },
  { suffix: ".config.json", schema: "deploy.config.schema.json" },
];

/** Shipped configuration that must validate against its schema on every run. */
const SHIPPED_CONFIG = [
  { file: "config/connectors.catalog.json", schema: "connectors.schema.json" },
  { file: "config/deploy.defaults.json", schema: "deploy.config.schema.json" },
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const compiled = new Map();
  let failures = 0;

  for (const file of readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(".json"))) {
    try {
      compiled.set(file, ajv.compile(readJson(join(SCHEMA_DIR, file))));
      process.stdout.write(`ok    schema  ${file}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAIL  schema  ${file}\n      ${error.message}\n`);
    }
  }

  let samples = [];
  try {
    samples = readdirSync(SAMPLE_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    process.stdout.write("note  no samples/ directory; skipping fixture validation\n");
  }

  for (const { file, schema } of SHIPPED_CONFIG) {
    const validate = compiled.get(schema);
    if (!validate) {
      failures += 1;
      process.stderr.write(`FAIL  config  ${file}\n      Schema ${schema} did not compile.\n`);
      continue;
    }
    if (validate(readJson(join(REPO_ROOT, file)))) {
      process.stdout.write(`ok    config  ${file}\n`);
    } else {
      failures += 1;
      const detail = validate.errors
        .map((error) => `      ${error.instancePath || "/"} ${error.message}`)
        .join("\n");
      process.stderr.write(`FAIL  config  ${file}  against ${schema}\n${detail}\n`);
    }
  }

  for (const file of samples) {
    const binding = SAMPLE_BINDINGS.find((candidate) => file.endsWith(candidate.suffix));
    if (!binding) {
      failures += 1;
      process.stderr.write(
        `FAIL  sample  ${file}\n      No schema binding. Expected one of: ` +
          `${SAMPLE_BINDINGS.map((b) => b.suffix).join(", ")}\n`,
      );
      continue;
    }

    const validate = compiled.get(binding.schema);
    if (!validate) {
      failures += 1;
      process.stderr.write(`FAIL  sample  ${file}\n      Schema ${binding.schema} did not compile.\n`);
      continue;
    }

    if (validate(readJson(join(SAMPLE_DIR, file)))) {
      process.stdout.write(`ok    sample  ${file}\n`);
    } else {
      failures += 1;
      const detail = validate.errors
        .map((error) => `      ${error.instancePath || "/"} ${error.message}`)
        .join("\n");
      process.stderr.write(`FAIL  sample  ${file}  against ${binding.schema}\n${detail}\n`);
    }
  }

  if (failures > 0) {
    process.stderr.write(`\n${failures} schema check(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll schema checks passed.\n");
}

main();
