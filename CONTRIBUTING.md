# Contributing

## Development

Node.js 20+, Azure CLI with Bicep, and Bash. Run the full suite before opening a
pull request:

```bash
npm ci
npm test
```

That runs schema compilation, sample fixture validation, configuration
validation, scenario policy validation, and the negative-path guardrail tests.

## Branch flow

- Feature branches merge into `dev`.
- `dev` is the development branch and where work lands first.
- Use **Promote dev to main** to open the promotion pull request.
- `main` is production and stays protected.

## Rules

**Config is code.** Anything shared lives in a schema-validated file, never
hardcoded in a script or a Bicep template, and never in a CI settings page.
Adding a region, SKU, resource name, or TTL literal to `modules/` or `scripts/`
is a review rejection.

**No secrets in config.** The resolver rejects secret-shaped keys in any casing.
Runtime secrets belong in Key Vault; pipeline identity in GitHub Environment
variables. There is no client secret anywhere in this project.

**Guardrails get negative tests.** A guardrail that never fires is worse than no
guardrail, because it manufactures false confidence. Every policy rule needs a
test proving it rejects the bad input, and every suite needs a positive control
proving it still accepts good input.

**Assert from reality.** Evidence must be observed from the running system, not
read back from the configuration that requested it. See
[docs/SCENARIO-CONTRACT.md](SCENARIO-CONTRACT.md).

**Generated artifacts are regenerated in the same pull request.** A committed ARM
template that drifts from its Bicep source is not generated, it is a fork.

## Schema changes

Schemas are the stable surface others pin to. Bump deliberately:

| Change | Bump |
|---|---|
| Add an optional field | patch |
| Add a required field with a safe default | minor |
| Rename, remove, or retype a field | **major** |

A major bump needs a migration path and a documented upgrade note. Changing
config shape without one burns adopter trust exactly once.

## Pull requests

Include what changed and why, the validation commands and their results, security
or infrastructure impact, the impact tier of any configuration change, and the
rollback path.

## Scenarios

Scenario content lives in consuming repositories such as the Cloud Security Dojo,
not here. This repository holds the contract and the tooling that enforces it.
