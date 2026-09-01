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

## Shared platform kit

Pawprint is also where the organisation's shared deployment building blocks
live, so a change to a convention is made once rather than in every repository.

| Reusable workflow            | Owns                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `kit-bicep-validate.yml`     | Bicep compilation, the shared linter ruleset, committed-ARM and vendored drift |
| `kit-deploy-static-site.yml` | Branch-to-environment binding, build, Static Web Apps publish, release         |
| `kit-promote.yml`            | Dev-to-main promotion pull request, gated on CI                                |
| `kit-keyvault-audit.yml`     | Secret expiry reporting, including secrets carrying no expiry at all           |
| `kit-scenario-validate.yml`  | Scenario manifest schema and policy                                            |
| `kit-reap-expired.yml`       | Teardown of runs past their `pawprint.expiresAt` tag                           |

| Shared module                   | Deploys                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `modules/static-site`           | Static Web App with optional DNS-validated custom domain      |
| `modules/key-vault`             | RBAC-authorised vault with audit logging, both secret tiers   |
| `modules/container-app-service` | Linux container on App Service with managed-identity ACR pull |
| `modules/evidence-store`        | Write-once blob storage for pawprints                         |
| `modules/monitoring`            | Log Analytics and Application Insights for an ephemeral run   |
| `modules/naming`                | The resource naming convention                                |

Bicep has no module registry here, so shared modules and scripts are vendored
into consumers under `vendor/pawprint/` with paths mirroring this repository.
`kit-bicep-validate.yml` fails the build when a vendored copy drifts, which is
what keeps a copy from quietly becoming a fork. Re-vendor rather than editing
the copy:

```bash
# What is vendorable is declared in config/vendor.manifest.json.
node scripts/vendor-sync.mjs --target ../site --target ../m365profiles
node scripts/vendor-sync.mjs --target ../site --check
node scripts/vendor-sync.mjs --target ../site --add modules/naming/main.bicep
```

Only files already present in the consumer are synchronised, so a repository
takes on a shared file deliberately with `--add` rather than by accident. Run
the sync after changing anything under the manifest; a formatter reformatting a
shared file counts as changing it.

```yaml
jobs:
  infrastructure:
    permissions:
      contents: read
      id-token: write
    uses: ninjapaw/pawprint/.github/workflows/kit-bicep-validate.yml@<immutable-ref>
    with:
      bicep-glob: "{infra,vendor}/**/*.bicep"
      check-committed-arm: true
```

### Secret tiers

`config/deploy.config.json` declares where a service's secrets live. The default
is `none`, because most services have no secrets and should not provision a
vault for them. Key Vault costs almost nothing at rest, so consolidation is
never a cost decision; it is a blast-radius decision.

| Mode       | Vault                                      | When                                                     |
| ---------- | ------------------------------------------ | -------------------------------------------------------- |
| `none`     | None                                       | The service has no secrets. Keep it this way.            |
| `workload` | Owned by the repository, in its own group  | Secrets belong to exactly one service and die with it    |
| `platform` | Tier 0 vault owned by `platform/org.bicep` | More than one repository genuinely needs the same secret |

In `platform` mode the service is granted `Key Vault Secrets User` scoped to the
individual secrets it names, never to the vault. That per-secret scoping is what
makes a shared vault safe to share; without it, one compromised workload
identity reaches every secret in the tier.

The platform baseline is deliberately small and off by default:

```bash
az deployment sub create \
  --location centralus \
  --template-file platform/org.bicep \
  --parameters platform/org.dev.bicepparam
```

Dev and production live in separate subscriptions, so there is one platform
resource group per environment rather than one for the organisation.

### The Defender DevOps connector is platform, and is not infrastructure as code

One connector covers an entire GitHub organisation, so it belongs beside the
other shared resources rather than inside a workload's resource group. Putting
it in a workload group couples organisation-wide security posture to that
workload's lifetime, which for an ephemeral or reapable environment means a
teardown silently removes coverage for every repository.

