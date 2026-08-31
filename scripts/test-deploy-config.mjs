/**
 * Tests for the shared deployment config resolver.
 *
 * This resolver is vendored into every consuming repository, so a regression
 * here breaks them all at once and none of them can catch it. It is the one
 * script in this repository whose blast radius is other repositories.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVER = join(REPO_ROOT, "scripts", "deploy-config.mjs");
const WORK_DIR = mkdtempSync(join(tmpdir(), "pawprint-deploy-config-"));

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [RESOLVER, ...args], {
    encoding: "utf8",
    env: { ...process.env, AZURE_SUBSCRIPTION_ID: "", ...env },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeConfig(name, contents) {
  const path = join(WORK_DIR, name);
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

function baseConfig(overrides = {}) {
  return {
    configVersion: "1.0.0",
    defaults: {
      location: "centralus",
      siteBase: "/",
      resolver: {
        required: ["staticWebAppName", "publicSiteUrl"],
        env: {
          AZURE_STATIC_WEB_APP_NAME: "staticWebAppName",
          PUBLIC_SITE_BASE: "siteBase",
        },
      },
      ...overrides.defaults,
    },
    environments: {
      dev: {
        branch: "dev",
        githubEnvironment: "dev",
        location: "centralus",
        resourceGroup: "NP-Example-Dev-CentralUS",
        staticWebAppName: "np-example-dev-centralus",
        customDomain: "dev.example.com",
        publicSiteUrl: "https://dev.example.com",
        ...overrides.dev,
      },
      prod: {
        branch: "main",
        githubEnvironment: "prod",
        location: "centralus",
        resourceGroup: "NP-Example-CentralUS",
        staticWebAppName: "np-example-centralus",
        customDomain: "example.com",
        publicSiteUrl: "https://example.com",
        ...overrides.prod,
      },
    },
  };
}

const rejects = [
  {
    name: "rejects a subscription id committed to config",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "sub.json",
        baseConfig({
          dev: { subscriptionId: "16037566-d4df-4c7c-b484-346d8472b4c4" },
        }),
      ),
    ],
    expect: /must stay empty/i,
  },
  {
    name: "rejects a secret-shaped value in committed config",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "secret.json",
        baseConfig({
          defaults: { clientSecret: "oops" },
        }),
      ),
    ],
    expect: /looks like a secret/i,
  },
  {
    name: "rejects a branch that does not own the environment",
    args: () => [
      "--environment",
      "prod",
      "--config",
      writeConfig(
        "branch.json",
        baseConfig({
          prod: { branch: "dev" },
        }),
      ),
    ],
    expect: /promotion model binds it to 'main'/i,
  },
  {
    name: "rejects a public site url that contradicts the custom domain",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "url.json",
        baseConfig({
          dev: { publicSiteUrl: "https://wrong.example.com" },
        }),
      ),
    ],
    expect: /must be https:\/\/dev\.example\.com/i,
  },
  {
    name: "rejects an unsupported config version",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig("version.json", {
        ...baseConfig(),
        configVersion: "2.0.0",
      }),
    ],
    expect: /Unsupported deployment config version/i,
  },
  {
    name: "rejects a missing repository-declared required setting",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "required.json",
        baseConfig({
          dev: { staticWebAppName: "" },
        }),
      ),
    ],
    expect: /staticWebAppName must be a non-empty string/i,
  },
  {
    name: "rejects an invalid resource group name",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "rg.json",
        baseConfig({
          dev: { resourceGroup: "has spaces and $ymbols" },
        }),
      ),
    ],
    expect: /not a valid resource group name/i,
  },
  {
    name: "rejects an unknown environment",
    args: () => [
      "--environment",
      "staging",
      "--config",
      writeConfig("env.json", baseConfig()),
    ],
    expect: /is not defined/i,
  },
  {
    name: "requires an environment or branch selector",
    args: () => ["--config", writeConfig("select.json", baseConfig())],
    expect: /Specify --environment/i,
  },
  {
    name: "requires a subscription when the deployment asks for one",
    args: () => [
      "--environment",
      "dev",
      "--require-subscription",
      "--config",
      writeConfig("reqsub.json", baseConfig()),
    ],
    expect: /Set AZURE_SUBSCRIPTION_ID/i,
  },
  {
    name: "rejects a malformed subscription id from the environment",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig("badsub.json", baseConfig()),
    ],
    env: { AZURE_SUBSCRIPTION_ID: "not-a-uuid" },
    expect: /not a UUID/i,
  },
  {
    name: "rejects an unknown secrets mode",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "mode.json",
        baseConfig({
          dev: { secrets: { mode: "shared" } },
        }),
      ),
    ],
    expect: /must be none, platform or workload/i,
  },
  {
    name: "rejects workload secrets without a vault name",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "vault.json",
        baseConfig({
          dev: { secrets: { mode: "workload" } },
        }),
      ),
    ],
    expect: /vaultName is required/i,
  },
  {
    name: "rejects platform secrets that name no secrets, which would mean a vault-wide grant",
    args: () => [
      "--environment",
      "dev",
      "--config",
      writeConfig(
        "platform.json",
        baseConfig({
          dev: {
            secrets: {
              mode: "platform",
              platformVaultName: "np-platform-dev-kv",
              secretNames: [],
            },
          },
        }),
      ),
    ],
    expect: /must name at least one secret/i,
  },
];

let failures = 0;

for (const testCase of rejects) {
  const { code, stdout, stderr } = run(testCase.args(), testCase.env ?? {});
  const output = `${stdout}${stderr}`;

  if (code === 0) {
    failures += 1;
    process.stderr.write(
      `FAIL  ${testCase.name}\n      expected a non-zero exit, got 0\n`,
    );
    continue;
  }
  if (!testCase.expect.test(output)) {
    failures += 1;
    process.stderr.write(
      `FAIL  ${testCase.name}\n      exit ${code} but message did not match ${testCase.expect}\n` +
        `      got: ${output.trim()}\n`,
    );
    continue;
  }
  process.stdout.write(`ok    ${testCase.name}\n`);
}

function accepts(name, args, env, assertion) {
  const result = run(args, env);
  if (result.code !== 0) {
    failures += 1;
    process.stderr.write(
      `FAIL  ${name}\n      exit ${result.code}: ${result.stderr.trim()}\n`,
    );
    return;
  }
  const problem = assertion ? assertion(result.stdout) : null;
  if (problem) {
    failures += 1;
    process.stderr.write(
      `FAIL  ${name}\n      ${problem}\n      got: ${result.stdout.trim()}\n`,
    );
    return;
  }
  process.stdout.write(`ok    ${name}\n`);
}

// Positive controls. A resolver that rejects everything must not pass this suite.
const healthy = writeConfig("healthy.json", baseConfig());

accepts(
  "emits the base and repository-declared environment variables",
  ["--environment", "dev", "--config", healthy],
  {},
  (stdout) => {
    const lines = stdout.trim().split("\n");
    const expected = [
      "DEPLOY_ENVIRONMENT=dev",
      "AZURE_LOCATION=centralus",
      "AZURE_RESOURCE_GROUP=NP-Example-Dev-CentralUS",
      "AZURE_STATIC_WEB_APP_NAME=np-example-dev-centralus",
      "PUBLIC_SITE_BASE=/",
    ];
    const missing = expected.filter((line) => !lines.includes(line));
    return missing.length ? `missing ${missing.join(", ")}` : null;
  },
);

accepts(
  "resolves prod from the main branch",
  ["--branch", "main", "--config", healthy],
  {},
  (stdout) =>
    stdout.includes("DEPLOY_ENVIRONMENT=prod")
      ? null
      : "expected DEPLOY_ENVIRONMENT=prod",
);

accepts(
  "takes the subscription id from the environment, not from config",
  ["--environment", "dev", "--require-subscription", "--config", healthy],
  { AZURE_SUBSCRIPTION_ID: "16037566-d4df-4c7c-b484-346d8472b4c4" },
  (stdout) =>
    stdout.includes(
      "AZURE_SUBSCRIPTION_ID=16037566-d4df-4c7c-b484-346d8472b4c4",
    )
      ? null
      : "expected the runtime subscription id to be emitted",
);

// Keys that name, count or toggle a secret are metadata, not secrets. Refusing
// them would make the guardrail unusable for any repository that has a vault.
accepts("accepts secret metadata keys that hold no secret", [
  "--environment",
  "dev",
  "--config",
  writeConfig(
    "metadata.json",
    baseConfig({
      defaults: {
        aiApiKeySecretName: "ai-api-key",
        secretExpirationDays: 365,
        secretWarningDays: 30,
      },
      dev: {
        secrets: { mode: "workload", vaultName: "np-example-dev-kv" },
      },
    }),
  ),
]);

accepts("accepts a platform secrets tier that names its secrets", [
  "--environment",
  "dev",
  "--config",
  writeConfig(
    "platform-ok.json",
    baseConfig({
      dev: {
        secrets: {
          mode: "platform",
          platformVaultName: "np-platform-dev-kv",
          secretNames: ["ai-api-key"],
        },
      },
    }),
  ),
]);

// Deployment targets whose public URL is not knowable from configuration, such
// as GitHub Pages, supply it at runtime instead.
accepts(
  "lets the environment override a variable declared overridable",
  [
    "--environment",
    "dev",
    "--config",
    writeConfig(
      "overridable.json",
      baseConfig({
        defaults: {
          resolver: {
            required: ["staticWebAppName", "publicSiteUrl"],
            envOverridable: ["PUBLIC_SITE_URL", "PUBLIC_SITE_BASE"],
            env: {
              PUBLIC_SITE_URL: "publicSiteUrl",
              PUBLIC_SITE_BASE: "siteBase",
            },
          },
        },
      }),
    ),
  ],
  {
    PUBLIC_SITE_URL: "https://example.github.io/thing",
    PUBLIC_SITE_BASE: "/thing/",
  },
  (stdout) => {
    const wanted = [
      "PUBLIC_SITE_URL=https://example.github.io/thing",
      "PUBLIC_SITE_BASE=/thing/",
    ];
    const missing = wanted.filter((line) => !stdout.includes(line));
    return missing.length ? `missing ${missing.join(", ")}` : null;
  },
);

// A blank variable is not an override; configuration still wins.
accepts(
  "ignores a blank override and keeps the configured value",
  [
    "--environment",
    "dev",
    "--config",
    writeConfig(
      "overridable-blank.json",
      baseConfig({
        defaults: {
          resolver: {
            required: ["staticWebAppName", "publicSiteUrl"],
            envOverridable: ["PUBLIC_SITE_URL"],
            env: { PUBLIC_SITE_URL: "publicSiteUrl" },
          },
        },
      }),
    ),
  ],
  { PUBLIC_SITE_URL: "   " },
  (stdout) =>
    stdout.includes("PUBLIC_SITE_URL=https://dev.example.com")
      ? null
      : "expected the configured publicSiteUrl to win",
);

// Anything not declared overridable must ignore the environment, otherwise
// every emitted name becomes an accidental injection point.
accepts(
  "ignores the environment for a variable not declared overridable",
  [
    "--environment",
    "dev",
    "--config",
    writeConfig("not-overridable.json", baseConfig()),
  ],
  { AZURE_STATIC_WEB_APP_NAME: "hijacked" },
  (stdout) =>
    stdout.includes("AZURE_STATIC_WEB_APP_NAME=np-example-dev-centralus")
      ? null
      : "expected the configured staticWebAppName to win",
);

if (failures > 0) {
  process.stderr.write(`\n${failures} deploy config test(s) failed.\n`);
  process.exit(1);
}

process.stdout.write("\nAll deploy config tests passed.\n");
