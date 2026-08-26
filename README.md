# Pawprint

**Deploy it. Prove it. Leave a pawprint.**

> **Independent community project.** This repository is not a Microsoft product,
> assessment, endorsement, or official deployment guidance. Some contributors may
> be Microsoft employees acting in an individual or community capacity. Use at
> your own risk and validate all deployments, evidence, and recommendations
> before using them in any environment. See [DISCLAIMER.md](DISCLAIMER.md).

Pawprint is an open platform for reproducible cloud scenarios on Azure. It deploys
a known state, proves your tooling detected it, remediates, and proves the
detection cleared — emitting a portable evidence artifact for every run.

That artifact is a **pawprint**: a signed, diffable, shareable record of what was
deployed, what was asserted, and what was observed.

```text
provision → arm → detect → remediate → verify → destroy
     └──────────── every stage recorded in the pawprint ────────────┘
```

## Why

Deploying infrastructure is a solved problem. *Proving* that a control fired — and
being able to hand someone the evidence — is not. Pawprint treats the evidence as
the primary artifact and the deployment as the means of producing it.

## What is in the box

| Component | Purpose |
|---|---|
| `schema/` | The pawprint, scenario, and deployment-config contracts |
| `.github/workflows/kit-*.yml` | Reusable workflows, pinned by consumers at an immutable ref (release tag or commit SHA) |
| `platform/` | Subscription-scope baseline: run resource group, tag schema, TTL stamp |
| `modules/` | Shared Bicep modules |
| `scripts/` | Config resolver, scenario validator, policy and guardrail tests |
| `samples/` | Reference pawprint and scenario fixtures |

## Quick start

```bash
npm ci
npm test
npm run doctor         # read-only preflight: tooling, sign-in, config, CI trust
npm run setup          # detect your tenant, register the admin app, federate CI
```

```bash
# Resolve configuration for an environment
node scripts/pawprint-config.mjs --environment dev

# Validate scenario manifests against schema and safety policy
node scripts/validate-scenario.mjs "scenarios/**/scenario.json"
```

## Identity

Three planes, deliberately different postures:

| Plane | Exposure | Authentication |
|---|---|---|
| Pawprint viewer | Public or static | None. It stores nothing. |
| Setup and admin console | Loopback only | Entra, or a generated local credential |
| Hosted team console | Internal | Entra with app roles |

**Use your existing workforce Entra tenant.** Do not create an External ID tenant
for an admin console: External ID gives you 7-day log retention, no Identity
Protection, no PIM, sharply reduced Conditional Access, and MAU billing for every
admin. Invite external collaborators as B2B guests instead. Full comparison in
[docs/IDENTITY.md](docs/IDENTITY.md).

Running without Entra is supported. You keep every deployment, scenario and
evidence capability, and lose SSO, MFA, Conditional Access, PIM, group-based
roles, centralised revocation, and per-user attribution in the pawprint. A shared
local credential turns "who ran this" into "someone with the credential", which
weakens every pawprint that machine emits.

## Evidence storage

Pawprints are JSON — portable, diffable, schema-validated, readable with no
server. Where they are kept is configurable:

| Sink | Durability | Use |
|---|---|---|
| `file` | Machine-local | Always on; works air-gapped |
| `githubArtifact` | Repository retention window | Convenient in CI; not a system of record |
| `azureBlob` | Durable, optionally immutable | Recommended system of record |

For anything you intend to rely on, use `azureBlob` with `immutable: true`. A
time-based retention policy means a written pawprint cannot be altered or deleted
before it expires, which is the difference between a log and evidence.

## Reversibility

Adopting Pawprint is a decision you can walk back. In Entra it creates exactly
one application and its service principal, both tagged and recorded. It never
modifies tenant-wide settings, never creates Conditional Access policies, never
creates groups, and never requests admin consent — every scope it asks for is
user-consentable.

```bash
npm run uninstall                       # what-if. Shows everything, changes nothing.
npm run uninstall -- --apply            # remove recorded objects
npm run uninstall -- --apply --purge    # also empty the 30-day recycle bin
```

Azure resources are one group per run, tagged with an expiry, removable whole by
the reaper workflow. The exceptions that genuinely cannot be reversed are listed
in [docs/REVERSIBILITY.md](docs/REVERSIBILITY.md).

## Connectors

Three optional environments, each with permission tiers, each unlocking specific
capabilities. Nothing is requested until a capability you enabled needs it.

```bash
npm run connect                                              # detect what is present
node scripts/pawprint-connect.mjs --plan microsoft365=read,azure=write
```

`--plan` models the consent cost and resulting capabilities **without requesting
anything** — use it to have the permissions conversation before touching the tenant.

Two rules hold throughout: no single app registration collects the union of every
permission, and **delegated permissions are preferred over application ones**, so
the connector can never exceed what the signed-in user can already do. Azure
deployment is restricted to an allowlist of approved subscriptions that fails
closed. Details in [docs/CONNECTORS.md](docs/CONNECTORS.md).

## Documentation

- [Adoption](docs/ADOPTION.md) — consuming Pawprint from another repository
- [Infrastructure as code](docs/IAC.md) — why Bicep, why no state file, linting and what-if
- [Connectors](docs/CONNECTORS.md) — environments, permission tiers, capability matrix
- [Identity](docs/IDENTITY.md) — tenants, auth modes, GitHub, and the tradeoffs
- [Reversibility](docs/REVERSIBILITY.md) — what is touched, what undoes, what does not
- [Configuration](docs/CONFIGURATION.md) — the five-layer model and its guardrails
- [Scenario contract](docs/SCENARIO-CONTRACT.md) — authoring a scenario
- [Contributing](CONTRIBUTING.md)

## Design rules

1. **Evidence over output.** Every run emits a pawprint conforming to a versioned schema.
2. **Assert from reality.** Detection is computed from the running system, never from the variable that requested it.
3. **Config is code.** Anything shared lives in a schema-validated file, not a settings page.
4. **No long-lived credentials.** OIDC federation only.
5. **Bounded by default.** Every scenario declares TTL, cost, and blast radius, and tears itself down.
6. **The viewer stores nothing.** No accounts, no backend, no telemetry.
7. **Guardrails are tested as negative cases.** One that never fires is worse than none.

## Status

Early. The schemas are the stable surface; treat everything else as moving.

`main` is production. `dev` is where work lands first.

## Consumers

- [ninjapaws-cloud-security-dojo](https://github.com/ninjapaw/ninjapaws-cloud-security-dojo) — flagship scenario catalog

## License

MIT. See [LICENSE](LICENSE). Ninja Paw is an independent community project; no
Microsoft endorsement is implied.