It is deliberately not declared in Bicep. The ARM resource can be created
declaratively, but authorization cannot: completing a connector needs an OAuth
code that only a browser flow issues, and a GitHub App that an organisation
owner installs. A template can therefore only ever produce the half that does
nothing, and would recreate that half on every run. A connector in that state
reports as provisioned and discovers no repositories.

So the connector is a one-time manual step, and what is automated is noticing
when it stops being healthy:

```bash
npm run connector:check -- --subscription <id> --github-org <org>
```

The check queries the `devops/default` sub-resource, which does not exist until
authorization succeeds, rather than trusting that the ARM resource exists.

### GitHub configuration scope

Where a value lives is decided by how widely it is identical and whether it is
actually a credential. Duplicating a value across repositories means rotating it
in several places and eventually missing one.

| Value                             | Scope                | Kind     | Why                                                                       |
| --------------------------------- | -------------------- | -------- | ------------------------------------------------------------------------- |
| `AZURE_TENANT_ID`                 | Organisation         | Variable | One directory for the whole organisation                                  |
| `AZURE_LOCATION`                  | Organisation         | Variable | Same region everywhere; a repository or environment may still override it |
| `AZURE_CLIENT_ID`                 | Environment          | Variable | One app registration per repository per environment                       |
| `AZURE_SUBSCRIPTION_ID`           | Environment          | Variable | Dev and production are different subscriptions                            |
| `AZURE_RESOURCE_GROUP` and names  | Environment          | Variable | Differ per environment                                                    |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | Environment          | Secret   | Grants publish rights to one specific site                                |
| Workload API keys                 | Environment          | Secret   | Belong to one service                                                     |
| DNS provider tokens               | Organisation, scoped | Secret   | Same credential wherever custom domains are validated                     |

The three Azure identity values are **Variables, not Secrets**. With OIDC
federated credentials there is no client secret; the client id is the public
half of the pair by design, and tenant and subscription ids appear in every
resource id the deployment prints. Marking them secret buys nothing and costs
real diagnosability, because GitHub then redacts them out of the deployment log
as `***`. They are not a credential: holding them grants nothing without the
federated trust, which is bound to a specific repository and environment.

Reusable workflows in this kit read these as `vars`, and fail with an
actionable message when one is unset rather than letting `azure/login` fail
with an opaque error.

### Setting up the platform

The order matters, because each step depends on the one above it. What the
organisation should look like is declared in `config/platform.json`, and the
status command compares that to reality rather than to intent:

```bash
npm run platform:status -- --environment dev --subscription dev=<id>
```

It reports three kinds of line. `ok` needs nothing. `MISSING` is a gap that
tooling can close. `DECIDE` is a question the tooling cannot answer, such as a
resource group whose name in configuration does not match what exists in Azure.

`--subscription` takes `<ref>=<id>` and may be repeated. The refs are the
`subscriptionRef` values in the manifest, which exist because an environment
does not always live in the subscription its name implies: the dojo's
production environment deliberately runs in the development subscription so a
deliberately-vulnerable training estate can never share a subscription with
real production workloads. Declaring that in the manifest keeps it a stated
decision instead of a finding that looks like a misconfiguration every time
anyone checks.

```bash
npm run platform:status -- --environment prod \
  --subscription prod=<prod-id> --subscription dev=<dev-id>
```

1. **Organisation variables.** `AZURE_TENANT_ID` and `AZURE_LOCATION` are set
   once for the organisation; everything else is per environment.
2. **Platform resource group.** `az deployment sub create --template-file
platform/org.bicep --parameters platform/org.<env>.bicepparam`. Shared
   monitoring, and optionally the tier 0 vault and DNS zones.
3. **Per repository and environment.** `npm run onboard -- --repo <org/repo>
--environment <env> --subscription <id> --resource-group <rg>`. Creates the
   application, the federated credential, the role assignments and the
   variables, and binds the environment to its branch. Defaults to a dry run.
4. **The DevOps connector**, once for the organisation, interactively. See
   above; this is the one step that cannot be scripted.

Re-run the status command after each step. A green dev environment looks like
every repository having an application, a credential whose subject matches what
GitHub actually emits, roles on its own resource group, and an environment
restricted to its branch.

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
