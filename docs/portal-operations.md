# PawPrint shared-services console

PawPrint already has an Astro portal, a loopback Node.js controller and a separate TypeScript Azure Functions API. This augmentation reuses them. It does **not** create a second site, application database, container service, React application or Starlight site.

This is local code and staged infrastructure, **not a deployment or approval record**. Previously observed public login and `/api/health` responses do not establish the current Azure SKU, a successful administrator login, backend isolation, a ready GitHub App, or healthy workloads.

## Reading the console

Open the existing portal for hosted use, or run `npm run portal:build` then `npm run portal` for the existing `127.0.0.1:4173` controller. The development deployment/setup controls remain separate from the shared console. Viewing and refreshing shared services never dispatches a workflow.

The console has shared-service, organization-workload and all-service views, development/production selectors, expandable source details, observation timestamps and workflow/request activity.

| Signal | What it means |
| --- | --- |
| Desired | Reviewed runtime configuration, not evidence of deployed resources. |
| Provisioning | ARM resource metadata. `Succeeded` is **not** application health or EASM coverage. |
| Azure availability | Resource Health's limited resource-level availability, when supported. |
| Application / coverage | Unknown unless there is an explicit observation. The portal's current authenticated API response is labelled only `api-observed`; no external application probes or EASM coverage checks are implied. |
| Workflow result | GitHub Actions result, not live Azure health. |
| DNS observed | NS answers for the fixed `ninjapaws.org`, `m365profiles.com`, and `sentineloptimizer.com` zones. Not Cloudflare account access or record-ownership verification. |
| Budget readiness | Presence/readability of an explicitly bound EASM budget, **not** spend/limit compliance. Amounts, contacts, notification settings and financial details are omitted. |

Missing bindings are `not-configured`; denied reads are `access-needed`; absent health is `unknown`. Source observations retain their timestamps, including on failures. The browser marks observations older than five minutes `stale`. Cached server reads are deduplicated per warm instance for up to 60 seconds, with bounded timeouts and no anonymous per-browser GitHub polling. Hidden tabs do not refresh sources. This is not a centralized telemetry pipeline or a guaranteed refresh SLA.

The three newer dojo/Pawton cards are catalog entries, **not** evidence their Azure resources are deployed. Their Azure observations remain unconfigured until the platform's approved mappings exist. Pawton `doctor` can invoke a write-capable Defender audit; it is not exposed as a read-only preview. PHP DNS/protection and Code-to-Cloud build/release/cost gates remain in their protected workflows. No new uninstall actions are added.

## Catalog and server-only bindings

`config/portal.json` remains the source for the four legacy development workloads. `steps` are still the local deploy sequence; `hostedActions` contains only the pre-existing extra legacy scenario actions. `config/portal-services.json` defines the fixed shared/new workload catalog.

Run:

```powershell
npm run portal:catalog
npm run portal:config:test
```

The generator writes `public/portal-public.json`, `api/src/catalog.generated.ts` and `schema/portal.sources.schema.json`. CI rejects stale projections. The browser projection contains no Azure resource IDs, subscription mappings, protected EASM configuration or credentials.

Supply `PORTAL_SOURCES_JSON` to the Function at runtime, or the portal Bicep `portalSources` parameter, using `config/portal.sources.example.json` as the shape. The example intentionally contains **no subscription GUIDs**, no enabled EASM workspace and no healthy observations. Runtime validation also checks:

* Service/environment IDs against the fixed catalog.
* Subscription references and resource groups against `config/platform.json`.
* The intentional legacy training-dojo production → **development** subscription mapping.
* Exact resource types; no arbitrary URLs, subscription scans, nested targets or proxy endpoints.

Supply real subscription IDs out of band after approval. Do not guess GUIDs. A future resource ID can express approved intended configuration, but a failed read still does not prove existence. New workloads missing platform mappings cannot bypass that check. Do not put Cloudflare tokens, `EASM_CONFIG_JSON`, budget contacts, GitHub private keys or other secrets in these bindings.

The API uses **ManagedIdentityCredential**, not Azure CLI, shell commands or developer-credential fallback. Optional `observationResourceGroups` Bicep entries grant metadata Reader only to explicitly approved resource groups, not subscriptions. They do not grant Key Vault secret access, log-query access, DNS write access, or an Azure role to portal users. Review each group scope; for narrower grants, provision the required read actions at each approved resource separately.

