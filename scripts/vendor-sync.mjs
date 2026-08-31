/**
 * Copies shared files into a consuming repository's vendor/pawprint/ tree, or
 * verifies the copies still match.
 *
 * Bicep has no module registry available here, so sharing means copying, and a
 * copy nobody re-syncs quietly becomes a fork. The CI gate in
 * kit-bicep-validate.yml catches that after the fact; this is how it gets fixed
 * without hand-copying files and hoping.
 *
 * Line endings are normalised before comparing, because the consumer and the
 * kit are separate checkouts and a CRLF difference is not a fork.
 *
 *   node scripts/vendor-sync.mjs --target ../site
 *   node scripts/vendor-sync.mjs --target ../site --check
 *   node scripts/vendor-sync.mjs --target ../site --add modules/naming/main.bicep
 *   node scripts/vendor-sync.mjs --target ../site ../m365profiles --check
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO_ROOT, "config", "vendor.manifest.json");
const VENDOR_PREFIX = join("vendor", "pawprint");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string", multiple: true, default: [] },
    add: { type: "string", multiple: true, default: [] },
    check: { type: "boolean", default: false },
    "verify-sources": { type: "boolean", default: false },
  },
});

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const known = new Set(manifest.files.map((entry) => entry.path));

// Runs in this repository's own CI: a shared file renamed without updating the
// manifest would silently stop being vendored anywhere.
if (values["verify-sources"]) {
  let absent = 0;
  for (const entry of manifest.files) {
    if (existsSync(join(REPO_ROOT, entry.path))) {
      process.stdout.write(`ok    ${entry.path}\n`);
    } else {
      process.stderr.write(
        `FAIL  ${entry.path} is in the manifest but missing from this repository.\n`,
      );
      absent += 1;
    }
  }
  if (absent > 0) {
    process.stderr.write(`\n${absent} manifest entr(y/ies) missing.\n`);
    process.exit(1);
  }
  process.stdout.write("\nEvery vendorable file exists.\n");
  process.exit(0);
}

const targets = [...values.target, ...positionals];
if (targets.length === 0) {
  process.stderr.write(
    "Specify at least one --target <path to consuming repository>, or --verify-sources.\n",
  );
  process.exit(1);
}

for (const requested of values.add) {
  if (!known.has(requested.split("\\").join("/"))) {
    process.stderr.write(
      `'${requested}' is not in config/vendor.manifest.json. Add it there first so the drift gate knows about it.\n`,
    );
    process.exit(1);
  }
}

const normalise = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

let drifted = 0;
let copied = 0;
let missingSources = 0;

for (const target of targets) {
  const targetRoot = resolve(target);
  if (!existsSync(targetRoot)) {
    process.stderr.write(`FAIL  target '${targetRoot}' does not exist.\n`);
    process.exit(1);
  }

  process.stdout.write(`\n${targetRoot}\n`);

  for (const entry of manifest.files) {
    const source = join(REPO_ROOT, entry.path);
    const destination = join(targetRoot, VENDOR_PREFIX, entry.path);

    if (!existsSync(source)) {
      process.stderr.write(
        `  FAIL  ${entry.path} is in the manifest but missing from this repository.\n`,
      );
      missingSources += 1;
      continue;
    }

    const requested = values.add.some(
      (candidate) => candidate.split("\\").join("/") === entry.path,
    );
    if (!existsSync(destination) && !requested) {
      process.stdout.write(`  skip  ${entry.path} (not vendored here)\n`);
      continue;
    }

    if (
      existsSync(destination) &&
      normalise(source) === normalise(destination)
    ) {
      process.stdout.write(`  ok    ${entry.path}\n`);
      continue;
    }

    if (values.check) {
      process.stderr.write(`  DRIFT ${entry.path}\n`);
      drifted += 1;
      continue;
    }

    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied += 1;
    process.stdout.write(
      `  sync  ${relative(targetRoot, destination).split("\\").join("/")}\n`,
    );
  }
}

if (missingSources > 0) {
  process.stderr.write(
    `\n${missingSources} manifest entr(y/ies) missing from this repository.\n`,
  );
  process.exit(1);
}

if (values.check) {
  if (drifted > 0) {
    process.stderr.write(
      `\n${drifted} vendored file(s) drifted. Re-run without --check to re-vendor.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("\nAll vendored files are in sync.\n");
} else {
  process.stdout.write(`\n${copied} file(s) re-vendored.\n`);
}
