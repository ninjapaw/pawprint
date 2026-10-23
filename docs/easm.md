# Shared Defender EASM operations

Pawprint owns one long-lived, shared Defender External Attack Surface Management
inventory in an explicitly selected primary environment. Applications do not
deploy copies of it. No live workspace, role, budget, lock, or discovery job is
created merely by checking out this repository or pushing code.

## What is automated

| Surface | Owner and behavior |
| --- | --- |
| Workspace | [Shared Bicep](../platform/org-easm.bicep), also composed by [the organisation baseline](../platform/org.bicep). |
| Access | Explicit Reader/Contributor principal bindings, scoped only to the workspace. No Owner, subscription grant, or app secret is created. |
| Cost alerts | Optional monthly Cost budget filtered to the exact workspace resource ID, with actual 80%/100% and forecast 100% notifications. No amount or recipient is invented. |
| Deletion protection | Optional `CanNotDelete` workspace lock; no read-only lock that would block normal operation. |
| Provider registration | A separately approved CLI/workflow action registers `Microsoft.Easm`, plus `Microsoft.Consumption` when a budget is declared, and reads back registration. |
| Discovery configuration | Entra-authenticated GET/PUT reconciliation of owned discovery groups, descriptions, tier, explicit seeds, exclusions and recurrence. |
| Discovery execution | A separate, explicitly authorized one-time run action; pending/running jobs are not knowingly duplicated. |
| Verification | Resource ownership, provisioning, budget scope/contacts/thresholds, lock, declared access and discovery readback. Run metadata is reported without claiming completed coverage. |

ARM does not expose discovery groups as workspace properties, so the
[Node reconciler](../scripts/easm.mjs) manages their documented data-plane API.
No unsupported ARM resources, pricing toggles, diagnostic categories, fixed
prices, asset-count caps, or automatic shutdown controls are invented.

The tooling never invokes asset-approval, asset-remediation, group deletion, or
workspace deletion APIs. **EASM itself can automatically classify discovered
assets into inventory and generate billable assets.** Recursive discovery can
follow relationships outside the seed domains; the seed allowlist is not a
guaranteed scan perimeter. Review scope, dependencies, inventory and billable
asset counts before enabling discovery or recurrence.

## Required operator inputs

The [example](../config/easm.config.example.json) is deliberately disabled, with
no budget, contact addresses, principal IDs, or seed list. It is valid for an
offline plan but cannot deploy or scan.

| Input | Requirement |
| --- | --- |
| Primary environment | Choose `prod` or an intentionally shared `dev`; normally use only one inventory. Its group is resolved from [platform configuration](../config/platform.json), not an arbitrary target override. |
| Azure target | Supply explicit `AZURE_SUBSCRIPTION_ID` and `AZURE_TENANT_ID` at runtime. The active enabled AzureCloud account must match both. No account is switched automatically. |
| Workspace | Set `enabled=true`, a stable workspace name and approved data region. The existing managed shared group must already exist. |
| Budget | Provide `monthlyAmount` in whole subscription billing-currency units, 1-5 notification email addresses, and a stable first-of-month UTC `startDate`, such as the first day of your approved budget period. No price estimate is implied. |
| Access | Supply existing Entra user/group/service-principal object IDs and explicit Reader/Contributor roles only when new bindings are required. No directory identity is guessed or created. |
| Authorization | Supply owned/authorized domains, reviewed group seed/exclusion lists, a valid service tier, and recurrence in days. Empty discovery is the default. |
| Ownership | Keep `key`, environment and workspace name stable. The description marker and reserved `pawprint-KEY-NAME` group names identify this configuration's groups. |

`budget.startDate` must be `YYYY-MM-01T00:00:00Z` and must remain compatible with
Azure's budget-period rules. It is not reset every deployment. An existing
budget with a different scope or immutable start date requires explicit review.
Budget alerts are delayed notifications, **not a spending stop**. Review your
agreement, trial eligibility and billable asset counts; first-resource trial
expiry can automatically lead to usage charges.

The known DNS zones `ninjapaws.org`, `m365profiles.com`, and
`sentineloptimizer.com` are candidates only after ownership/authorization is
confirmed. No zone is automatically seeded or approved. Do not claim
Cloudflare's IP ranges or Azure's shared provider root domains as owned assets.

