# First-run planning

The local first-run wizard asks only questions that change deployment scope,
cost, identity, naming, or risk. Development and production are selected by
default; QA and testing are optional.

## Decisions

1. Environment topology: development, production, QA, and testing.
2. Default management subscription and optional per-environment subscription
   overrides.
3. Default physical Azure region and optional per-environment overrides.
4. Organization prefix, platform name, and deterministic CAF-aligned names.
5. Initial connector intent and required ownership/cost/classification tags.
6. Whether delete-and-recreate may be considered. The default is no, and each
   destructive operation still requires its own preview and confirmation.

Workloads and scenarios are not permanently tied to the management
subscription. They may target another accessible, approved subscription when
their own deployment configuration and operator permissions allow it.

## Cost context

The subscription step queries month-to-date `ActualCost` and a monthly
subscription budget on demand. Remaining means budget minus current actual
cost; it is not an Azure credit balance. If no monthly budget exists, the
wizard says so. If the operator cannot query costs, deployment planning remains
available and the page identifies that Cost Management access is unavailable.

Use `Cost Management Reader` for cost visibility without billing changes.
Budget creation and billing-account operations are outside the first-run apply
path.

## Naming

Names follow the Cloud Adoption Framework component pattern: resource type,
workload or application, environment, Azure region, and an instance suffix
where global uniqueness requires one. The customizable prompt informs the
naming input, but final generation is deterministic. Infrastructure names must
not depend on nondeterministic model output because regeneration would create
drift or replacement.

Generated examples include resource group, Static Web App, Function App, Key
Vault, Log Analytics, Application Insights, and Storage account names. The
shared `modules/naming/main.bicep` contract supports dev, prod, QA, and test.

## Persistence and security

Saving creates `.pawprint-setup-plan.json` with mode `0600`. The file is
git-ignored because it contains local subscription identifiers and operator
choices. It contains no token, password, certificate, connection string, or
private key. Saving does not deploy or grant consent.

The next step is Platform connections, where declared IaC is previewed before
apply and provider authorization is completed through guided flows.

## Roadmap

Management groups are intentionally deferred. Additional roadmap items are:

- Management-group topology and subscription vending.
- Azure Policy initiatives for required tags, allowed regions, diagnostics,
  and naming audits.
- PIM activation and automated access reviews.
- Cost anomaly alerts, forecasting, chargeback, and budget creation.
- Multi-region recovery objectives and tested failover.
- Naming-policy enforcement and collision reservation.
- Deployment stamps for larger multi-tenant or multi-region estates.
- Data residency, sovereignty, and regulatory profiles.