## Stage Entra workforce authentication intentionally

The default `config/portal-auth.json` is `legacy`. Existing provider-specific admin invitations and GitHub/Entra login choices are retained. New shared private routes fail closed until workforce and backend-trust setup is complete. Existing legacy-mode administration still depends on its existing linked-backend boundary; this change does not certify that live boundary. In workforce mode, the legacy admin/status and development-dispatch routes also require the verified boundary and workforce Admin role, so they cannot bypass the new role model.

Entra app roles, SWA application roles, and Azure RBAC are **three different mechanisms**. Signing in, an email suffix, `authenticated`, directory ownership, or a GitHub admin claim never automatically grants shared-console roles.

1. Review `config/portal-entra-app.manifest.json` with a tenant administrator. Create/use a **dedicated, single-tenant workforce** registration (`AzureADMyOrg`), not PawPrint's multi-tenant public publisher registration. Enable **assignment required** on its enterprise application. Assign the minimum app role to approved users/groups: `PawPrint.Reader`, `PawPrint.Operator`, or `PawPrint.Admin`. No script in this augmentation performs tenant mutations.
2. Confirm the existing site's callback URL, approved tenant ID and workforce app client ID. Set those non-secret IDs in `config/portal-auth.json`, select `workforce`, and set `migrationReviewed: true` only as an intentional configuration review. This is not proof sign-in works.
3. Review the portal Bicep. It reuses the existing SWA and optionally creates a **SWA-only user-assigned managed identity**. Do not assign that identity to the Function, another site or any other resource.
4. After a separately authorized infrastructure application, use the identity's **object ID** as the federated credential subject on the workforce app, the approved tenant issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`, and audience `api://AzureADTokenExchange`. Bicep outputs a proposed credential object, but does not create it in Entra.
5. On SWA, `PORTAL_ENTRA_CLIENT_ID` holds the workforce **app registration** client ID. `OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID` holds **only the SWA-assigned managed identity's client ID**, never the app registration's ID or a secret. Bicep merges these with existing SWA app settings rather than discarding unrelated settings. The build sets `clientSecretSettingName` to that exact managed-identity setting and uses a tenant-specific v2 issuer.
6. Configure and verify backend isolation as below. SWA validates the configured tenant-specific issuer and app audience during login. Inside the trusted, externally inaccessible roles-source callback, the API requires `aad`, the exact tenant claim and an explicit `PawPrint.*` app-role claim before mapping to `reader`, `operator`, `admin`. SWA's documented callback payload need not contain raw JWT `iss`/`aud` fields; when supplied, these must also match. Missing tenant/app-role or conflicting claims yield **no roles**. Verify the actual provider's tenant and app-role claim contract before rollout. Do not replace it with an email-domain check or log tokens/PII to investigate.
7. Only after federation, role mapping, backend setup and rollback have been reviewed, set the protected deployment variable `PAWPRINT_WORKFORCE_AUTH_READY=true`. The frontend workflow refuses workforce rollout without it. Workforce builds show only Entra login, block GitHub login, and allow the three assigned SWA roles. Roles-source mode ignores invitations; invitation capacity is not an organization-wide entitlement model.
8. Verify real allowed/denied users, cross-tenant denial, role downgrade, roles-source external inaccessibility and direct-host denial in an authorized staging/rollout window. None is claimed verified by local tests. Keep the prior legacy build/config and invitations for a deliberate rollback; switching modes does not delete invitations. Do not remove previous auth credentials until the approved replacement works.

Build-time auth changes affect the generated `dist/staticwebapp.config.json`, not the running service. Frontend and backend rollout must be coordinated; changing only the frontend can lock users out.

### Preview the development rollout without applying or publishing

The API workflow has an explicit `preview-only` input. When selected it
validates/packages the source, authenticates with the infrastructure identity,
and runs `what-if`, but never applies infrastructure or publishes API code.
The existing automatic development publication behavior is unchanged.
Both frontend and API deployment jobs are restricted to `refs/heads/dev`,
including manual invocations. A feature-branch run cannot acquire the protected
deployment identity or publish to the development site. Pull-request CI instead
runs the portal checks/build, API tests/build, and compiled portal IaC assertions
without deployment credentials.

```powershell
# Only after GitHub CLI has SSO-authorized access and the reviewed code is on dev:
gh workflow run deploy-portal-api.yml --repo ninjapaw/pawprint --ref dev -f preview-only=true -f deploy-infrastructure=false
```

