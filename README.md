# Pawprint

**Deploy it. Prove it. Leave a pawprint.**

> Independent community project. Pawprint is not a Microsoft product, official
> assessment, endorsement, or deployment guide. Validate all deployments and
> recommendations before using them. See [DISCLAIMER.md](DISCLAIMER.md).

Pawprint is an Azure platform for reproducible cloud-security scenarios. It
deploys a known state, proves what was observed, records detection and
remediation evidence, and tears the run down when it expires.

```text
provision -> build -> deploy -> arm -> detect -> remediate -> verify -> destroy
```

The output is a portable, schema-validated **pawprint**: a signed, diffable
record of what was deployed, asserted, and observed.

## What is included

| Path                          | Purpose                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `schema/`                     | Pawprint, scenario, connector, and deployment-config contracts             |
| `platform/`                   | Subscription-scope run resource group, tags, and expiry metadata           |
| `modules/`                    | Reusable Bicep modules                                                     |
| `scripts/`                    | Configuration, setup, validation, connector, doctor, and uninstall tooling |
| `.github/workflows/kit-*.yml` | Reusable validation, Defender posture, promotion, and cleanup workflows    |
| `samples/`                    | Reference scenario and pawprint fixtures                                   |

## Quick start

Requirements: Node.js 22.12+, npm, Azure CLI for Azure operations, and GitHub
CLI for GitHub integration.

```bash
npm ci
npm test
npm run doctor
```

For first-time setup:

```bash
npm run setup
```

The setup wizard creates the Entra application and GitHub OIDC trust required
for the selected environments. It creates no client secret. Review the preview
and use your existing workforce Entra tenant; do not create a new tenant for
this tool.

## Configuration

Configuration is resolved in this order, with later values taking precedence:

```text
builtin < config/deploy.defaults.json < config/deploy.config.json
         < environment variables < CLI flags
```

Adopters copy `config/deploy.config.example.json` to
`config/deploy.config.json`. Keep subscription IDs out of committed files;
provide them through GitHub Environment variables or a runtime override.

```bash
node scripts/pawprint-config.mjs --environment dev
node scripts/pawprint-config.mjs --environment dev --check
node scripts/pawprint-config.mjs --branch dev --github-env
```

Committed configuration is schema-validated and fails closed. Secret-shaped
values are rejected, subscriptions must be explicitly approved, and
environment branches are isolated (`dev` to `dev`, `prod` to `main`). Runtime
secrets belong in Azure Key Vault. Pipeline identity belongs in GitHub
Environment variables, not repository files or long-lived client secrets.

## Identity and permissions

Pawprint has three separate planes:

| Plane                     | Default posture                                                     |
| ------------------------- | ------------------------------------------------------------------- |
| Viewer                    | Static/client-side and unauthenticated; stores nothing              |
| Local setup/admin console | Loopback-only, using workforce Entra or a local fallback credential |
| Hosted team console       | Internal deployment protected by workforce Entra app roles          |

Use the existing workforce Entra tenant so Conditional Access, MFA, Identity
Protection, PIM, audit retention, and group-based access remain in one place.
Assign app roles to groups where possible:

| Role                | Responsibility                                                      |
| ------------------- | ------------------------------------------------------------------- |
| `Pawprint.Admin`    | Configure identity, sinks, environments, and destructive operations |
| `Pawprint.Operator` | Deploy, remediate, verify, and destroy runs                         |
| `Pawprint.Reader`   | View pawprints and configuration                                    |

GitHub repository actions are separate from human sign-in. Prefer a GitHub App
for repository automation. If using reusable workflows, pin an immutable
release tag or commit SHA, never a branch:

```yaml
uses: ninjapaw/pawprint/.github/workflows/kit-bicep-validate.yml@<immutable-ref>
```

## Evidence and storage

Pawprints are JSON and remain portable regardless of where they are stored.

| Sink             | Use                                                                  |
| ---------------- | -------------------------------------------------------------------- |
| `file`           | Local, offline, or air-gapped runs                                   |
| `githubArtifact` | Convenient CI retention; not a system of record                      |
| `azureBlob`      | Durable evidence storage; enable immutability for relied-on evidence |

