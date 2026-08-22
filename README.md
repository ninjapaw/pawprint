# Pawprint

**Deploy it. Prove it. Leave a pawprint.**

Pawprint is an open platform for reproducible cloud scenarios on Azure. It deploys
a known state, proves your tooling detected it, remediates, and proves the
detection cleared — emitting a portable evidence artifact for every run.

That artifact is a **pawprint**: a signed, diffable, shareable record of what was
deployed, what was asserted, and what was observed.

```
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
| `.github/workflows/kit-*.yml` | Reusable workflows, pinned by consumers at `@v1` |
| `platform/` | Subscription-scope baseline: run resource group, tag schema, TTL stamp |
| `modules/` | Shared Bicep modules |
| `scripts/` | Config resolver, scenario validator, policy and guardrail tests |
| `samples/` | Reference pawprint and scenario fixtures |

## Quick start

```bash
npm ci
npm test
```

```bash
# Resolve configuration for an environment
node scripts/pawprint-config.mjs --environment dev

# Validate scenario manifests against schema and safety policy
node scripts/validate-scenario.mjs "scenarios/**/scenario.json"
```

## Documentation

- [Adoption](docs/ADOPTION.md) — consuming Pawprint from another repository
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
