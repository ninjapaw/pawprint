import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "scripts", "vendor-sync.mjs");
const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", shell: false });

test("DNS-only snapshots verify offline without changing existing core-kit pins", () => {
  const target = mkdtempSync(join(tmpdir(), "pawprint-dns-snapshot-"));
  try {
    const synced = run(source, [
      "--target", target, "--prefix", "vendor/pawprint-dns", "--snapshot",
      "--add", "LICENSE", "--add", "scripts/cloudflare-dns.mjs", "--add", "scripts/vendor-sync.mjs",
    ], root);
    assert.equal(synced.status, 0, synced.stderr);
    const checker = join(target, "vendor", "pawprint-dns", "scripts", "vendor-sync.mjs");
    const manifestPath = join(target, "vendor", "pawprint-dns.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.match(manifest.sourceRevision, /^working-tree@[a-f0-9]{40}$/);
    assert.equal(manifest.files.length, 3);
    const checked = run(checker, ["--verify-snapshot", manifestPath], target);
    assert.equal(checked.status, 0, checked.stderr);
    writeFileSync(join(target, "vendor", "pawprint-dns", "scripts", "cloudflare-dns.mjs"), "changed source\n");
    const drifted = run(checker, ["--verify-snapshot", manifestPath], target);
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /snapshot drift/);
    manifest.files[0].path = "../outside";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const escaped = run(checker, ["--verify-snapshot", manifestPath], target);
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /Invalid or duplicate path/);
    const badPrefix = run(source, ["--target", target, "--prefix", "../outside", "--snapshot"], root);
    assert.notEqual(badPrefix.status, 0);
    assert.match(badPrefix.stderr, /--prefix must be/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("syncing the existing Static Web Apps connector automatically includes its new shared dependency", () => {
  const target = mkdtempSync(join(tmpdir(), "pawprint-dns-dependency-"));
  try {
    const result = run(source, [
      "--target", target, "--prefix", "vendor/pawprint-dns", "--snapshot",
      "--add", "LICENSE", "--add", "scripts/connect-cloudflare-dns.sh", "--add", "scripts/vendor-sync.mjs",
    ], root);
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = join(target, "vendor", "pawprint-dns.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(manifest.files.some((entry) => entry.path === "scripts/cloudflare-dns.mjs"));
    const checked = run(join(target, "vendor", "pawprint-dns", "scripts", "vendor-sync.mjs"),
      ["--verify-snapshot", manifestPath], target);
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