Use `azureBlob` with `immutable: true` when evidence must be tamper-resistant.
The configured retention policy prevents alteration or deletion before expiry.
Redact subscription IDs, tenant IDs, resource IDs, hostnames, and operator
identity before sharing pawprints outside the owning organization.

## Scenario contract

A scenario is data plus its infrastructure, not runner-specific code:

```text
scenarios/<id>/
  scenario.json
  infra/main.bicep
  payload/
  README.md
```

Every scenario must declare its lifecycle, cost, TTL, ingress justification,
parameters, assertions, and remediation behavior. `destroy` is mandatory.
Assertions should read from reality, in this order of evidence strength:

```text
runtime > control-plane/http/registry > external > config
```

Do not use configuration intent as proof of a running state. Asynchronous
observations may report `unknown` until the service has had time to converge.

Validate a scenario with:

```bash
node scripts/validate-scenario.mjs "scenarios/**/scenario.json"
```

Scenario infrastructure is deployed in two phases: the subscription-scope
platform baseline creates one tagged run resource group, then the scenario is
deployed at resource-group scope. Bicep parameter files (`.bicepparam`) are
preferred because they are type-checked.

## Connectors

Connectors are optional and permission-tiered. Start with the lowest tier that
unlocks the capability you need:

| Tier    | Meaning                                            |
| ------- | -------------------------------------------------- |
| `none`  | Identity only or disconnected                      |
| `read`  | Observe; no changes                                |
| `write` | Act within the intended resource boundary          |
| `admin` | Elevated or app-only access; avoid unless required |

```bash
npm run connect
node scripts/pawprint-connect.mjs --plan microsoft365=read,azure=write
```

The planner previews consent and capabilities without requesting permissions.
Delegated access is preferred. Azure write access is scoped to the run resource
group; approved subscriptions are an explicit allowlist and an empty list
approves nothing. Publishing images to GHCR can avoid the elevated managed
identity pull permission.

## Lifecycle and cleanup

Every Azure run is bounded by a tagged resource group and expiry stamp. The
reaper only considers Pawprint-managed groups and has a deletion limit.

```bash
npm run doctor
npm run uninstall                    # preview only
npm run uninstall -- --apply         # remove recorded objects
npm run uninstall -- --apply --purge # also purge the recycle bin
```

Uninstall uses recorded object IDs, not display-name matching. What-if is the
default. Entra-deleted applications remain restorable for 30 days unless the
explicit purge option is used. Immutable evidence and subscription-wide
Defender plan activation may not be immediately reversible.

## CI and adoption

Run the local checks before opening a pull request:

```bash
npm test
```

Consumers can adopt the reusable kits from another repository:

```yaml
jobs:
  scenarios:
    uses: ninjapaw/pawprint/.github/workflows/kit-scenario-validate.yml@<immutable-ref>
    with:
      scenario-glob: "scenarios/**/scenario.json"

  infrastructure:
    uses: ninjapaw/pawprint/.github/workflows/kit-bicep-validate.yml@<immutable-ref>
    with:
      bicep-glob: "infra/**/*.bicep"
      check-committed-arm: true
```

Use `check-committed-arm` whenever generated ARM templates are committed.
Promotion is intentionally pull-request based and should require successful CI
before `dev` is promoted to `main`.

## Design commitments

- Evidence is the product; deployment is how it is produced.
- Assertions come from observed reality, not requested intent.
- Configuration is code and is schema-validated.
- OIDC is preferred over long-lived credentials.
- Scenarios are bounded by TTL, cost, blast radius, and teardown.
- The viewer stores nothing and has no backend.
- Negative guardrail tests are part of the contract.

## Project status

Pawprint is early-stage. Schemas are the most stable public surface; runners,
modules, and workflows continue to evolve. The flagship consumer is
[ninjapaws-cloud-security-dojo](https://github.com/ninjapaw/ninjapaws-cloud-security-dojo).

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and [LICENSE](LICENSE).
