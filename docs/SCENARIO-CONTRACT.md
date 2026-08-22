# Scenario contract

A scenario is **data, not code**. It declares what it deploys, what it costs, how
long it lives, and what evidence it produces. The runner knows nothing about any
particular scenario; it only knows this contract.

## Layout

```
scenarios/<id>/
  scenario.json          # the manifest, validated against schema/scenario.schema.json
  infra/main.bicep       # honours the parameter and output contract below
  payload/               # Dockerfile and application, if the scenario ships one
  README.md
```

## Lifecycle

```
provision → build → deploy → arm → detect → remediate → verify → destroy
```

- **provision** creates infrastructure
- **build** produces the image, if any
- **deploy** puts the workload in place
- **arm** establishes the condition to be detected
- **detect** gathers evidence that tooling noticed
- **remediate** applies the fix
- **verify** gathers evidence that the condition cleared
- **destroy** releases everything

`destroy` is mandatory. A scenario that cannot tear itself down is not accepted.

## Bicep contract

Scenario infrastructure is deployed in a second phase, into the resource group
the platform baseline created. Module paths in Bicep must be literal, so the
runner resolves the scenario path — never Bicep itself.

```bicep
// Required inputs, always supplied by the runner
param location string
param namePrefix string
param tags object                 // includes pawprint.runId and pawprint.expiresAt
param logAnalyticsWorkspaceId string

// Required outputs, read back into the pawprint
output endpoints array            // [{ name, url, public }]
output resourceIds array
```

Apply `tags` to every resource. Reaping and cost attribution depend on it.

## Assertions are the product

Each assertion in the manifest becomes a check in the emitted pawprint, keyed by
the same `id`. That shared key is what makes runs diffable over time even when
labels change.

```json
{
  "id": "runtime.nginx-version",
  "label": "Running NGINX binary reports the expected version",
  "stage": "arm",
  "source": "runtime",
  "expected": "1.30.3"
}
```

The `source` field determines how much the evidence is worth:

| Source | Strength | Meaning |
|---|---|---|
| `runtime` | Strongest | Read from the running system |
| `control-plane` | Strong | Read from Azure Resource Manager |
| `http` | Strong | Observed over the network |
| `registry` | Strong | Read from the container registry |
| `config` | **Weak** | Read from requested configuration |
| `external` | Varies | Third-party system |

**Assert from reality, never from intent.** A scenario whose assertions all read
from `config` proves only what it asked for, and CI rejects it. The reference
implementation computes its detection at container start from the actual binary
version and the active configuration file, then writes that observation to disk
for the assertion to read.

Set `mayBeUnknown: true` for asynchronous observations. Detection pipelines are
eventually consistent; an assertion that has not yet had time to become true
should report `unknown`, not `fail`.

## Safety

Every scenario declares its blast radius, and CI enforces the declaration:

- `destroy` present in `stages`
- `defaultTtlHours` positive and within the 168-hour ceiling
- `maxTtlHours` not below `defaultTtlHours`
- `disclaimer` present when `intentionallyVulnerable` is true
- `ingressJustification` of real substance when `publicIngress` is true
- no endpoint marked `public` while `publicIngress` is false
- at least one assertion reading from something other than `config`
- every `critical` parameter carrying a default or marked required
- `cost.estimatedPerHour` declared
- a `verify`-stage assertion whenever the scenario remediates

Each rule has a negative test in `scripts/test-scenario-policy.mjs`.

## Validating

```bash
node scripts/validate-scenario.mjs "scenarios/**/scenario.json"
```

In CI:

```yaml
jobs:
  scenarios:
    uses: ninjapaw/pawprint/.github/workflows/kit-scenario-validate.yml@v1
    with:
      scenario-glob: "scenarios/**/scenario.json"
```

## Publishing images

Prefer GHCR. A public image means an adopter can run the scenario without
provisioning a registry, paying for one, or waiting on a build. Set
`deployContainerRegistry: false` on the container module and pass
`externalImageReference`.

Use ACR when a scenario genuinely needs a private registry, or when an adopter's
policy forbids public egress.