## Offline setup on Windows

Use Node/npm versions declared by this repository. On first setup only, copy
the example to a new `config\easm.config.json`; do not overwrite an existing
operator configuration. The local file is gitignored. Keep credentials out of
it: unknown properties, token/subscription fields, broad roles, malformed
financial data, duplicate bindings and out-of-allowlist seeds are rejected.

```powershell
npm ci
npm run easm -- validate --config config\easm.config.example.json
npm run easm -- plan --config config\easm.config.example.json
# After creating and reviewing your own local configuration:
npm run easm -- validate
npm run easm -- plan
```

`--config` selects an explicit file. Otherwise `EASM_CONFIG_JSON`, when set,
is used; otherwise the local gitignored configuration is required. No populated
example or target is silently substituted. Plans show configuration digests,
counts and blockers, not tokens, contact emails, principal IDs or raw JSON.

## Recommended manual GitHub workflow

Use [Shared EASM plan, deploy, and discovery](../.github/workflows/shared-easm.yml).
It is `workflow_dispatch` only, serialized per primary environment, with
non-cancelling concurrency. No push/PR/scheduled workflow deploys or scans.

Create protected GitHub Environments with required reviewers and deployment
branch restrictions. These approvals cannot be guaranteed by workflow YAML
alone. Cloud actions require `main`/`prod` or `dev`/`dev`; configuration must match
the selected environment.

Set the following Environment configuration:

- **Secret `EASM_CONFIG_JSON`:** the reviewed non-credential operator JSON.
  Secret storage is used for privacy of contacts, scope and business metadata,
  not because the JSON should contain authentication credentials.
- **Variables `AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`:**
  identifiers for the explicit target and approved infrastructure/OIDC identity.
- **Variable `AZURE_READ_CLIENT_ID`:** a separate read identity for `verify` and
  `discovery-plan`. A missing read identity fails; it never falls back to the
  write identity.

Reuse Pawprint's existing OIDC onboarding and exact federated-subject convention.
No long-lived client secret is needed. Review permissions, rather than granting
subscription Owner merely to make the workflow work:

- The shared baseline must first be provisioned by its approved operator with
  reviewed subscription/group creation and deployment rights.
- The EASM workflow deploys **only** the resource-group-scoped EASM module into
  that existing owned group, not the whole monitoring/Key Vault/DNS baseline.
- The write identity needs EASM and group-deployment write/read rights.
  Optional bindings also need appropriately scoped role-assignment write/read
  rights; locks need lock write/read rights; budgets need budget write/read and
  eligible cost-management access.
- Provider registration is a subscription-level action for an approved
  registration operator. It is not attempted silently during normal deployment.
- The read identity needs shared-group/resource metadata reads, EASM reads,
  role/lock reads, and permitted budget/cost visibility. Human Reader/Contributor
  bindings remain scoped to the workspace. Inherited/manual grants are not
  asserted absent.

Run these stages with the **same reviewed configuration**:

The optional `request_id` workflow input is a portal-generated UUID for
correlating an accepted request with the GitHub run title and the CLI's
`shared-easm-request` log event. It is validated before cloud operations.
It never grants access or substitutes for write/cost, discovery, or protected
Environment approval. Existing manual calls can leave it empty.

1. `plan` / `validate`: offline configuration and blockers; no Azure login.
2. `register-provider`: only if needed, with explicit write approval.
3. `what-if`: read-only scoped preview. Incomplete analysis, deletes, unrelated
   resource changes, and undeclared grants block deployment.
4. `deploy`: explicit write/cost approval; repeats what-if, creates/reconciles
   the workspace/governance and verifies readback. It does not configure or run
   discovery.
5. `discovery-plan`: read only; inspect the declared scope privately and compare
   the configuration digest before approval.
6. `discovery-apply`: both write/cost and separate recursive-discovery approval.
   Creates or updates only groups with this configuration's ownership marker.
7. `run-discovery`: the same two approvals, only after configuration matches;
   submits the declared groups using the documented HTTP 204 operation. A
   submission is not completed discovery.
8. `verify`: reads provisioning/governance/configuration and observed run state.
   Failed runs fail verification; pending/running is never described as coverage.