Every infrastructure application now previews the same inputs first.
The workflow compiles both the template and Bicep parameters to JSON before
adding reviewed CLI overrides; it does not mix a `.bicepparam` file with inline
overrides.
The preview guard rejects resource deletions, unsupported/incomplete, or out-of-group
changes. It publishes only resource IDs/change types to logs, not app-setting
values or full resource payloads. The detailed report stays in runner temporary
storage. Preview success is not approval to deploy or proof of tenant access;
review policies, scope and cost before a separately approved application.
`Ignore` also fails this guard: Azure uses it both for unmanaged resources and
when nested-template expansion is incomplete. Do not filter these entries out or
treat a partly expanded preview as complete; review them explicitly before
extending the guard for any known unmanaged resource.

### Match the Function runtime before publishing

The API publication job verifies the selected Azure Function resource and its
actual runtime before uploading the package. The runtime must be Node and match
the major version pinned in `.node-version`; both package engine declarations
must remain aligned with that pin. An older or unverifiable runtime blocks
publication with an explicit error. Apply the reviewed portal IaC upgrade first
when moving an existing host to Node 24; a successful local build is not evidence
that the live host has already been upgraded.
The Function IaC reads its runtime major directly from `.node-version`, and
compiled-template assertions check that it matches both package engine pins.

The same check validates Azure's `defaultHostName` and supplies that origin to
the direct-host isolation probes. Neither probe uses a guessed hostname.
A direct-host HTTP 400 or an application setup HTTP 503 does not satisfy the
required platform 401/403 denial.
Probes have bounded connection/response timeouts and transient retries for
scale-to-zero startup; a retry never changes the required health or denial codes.

## Verify the backend boundary before private shared status

`x-ms-client-principal` is **not signed user evidence by itself**. A caller can forge it on an unprotected direct Function URL. Origin checks are CSRF protection, not authentication.

Use the existing Standard SWA linked backend and App Service Easy Auth v2's **Azure Static Web Apps (Linked)** provider. Backend public networking remains necessary for this supported integration; this is not private-endpoint isolation. Require authentication, deny anonymous API access with 401/403, permit only the exact linked SWA provider, and keep only `/api/health` as a minimal anonymous exception.

`linkedBackendClientId` is the non-secret client ID actually configured by Azure's linked-provider integration. Inspect and pin the generated value; **do not guess it is a hostname or reuse the workforce app ID**. With it blank, the template does not overwrite existing provider settings and shared access remains closed.

`enableBackendVerification` optionally grants the Function identity Reader on **itself and the existing SWA only**. At runtime, the API:

* Checks the configured Function ID against its platform site/resource-group identity.
* Reads current Function `authsettingsV2` and SWA `linkedBackends/production` via managed identity.
* Verifies the exact pinned provider, linked Function ID, required HTTPS/authentication, no alternate enabled providers and no private-route auth exceptions.
* Fails closed if these reads fail, configuration is absent, or isolation is not verified. Source JSON flags cannot declare the boundary verified.

The configuration check is cached for up to 60 seconds; Azure's provider remains the per-request cryptographic enforcement boundary. Header decoding is only used **inside** that boundary. The deployment verification requires direct forged-header probes to return platform 401/403; an application 503 setup response is **not** proof of isolation. Do not deploy these changes or enable private sources solely because local header fixtures pass.

## Reviewed EASM workflow requests

Reader is status-only. Operator can review/request fixed `validate`, `plan`, `what-if`, `discovery-plan`, and `verify` workflows. Admin can explicitly request `register-provider`, `deploy`, `discovery-apply`, and `run-discovery`. Existing GitHub Environment approvals and CLI cost/write/discovery gates remain final authority.

New shared dispatch defaults **off**. Its prerequisites are:

* Verified workforce authorization and linked-only backend boundary.
* A dedicated narrowly installed GitHub App with metadata read/Actions write on the approved repositories. The API mints short-lived repository-scoped read/write tokens. During preview it verifies it can mint the write-scoped token and read an **active** fixed workflow; no workflow is dispatched by that check. Merely having an app ID is not proof of a ready installation; no secrets/contents/admin permissions are requested.
* An approved enabled EASM runtime binding, `PORTAL_SHARED_ACTIONS_ENABLED=true`, and the selected environment in `PORTAL_EASM_REVIEWED_ENVIRONMENTS`. The environment list declares an operator review of the current protected configuration; the API cannot inspect or certify the secret's contents.
* `enableOperationRecords=true` and private `portal-operation-records` in the **existing Function storage**, accessed with managed identity. If storage/app/configuration readiness cannot be established, use the explicit protected GitHub workflow link instead.

