# Adoption

How another repository consumes Pawprint.

## What you get

| Piece | How you consume it |
|---|---|
| Reusable workflows | `uses: ninjapaw/pawprint/.github/workflows/kit-*.yml@v1` |
| Schemas | `$schema` reference, or the validators in CI |
| Bicep modules | `module ... '<path>/modules/...'` after vendoring or submoduling |
| Config resolver | `node scripts/pawprint-config.mjs` |

Always pin a tag. Never track a branch: `dev` is where work lands first and will
break you.

## 1. Configuration

Copy `config/deploy.config.example.json` to `config/deploy.config.json` and edit
only that file. Leave `subscriptionId` as an empty string; the real value comes
from a GitHub Environment variable at runtime.

## 2. Identity

Run `npm run setup`. It registers the admin application, defines app roles, and —
critically — creates a **federated identity credential** per environment so
GitHub Actions can authenticate to Azure without a secret.

The credential subject must be the environment form:

```
repo:<owner>/<repo>:environment:<environment-name>
```

A job that declares `environment:` presents that subject. A ref-based credential
will simply not match, and the login step fails with an opaque error.

Setup also restricts each environment to a single deployment branch — `dev` to
`dev`, `prod` to `main` — so production cannot be deployed from an arbitrary
branch.

Each GitHub Environment ends up with exactly three variables:

```
AZURE_CLIENT_ID
AZURE_TENANT_ID
AZURE_SUBSCRIPTION_ID
```

These are federated OIDC identifiers, not secrets. There is no client secret to
create, rotate, or leak. Everything else lives in schema-validated configuration
rather than a settings page.

Verify with `npm run doctor`, which reports whether federated trust exists at all.

## 3. Wire up CI

```yaml
name: CI

on:
  pull_request:
    branches: [dev, main]

permissions:
  contents: read

jobs:
  scenarios:
    uses: ninjapaw/pawprint/.github/workflows/kit-scenario-validate.yml@v1
    with:
      scenario-glob: "scenarios/**/scenario.json"

  infrastructure:
    uses: ninjapaw/pawprint/.github/workflows/kit-bicep-validate.yml@v1
    with:
      bicep-glob: "infra/**/*.bicep"
      check-committed-arm: true
```

`check-committed-arm` closes a real gap. If you commit a compiled ARM template
next to its Bicep source — for a Deploy to Azure button, say — the two drift
silently unless something compares them. Compiling to a throwaway path and then
only checking that the committed JSON parses does **not** catch this.

## 4. Promotion

```yaml
name: Promote dev to main

on:
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  promote:
    uses: ninjapaw/pawprint/.github/workflows/kit-promote.yml@v1
    with:
      require-ci: true
```

Idempotent: re-running updates the existing promotion pull request rather than
opening a second one. It refuses to promote a branch whose CI has not passed.

## 5. Deployment shape

Two phases, because Bicep module paths must be literal and cannot be selected at
compile time.

```bash
# Phase 1 - platform baseline, subscription scope.
# Creates the run resource group with the Pawprint tag schema and expiry stamp.
az deployment sub create \
  --location "$LOCATION" \
  --template-file platform/main.bicep \
  --parameters resourceGroupName="$RG" location="$LOCATION" \
               environmentName="$ENVIRONMENT" runId="$RUN_ID" \
               scenarioId="$SCENARIO_ID" ttlHours="$TTL"

# Phase 2 - scenario, resource group scope. The runner resolves the path.
az deployment group create \
  --resource-group "$RG" \
  --template-file "scenarios/$SCENARIO_ID/infra/main.bicep" \
  --parameters location="$LOCATION" tags="$TAGS" \
               logAnalyticsWorkspaceId="$LAW_ID"
```

One resource group per run is the blast-radius boundary. Teardown is a group
delete, or a stack delete if you adopt Deployment Stacks — worth evaluating,
since managed lifecycle and deny settings map well onto ephemeral scenarios that
must hold a known state.

## 6. Handle pawprints carefully

An unredacted pawprint carries subscription and tenant IDs, resource IDs, and the
operator identity.

- `output/` and `*.pawprint.json` are git-ignored by default. Keep it that way.
- Redact before sharing outside your organization.
- The viewer runs entirely client-side; nothing is transmitted.

## Versioning

Pawprint uses prefixed tags so each surface versions independently:

| Tag prefix | Covers | Consumers pin |
|---|---|---|
| `kit/vN` | Reusable workflows | Yes |
| `schema/vN` | Schema contracts | Yes |
| `modules/vN` | Bicep modules | Yes |

A change to a scenario or the viewer does not move a tag you depend on.

## Upgrading

`config/deploy.defaults.json` is upstream-owned and merges cleanly. Your
`config/deploy.config.json` is never touched by upstream. On a major
`configVersion` bump, the resolver fails with the required action rather than
guessing.