An explicit tier is required; Microsoft's examples use `advanced`. Confirm the
appropriate service tier before approving it. `frequencyDays` is translated to
milliseconds; zero requests a non-repeating interval. Start with a small
authorized scope and inspect service schedule/run state and billable assets
before enabling positive recurrence. Configuration writes can affect discovery
behavior and therefore always require the separate discovery approval.

## Local cloud operations

Native Windows deliberately supports offline modes only. Use the GitHub
workflow or WSL/Linux Node with Azure CLI and Bicep 0.48.1 for cloud operations;
the tool does not invoke a Windows batch shim through a shell.

Log in to the owning tenant and explicitly select the approved subscription.
Then use the same stages locally:

```bash
npm run easm -- register-provider --yes
npm run easm -- what-if
npm run easm -- deploy --yes
npm run easm -- discovery-plan
npm run easm -- discovery-apply --yes --approve-discovery
npm run easm -- run-discovery --yes --approve-discovery
npm run easm -- verify
```

Azure CLI must expose the matching enabled active account and the two explicit
runtime IDs. The reconciler retains retrieved ARM and
`https://easm.defender.microsoft.com/.default` tokens only in memory, never in
its files/logs. Azure CLI manages its own credential cache; GitHub uses ephemeral
configuration and login cleanup. Protect local CLI sessions according to policy.
Requests are HTTPS-only, refuse redirects, and are pinned to
the independently read workspace ID/region/endpoint. Neither a manifest URL
override nor a hostile pagination URL can redirect credentials.

## Repair, retention and decommissioning

Repeated deployment and discovery application are idempotent when the requested
state is unchanged. All desired discovery groups are inspected before the first
write, rechecked before updates, and read back afterward. Concurrency is not a
provider-side compare-and-swap guarantee; do not run independent applies
concurrently for the same workspace.

- Unmanaged workspaces, implicit renames/region moves, multiple workspaces in
  the selected primary group and foreign discovery groups are not adopted.
- Changing a key/environment does not silently create overlapping managed
  inventories. Omitted owned discovery groups are an error, not a deletion.
- Incremental ARM deployment does **not** revoke removed grants. Previously
  managed grants omitted from desired access block the CLI until an authorized
  operator explicitly reviews/revokes them. Manual/inherited grants need
  separate access review.
- Omitting a budget, lock or workspace from a template, or setting
  `deployEasm=false`, does not delete/suspend it or stop billing. The recommended
  CLI requires a declared budget before deployment/discovery writes.
- Schedule changes do not cancel in-flight runs or eliminate existing billable
  inventory. Stop/retire discovery deliberately and review EASM's actual state.
- Decommissioning is not automated by a workload teardown. An authorized
  operator must review shared dependencies/exports, remove the deletion lock
  explicitly, handle access/budgets, delete only the intended resource if
  approved, and verify billing afterward. Workspace deletion is irreversible.

## Validation and references

`npm run test:easm` covers schema, financial/scope/identity guards, mocked
deployment/readback, ownership, concurrency, credential isolation and the
documented discovery APIs. CI compiles the shared templates and both environment
parameter files and validates the compiled budget/access/lock scope contract.
These checks do not establish live subscription eligibility, policy approval,
budget delivery, discovery completion, ingestion, CVE coverage or protection.

- [EASM workspace deployment and regions](https://learn.microsoft.com/azure/external-attack-surface-management/deploying-the-defender-easm-azure-resource)
- [EASM authentication](https://learn.microsoft.com/rest/api/defenderforeasm/authentication)
- [Create or replace a discovery group](https://learn.microsoft.com/rest/api/defenderforeasm/dataplanepreview/discovery-groups/create-or-replace-disco-group)
- [Run a discovery group](https://learn.microsoft.com/rest/api/defenderforeasm/dataplanepreview/discovery-groups/run-disco-group)
- [Budget schema](https://learn.microsoft.com/azure/templates/microsoft.consumption/budgets)
- [Budget filtering and notifications](https://learn.microsoft.com/rest/api/consumption/budgets/create-or-update)
- [Billable assets](https://learn.microsoft.com/azure/external-attack-surface-management/understanding-billable-assets)
