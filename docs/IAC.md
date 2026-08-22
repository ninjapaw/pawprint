# Infrastructure as code

## Three things called "state"

Conflating these is the most common confusion when people ask where pawprints
should live.

| Concept | Where it lives | Written by |
|---|---|---|
| **IaC state** | Azure Resource Manager itself | Nothing — there is no state file |
| **Pawprint evidence** | `file`, `githubArtifact`, or `azureBlob` sink | The runner |
| **Viewer preferences** | Browser `localStorage` | The browser |

**Bicep is stateless.** ARM holds the record of what exists, so there is no state
file to store, lock, encrypt, back up, or accidentally corrupt. Every deployment
is a declaration of desired state that ARM reconciles.

That answers the storage question directly: **JSON on a static site is correct for
reading**, and the site can never write — which is precisely why it is safe to
publish. Writes come from the runner. Blob storage is about **durable retention**,
not about giving the site a database.

## Why Bicep and not Terraform

Terraform is a good tool. It is the wrong tool here.

| | Bicep | Terraform |
|---|---|---|
| State | ARM is the state | External state file requiring a storage account, container and lease |
| Bootstrap | None | Chicken-and-egg: provisioning the state backend needs infrastructure |
| Preview | `az deployment ... what-if` | `terraform plan` |
| Azure coverage | Day-one, no provider lag | Provider release lag for new resource types |
| Multi-cloud | Azure only | Many providers |

Pawprint targets Azure only. Adopting Terraform would add a state backend to
secure, lock, back up and recover — with a concurrency story to design for
parallel scenario runs — in exchange for portability we do not use.

**Decision: Bicep only.** Revisit if a scenario ever needs a non-Azure resource,
in which case Terraform for that scenario alone would be reasonable. Scenarios
declare their own infrastructure, so a single Terraform scenario would not force
the platform to adopt it.

## Layout

```
bicepconfig.json                  linter rules, enforced in CI
modules/types.bicep               shared user-defined types
modules/monitoring/               Log Analytics + Application Insights
modules/container-app-service/    Linux container on App Service
modules/evidence-store/           immutable blob store for pawprints
platform/main.bicep               subscription scope: run resource group + tags
platform/main.dev.bicepparam      environment parameters
platform/main.prod.bicepparam
```

## Two-phase deployment

Bicep module paths must be literal, so a scenario cannot be selected inside
Bicep. The runner resolves the path instead:

```bash
# Phase 1 - subscription scope. Creates the run resource group and its TTL tags.
az deployment sub create \
  --location "$PAWPRINT_LOCATION" \
  --template-file platform/main.bicep \
  --parameters platform/main.dev.bicepparam

# Phase 2 - resource group scope. Path resolved by the runner, not by Bicep.
az deployment group create \
  --resource-group "$PAWPRINT_RESOURCE_GROUP" \
  --template-file "scenarios/$SCENARIO_ID/infra/main.bicep" \
  --parameters location="$PAWPRINT_LOCATION" tags="$TAGS"
```

## Parameter files

`.bicepparam` is preferred over ARM JSON parameter files: it is type-checked
against the template, so a renamed or mistyped parameter fails at build time
rather than at deployment.

Dynamic values come from the resolver via `readEnvironmentVariable`, so
configuration keeps one source of truth and run identifiers never land in source
control:

```bicep
using '../platform/main.bicep'

param resourceGroupName = readEnvironmentVariable('PAWPRINT_RESOURCE_GROUP')
param ttlHours = int(readEnvironmentVariable('PAWPRINT_TTL_HOURS', '8'))
```

Populate the environment first:

```bash
node scripts/pawprint-config.mjs --environment dev --github-env
```

## Practices applied

Following the Bicep team's current guidance:

- **No `name` on module declarations.** It is no longer required.
- **`.bicepparam` over ARM JSON** parameter files.
- **User-defined types instead of open `object` and `array`.** `modules/types.bicep`
  types the tag schema, endpoints and app settings, so a missing `pawprint.expiresAt`
  is a build error rather than an unreapable resource.
- **Safe dereference over non-null assertion.** `monitoring.?outputs.workspaceId ?? ''`
  rather than `monitoring!.outputs...`, which can fail at runtime.
- **Symbolic references over `resourceId()`.**
- **`parent` for child resources**, never `/` in names.
- **Current API versions.** The `use-recent-api-versions` rule fails CI on anything
  older than 730 days.
- **No secrets in parameters or outputs.** Nothing here is `@secure()` because
  nothing secret is passed; identity is federated and secretless.

## Linting

`bicepconfig.json` enables the core analyzer with `no-hardcoded-location`,
`no-unused-params`, `outputs-should-not-contain-secrets`,
`use-stable-resource-identifiers`, `use-recent-api-versions` and `use-safe-access`
among others.

CI fails on warnings by default:

```yaml
jobs:
  infrastructure:
    uses: ninjapaw/pawprint/.github/workflows/kit-bicep-validate.yml@v1
    with:
      bicep-glob: "infra/**/*.bicep"
      fail-on-lint-warning: true
      check-committed-arm: true
```

Stale API versions and unused parameters are cheap to fix now and expensive to
discover during an incident.

## What-if

The most valuable review gate. It shows a change in Azure's terms rather than as
a template diff:

```yaml
    with:
      what-if: true
      environment: dev
      what-if-parameters: platform/main.dev.bicepparam
```

The predicted delta is posted to the job summary so a reviewer sees
"SKU Free to Standard" instead of reading JSON.

## Committed ARM templates

If you commit a compiled `main.json` next to `main.bicep` — for a Deploy to Azure
button — `check-committed-arm` proves they match. Compiling to a throwaway path
and separately checking the committed JSON merely parses does **not** catch drift,
which is a real gap this closes.

## On Azure Verified Modules

Pawprint's modules are hand-rolled rather than AVM-based, deliberately.

AVM modules are excellent for durable platform infrastructure: tested,
Microsoft-maintained, with diagnostics, locks and RBAC surface included. That
surface is mostly unused by an ephemeral scenario run that exists for hours, and
it adds a versioned external dependency resolved from a registry at deploy time.

Where AVM fits well is durable shared infrastructure — the evidence store is the
strongest candidate, since it is long-lived and its correctness matters most.
Treat this as a decision to revisit per module, not a blanket policy in either
direction. If you adopt an AVM module, **pin an exact version** and update it
through a reviewed pull request.

## Deployment Stacks

Worth evaluating and not yet adopted. A deployment stack tracks every resource it
created, deletes them together, and supports deny settings that prevent drift
while a scenario holds a known state — which maps well onto ephemeral runs.

Today teardown is a resource-group delete, driven by the `pawprint.expiresAt` tag
and the reaper workflow. That works and is simple. Deployment Stacks would make
teardown more precise and add drift protection; confirm current capabilities and
limits before switching.