### Explicit GitHub App setup profiles

Yes: adding `pawprint` or newer repositories to the installation while auditing with the default **legacy** profile is rejected as extra access. That default remains exactly the original four repositories. Do not bypass the validator or switch the installation to **all repositories**.

`config/portal-github-app.json` supplies a separate **hosted-shared** desired profile. Its initial selected set is the existing four plus `pawprint`; this is desired configuration, **not** a changed installation. Its App name matches the existing dedicated App so a deliberately expanded installation can be reused without renaming it. For a separately created App, explicitly review/set its unique name in this profile.

The hosted profile requires `pawprint` for EASM. Edit its `repositories` array to the exact reviewed selection:

* Keep the original four if the same installation must continue serving legacy controls/status.
* Optionally add `pawton`, `php2shell-cloud-defense-dojo`, and `code-to-cloud-security-dojo` for their workflow observations. They are **not** automatically selected. Unselected repositories remain access-needed, not healthy.
* An EASM-only App may explicitly select just `pawprint`, accepting that other workload observations/actions will lack installation access.
* Only repositories already in the fixed portal catalog are accepted. Missing required access, duplicates, unknown repositories, additional App permissions, webhooks, a foreign owner or all-repository installation access fail validation. Both profiles retain only Actions write and metadata read; API tokens remain downscoped by repository and read/write purpose.

Review the desired profile offline, with no credential access or network calls:

```powershell
npm run portal:github-app:profile
npm run portal:github-app:profile -- --profile hosted-shared
```

The output says `liveInstallationVerified: false`. Optionally pipe a credential-free JSON snapshot with `appDetails`, `installation`, and repository-name array `repositories` into the same command with `--audit-stdin`; a mismatch exits nonzero. This validates a **supplied snapshot**, not live readiness. Never include private keys/tokens in snapshots.

After separately reviewing and manually selecting the exact repositories in GitHub, use the existing loopback **Audit installation / Audit and enable** path with the same explicit profile:

```powershell
# Opt-in for this controller process; does not change GitHub or Azure by itself.
$env:PAWPRINT_GITHUB_APP_PROFILE = 'hosted-shared'
npm run portal
```

Alternatively, deliberately change `defaultProfile` in the configuration after review. Leaving it unchanged/unsetting the override keeps legacy mode. The controller fixes the profile at startup; browser input cannot choose an App profile or arbitrary repositories. Its manifest, fresh authenticated installation audit, callback validation, readiness repository list and enable path all use that same desired profile. Reusing an App goes through **Audit and enable**, not App recreation. The existing local controller still needs its existing authorized CLI sessions for a real audit/enable; the offline profile command does not.

A real audit uses the dedicated App's authenticated GitHub metadata and installation repository list. Enable remains blocked unless the App owner/name, exact least-privilege permissions, no webhooks, selected-repository mode and exact desired set match. Rerun that audit after installation changes. Selecting a profile does not expand an installation, grant roles, create/enable an App, or enable the separate Entra/backend-trust/Blob/EASM request gates. No live installation, credentials or permissions were changed here.

### New workload Azure scope mappings are declarative

The three new workload entries are **not hard-coded as permanently unbindable**. Their currently empty approved groups come from missing declarations in `config/platform.json`, not a special parser prohibition.

For each exact catalog key (`pawton`, `php2shell-cloud-defense-dojo`, `code-to-cloud-security-dojo`), supply reviewed `repositories[<key>].environments.dev` and/or `.prod` declarations with its actual `resourceGroup`, optional `additionalResourceGroups`, and the approved existing `subscriptionRef` mapping where needed. No real groups, subscription references or GUIDs are inferred by this guide.

Then run `npm run portal:catalog` and `npm run api:build` to regenerate/package the **server-only** binding hints, and supply corresponding approved subscription GUIDs/resource IDs in `PORTAL_SOURCES_JSON`. Review the MI read grants separately. This changes declarative inputs and generated artifacts, **not hand-written parser/observer code**. Existing catalog resource-type restrictions and supported read APIs still apply. Until those reviewed values exist, the cards remain unconfigured; no platform mappings or resource IDs were invented for this augmentation.

