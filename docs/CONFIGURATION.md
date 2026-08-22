# Configuration

Pawprint resolves configuration through five layers. Later layers win.

```
builtin  <  deploy.defaults.json  <  deploy.config.json  <  environment variable  <  CLI flag
```

## Where each kind of value belongs

| Kind | Home | Committed | Example |
|---|---|---|---|
| Resource names, region, SKUs, TTL | `config/deploy.config.json` | Yes | `location`, `resourceGroup` |
| Scenario behaviour | `scenarios/<id>/scenario.json` | Yes | `nginxVersion`, `defenderEnabled` |
| Pipeline identity | GitHub Environment **variable** | No | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |
| Runtime application secrets | Azure Key Vault | No | API keys the deployed app needs |
| GitHub Environment **secrets** | Ideally empty | No | — |

Because Pawprint authenticates with OIDC federated credentials, **adopting it
requires no long-lived client secret.** If you find yourself adding one, something
is wrong.

Tenant and subscription IDs are identifiers rather than secrets, but they are
still kept out of source control so a fork never carries someone else's
subscription. `deploy.config.schema.json` enforces this: `subscriptionId` must be
the empty string in any committed file.

## The two-file split

Adopters edit **only** `config/deploy.config.json`.

- `config/deploy.defaults.json` is upstream-owned. Never edit it in a fork; it
  merges cleanly on every `git pull`.
- `config/deploy.config.json` is yours. Upstream never touches it.

Keeping the files separate is what lets a fork track upstream indefinitely
without merge conflicts. Start from `config/deploy.config.example.json`.

`config/deploy.config.json` is git-ignored **in this repository**, so the
maintainers' own tenant and resource names never land upstream. In your fork it
is normally the opposite: commit it, because it is your environment definition and
it contains no secrets. Un-ignore it in your fork's `.gitignore`.

## Guardrails

The resolver rejects, with a non-zero exit and an actionable message:

- secret-shaped keys in any committed config, in any casing
- a populated `subscriptionId`
- a `configVersion` whose major version differs from the schema
- a branch that does not own the environment it was asked to deploy
- an unknown environment

Each of these has a test in `scripts/test-guardrails.mjs`. A guardrail that never
fires is worse than no guardrail, so they are tested as negative cases with a
positive control.

## Change impact

Declare the impact of every scenario parameter so reviewers see the cost of a
change in the pull request rather than discovering it during deployment.

| Impact | Meaning |
|---|---|
| `hot` | App setting plus restart |
| `warm` | Infrastructure redeploy, no re-bootstrap |
| `cold` | Creates new resources; the old ones orphan unless torn down |
| `rebootstrap` | The OIDC federated credential subject changes and must be recreated |

## Critical parameters do not get fallbacks

A parameter marked `critical` must declare a default in the scenario manifest or
set `required: true`. It must never fall back silently at runtime.

The reason is specific. A pattern like:

```yaml
NGINX_VERSION: ${{ vars.NGINX_VERSION || '1.30.3' }}
```

silently masks a typo. Misspell the variable and the run deploys `1.30.3` anyway,
succeeds, and emits a pawprint asserting that version was intentional. For a
platform whose value is attestable evidence, that is a correctness bug in the
evidence chain, not a convenience.

Cosmetic values may have fallbacks. Anything that appears in an assertion may not.

## Config is bound to the evidence

Every pawprint records `config.hash`, a SHA-256 of the canonicalised resolved
configuration. That makes the link between configuration and evidence
tamper-evident:

- A pawprint proves which exact configuration produced it.
- Two runs with the same `config.hash` but different results indicate
  non-determinism, which is a real signal worth investigating.
- The viewer can diff resolved configs between any two runs.

The hash covers the **resolved** config after all five layers collapse, not the
source files, because that is what actually ran.

## Commands

```bash
npm run config:check                                   # validate dev and prod
node scripts/pawprint-config.mjs --environment dev     # print resolved variables
node scripts/pawprint-config.mjs --environment dev --json
node scripts/pawprint-config.mjs --branch dev --github-env
```
