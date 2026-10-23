import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateDomain } from "../cloudflare-dns.mjs";

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/easm.config.schema.json", import.meta.url), "utf8")));
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const ROLE_IDS = {
  Reader: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
  Contributor: "b24988ac-6180-42a0-ab88-20f7382dd24c",
};

function unique(values, message) {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function normalizeBlock(value) {
  const [address, prefixText, extra] = value.split("/");
  const version = isIP(address);
  const width = version === 4 ? 32 : 128;
  if (!version || address.includes("%") || extra !== undefined || !/^\d{1,3}$/.test(prefixText ?? "")
      || Number(prefixText) > width) throw new Error("Discovery exclusions require a valid IPv4/IPv6 CIDR.");
  const prefix = Number(prefixText);
  let packed;
  if (version === 4) packed = address.split(".").reduce((total, octet) => (total << 8n) | BigInt(octet), 0n);
  else {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const halves = canonical.split("::").map((half) => half ? half.split(":") : []);
    const parts = halves.length === 1 ? halves[0]
      : [...halves[0], ...Array(8 - halves[0].length - halves[1].length).fill("0"), ...halves[1]];
    packed = parts.reduce((total, part) => (total << 16n) | BigInt(`0x${part}`), 0n);
  }
  const shift = BigInt(width - prefix);
  const network = (packed >> shift) << shift;
  const normalized = version === 4
    ? [24, 16, 8, 0].map((bits) => Number((network >> BigInt(bits)) & 255n)).join(".")
    : new URL(`http://[${Array.from({ length: 8 }, (_, index) => ((network >> BigInt((7 - index) * 16)) & 65535n).toString(16)).join(":")}]/`).hostname.slice(1, -1);
  return `${normalized}/${prefix}`;
}

export function normalizeSources(sources) {
  if (!Array.isArray(sources)) throw new Error("Invalid EASM discovery source collection.");
  const result = sources.map((source) => {
    if (!source || !["domain", "host", "ipBlock"].includes(source.kind) || typeof source.name !== "string") {
      throw new Error("Unexpected EASM discovery source type or name.");
    }
    return { kind: source.kind, name: source.kind === "ipBlock" ? normalizeBlock(source.name) : validateDomain(source.name) };
  }).sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
  unique(result.map((source) => `${source.kind}:${source.name}`), "Duplicate discovery sources are not allowed.");
  return result;
}

export function validateEasmConfig(value) {
  if (!validate(value)) throw new Error(`Invalid EASM configuration: ${ajv.errorsText(validate.errors)}. Values were omitted.`);
  const config = structuredClone(value);
  config.authorizedDomains = config.authorizedDomains.map((domain) => validateDomain(domain)).sort();
  unique(config.authorizedDomains, "Duplicate authorized domains are not allowed.");
  config.accessBindings = config.accessBindings.map((binding) => ({ ...binding, principalId: binding.principalId.toLowerCase() }));
  unique(config.accessBindings.map((binding) => `${binding.principalId}:${binding.role}`), "Duplicate EASM access bindings are not allowed.");
  unique(config.discoveryGroups.map((group) => group.name), "Duplicate discovery group names are not allowed.");
  if (config.budget) {
    unique(config.budget.contactEmails.map((email) => email.toLowerCase()), "Duplicate budget contacts are not allowed.");
    if (!Number.isSafeInteger(config.budget.monthlyAmount)) throw new Error("Budget amount must use safe whole billing-currency units.");
  }
  config.discoveryGroups = config.discoveryGroups.map((group) => {
    const seeds = normalizeSources(group.seeds);
    const excludes = normalizeSources(group.excludes);
    if (!config.authorizedDomains.length || seeds.some((seed) => !config.authorizedDomains.some((domain) =>
      seed.name === domain || seed.name.endsWith(`.${domain}`)))) {
      throw new Error("Every discovery seed must be inside an explicitly authorized domain. Recursion can still discover external relationships.");
    }
    return { ...group, description: group.description ?? "", seeds, excludes };
  });
  return config;
}

export function readEasmConfig(path, environment = process.env) {
  let text;
  try {
    text = path ? readFileSync(path, "utf8")
      : environment.EASM_CONFIG_JSON !== undefined ? environment.EASM_CONFIG_JSON
        : readFileSync(new URL("../../config/easm.config.json", import.meta.url), "utf8");
  } catch {
    throw new Error("Supply --config, EASM_CONFIG_JSON, or a local config/easm.config.json copied from the example.");
  }
  if (typeof text !== "string" || !text.trim()) throw new Error("EASM_CONFIG_JSON/configuration must be nonempty; no example or implicit target is substituted.");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid EASM JSON; contents omitted to protect accidental secrets."); }
  return validateEasmConfig(value);
}

export function deploymentBlockers(config) {
  return [
    ...(!config.enabled ? ["Set enabled=true only after approving this shared deployment."] : []),
    ...(!config.budget ? ["Supply a monthly budget amount, notification contacts, and a stable first-of-month start date."] : []),
  ];
}

export function configurationDigest(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function offlineEasmPlan(config) {
  return {
    configurationSha256: configurationDigest(config),
    environment: config.environment,
    workspaceName: config.workspaceName,
    location: config.location,
    enabled: config.enabled,
    protectFromDeletion: config.protectFromDeletion,
    workspaceScopedAccess: config.accessBindings.map((binding) => ({ role: binding.role, principalType: binding.principalType })),
    monthlyBudgetConfigured: config.budget !== null,
    budgetContactCount: config.budget?.contactEmails.length ?? 0,
    authorizedDomainCount: config.authorizedDomains.length,
    discoveryGroups: config.discoveryGroups.map((group) => ({
      name: `pawprint-${config.key}-${group.name}`, tier: group.tier, frequencyDays: group.frequencyDays,
      seedCount: group.seeds.length, exclusionCount: group.excludes.length,
    })),
    blockers: deploymentBlockers(config),
    note: "Offline intent only; no Azure calls, writes, scans, asset approvals, or live coverage assertions. Budget alerts are not spending stops.",
  };
}

export function discoveryMarker(config) {
  return `pawprint:easm:${config.key}:${config.environment}`;
}

export function desiredDiscoveryGroups(config) {
  return config.discoveryGroups.map((group) => ({
    name: `pawprint-${config.key}-${group.name}`,
    description: `${discoveryMarker(config)}${group.description ? `\n${group.description}` : ""}`,
    tier: group.tier,
    frequencyMilliseconds: group.frequencyDays * 86_400_000,
    seeds: group.seeds,
    excludes: group.excludes,
  }));
}