A preview is a deliberate operator action: it stores a small private record but sends no GitHub request. It expires after 15 minutes. Confirmation explicitly discloses that **current protected `EASM_CONFIG_JSON`** is used, not a scope snapshot. No browser seed, budget, arbitrary workflow, ref, repository, target URL, subscription or secret editor exists. Writes and discovery require separate confirmations.

The server generates the UUID. Conditional Blob creation and a Blob lease provide cross-instance serialization. Before sending to GitHub, the API durably records `requesting`. A replay returns the same record; it does not dispatch again. A crash, timeout, ambiguous GitHub response or failed final persistence returns **uncertain**, never an automatic retry. Check the same request ID before any new intentional request.

Only `shared-easm.yml` receives `request_id`; legacy workflows do not. The branch is fixed to `dev` for development and `main` for production. HTTP 202 means a request was accepted/recorded, **not** that a run started or completed. Correlation checks the fixed workflow/ref and exact `Shared EASM - <environment> - <operation> - <UUID>` title in the latest 50 runs. A missing match is not proof the run does not exist, and does not authorize replay.

The activity feed shows workflow observations and the current browser session's requests. It is not a comprehensive audit-retention product. Private Blob records survive API instances; correlation can be checked with the known UUID. Logs contain UUID/action/environment/state, not tokens, private configuration or user identity. No secret value is fetched from GitHub or Cloudflare.

Operation records have no automatic lifecycle rule in this augmentation, so unrelated account lifecycle rules are not overwritten. Apply any approved retention policy **only** to `portal-operation-records/`; retain records through the organization's audit/retry window. Deleting a record does not authorize reusing its UUID or replaying an uncertain request.

## Cost and infrastructure trade-off

Keep the existing **SWA Standard + linked Flex Consumption Functions** architecture. The planning retail snapshot for Central US put Standard's base at approximately **USD 9/app/month**. This is not an all-in bill, price promise, verified deployed SKU, or account-agreement quote. Functions, mandatory runtime/deployment storage, Key Vault, logs and any enabled EASM are separately metered; grants, regional pricing and existing commitments remain unverified.

The template retains 512 MiB Flex instances, zero always-ready instances, existing LRS storage, disabled shared keys/anonymous blobs and managed-identity storage access. Node 24 aligns with the API package and current supported Flex runtime. The documented storage `SecurityControl=Ignore` network-policy exception is retained because the runtime/publication path lacks a private runner path; it does not grant anonymous data access.

No application database is introduced, but Functions runtime storage is mandatory. Optional private operation records reuse it. Free SWA cannot retain this linked backend and custom tenant-specific authentication unchanged. Free static hosting plus a separately bearer-secured API would be a **different auth migration**, not a free toggle. Container Apps scale-to-zero might reduce a theoretical idle floor but adds migration and operational complexity without a concrete need here.

No live provisioning, paid Defender plan activation, scan/discovery, DNS write, provider registration, deletion, role grant, push or deployment was performed for this augmentation.

## Local validation

```powershell
npm run portal:config:test
npm run api:test
npm run api:build
npm run portal:check
npm run portal:build
npm run portal:test:e2e
# On Windows an already-installed isolated Edge test channel can be used:
# $env:PAWPRINT_TEST_BROWSER_CHANNEL = 'msedge'
# Supply an existing Bicep CLI path if it is not on PATH:
$env:BICEP_BINARY_PATH = 'C:\approved-tools\bicep.exe'
npm run portal:infra:check
```

Browser tests use explicit synthetic authenticated-source fixtures and an isolated loopback Astro preview server, not the administrative controller. They require no Azure/GitHub CLI session and cannot run the controller's cloud recovery/setup routines. They are not live Azure, Entra, GitHub App, Blob authorization or DNS ownership tests. Live IDs, role assignments, federation, protected secret readiness and direct-host isolation still require an independently authorized setup and verification.

### Authoritative setup references

* [SWA custom authentication and managed-identity federation](https://learn.microsoft.com/azure/static-web-apps/authentication-custom)
* [Bring your own Functions: linking and security constraints](https://learn.microsoft.com/azure/static-web-apps/functions-bring-your-own)
* [SWA principal data: API headers do not carry the custom claims array](https://learn.microsoft.com/azure/static-web-apps/user-information)
* [Functions supported Node.js runtimes](https://learn.microsoft.com/azure/azure-functions/supported-languages)
