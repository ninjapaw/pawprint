import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configurePortalAuth, validatePortalAuth } from "./lib/portal-auth.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const settings = validatePortalAuth(read("config/portal-auth.json"));
if (!process.argv.includes("--check")) {
  writeFileSync(join(root, "dist", "staticwebapp.config.json"),
    `${JSON.stringify(configurePortalAuth(read("public/staticwebapp.config.json"), settings), null, 2)}\n`);
}
console.log(`Portal authentication: ${settings.mode}. Build configuration only; no tenant or live site has been changed.`);
