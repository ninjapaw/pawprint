# Identity and access

Pawprint has three planes with deliberately different security postures. Conflating
them is the most common way a tool like this gets compromised.

| Plane | Exposure | Authentication | Backend |
|---|---|---|---|
| **Pawprint viewer** | Public or static hosting | None | None |
| **Setup and admin console** | Loopback only | Entra, or a generated local credential | Local process |
| **Hosted team console** | Internal network | Entra with app roles | Yes |

The viewer renders evidence and stores nothing. It has no accounts because it has
no state worth protecting. Do not add auth to it.

The admin console configures deployments and manages runs. It binds to
`127.0.0.1` by default and is not designed to be published to the internet.

---

## Recommendation: use your existing workforce tenant

**Do not create an External ID tenant for the admin console.** External ID is a
CIAM product for consumer-facing applications. A security tool's admin console is
a workforce application, and the feature gaps are disqualifying.

| Capability | Workforce tenant | External tenant |
|---|---|---|
| Audit and sign-in log retention | Configurable, exportable to Monitor/SIEM | **7 days** |
| Entra ID Protection (risk detection) | Yes | **Not available** |
| Entra ID Governance and PIM | Yes | **Not available** |
| Conditional Access conditions | Sign-in risk, user risk, device platform, location, client app, device filters | **Location and device platform only** |
| Conditional Access grant controls | Full, including compliant and hybrid-joined device | **Block, MFA, password reset only** |
| Conditional Access assignment | Target specific users and groups | **All users, with exclusions only** |
| App secret and certificate policies | Enforceable | **Not available** |
| Directory roles for app management | Full set | **Cloud Application Administrator only** |
| Pricing | MAU billing for **guests only** | MAU billing for **all users, any role** |

Two of these decide it.

**Seven-day log retention** is incompatible with a tool whose premise is durable
audit evidence. Your admin sign-in trail would expire before a monthly access
review.

**MAU billing for every user** means you pay per active admin, in a directory that
gives you less security control than the one you already own.

External users do not require an External ID tenant. Invite them as **B2B guests
into your workforce tenant**: they get full Conditional Access, Identity
Protection applies, and MAU billing covers guests only.

---

## Authentication modes

### `entra` — recommended

Workforce tenant, app registration, app roles.

- Authority: `https://login.microsoftonline.com/<tenantId>`
- Flow: authorization code with PKCE; device code for headless setup
- Sign-in inherits every Conditional Access policy, MFA requirement, PIM
  assignment, device compliance rule and Identity Protection signal you already
  operate
- No new tenant, no new billing, no parallel identity lifecycle

App roles carried as claims:

| Role | Grants |
|---|---|
| `Pawprint.Admin` | Configure identity, sinks, environments, and destructive operations |
| `Pawprint.Operator` | Deploy, remediate, and destroy runs |
| `Pawprint.Reader` | View pawprints and configuration |

Set `requireAssignment: true` so only assigned users and groups can sign in, and
assign roles to **groups**, not individuals, so your existing joiner-mover-leaver
process governs access without anyone touching Pawprint.

### `local` — fallback

For air-gapped environments, evaluation, or operators with no Azure access.

The setup wizard generates a high-entropy credential, prints it exactly once, and
stores only a salted hash. There is no default credential and no recovery path
other than regenerating.

Non-negotiable properties:

- Binds to `127.0.0.1`. Changing `bindAddress` prints a warning.
- Session cookie is `HttpOnly`, `SameSite=Strict`, and expires per `sessionMinutes`.
- Never exposed through a tunnel, reverse proxy, or port forward. If you need
  remote access, use `entra`.

This mode is convenient, not secure. It exists so Pawprint works without Azure,
not so you can skip identity.

### `entra-external` — advanced, discouraged

Supported for adopters who have already standardised on an External ID tenant.
Accept the limitations in the table above knowingly. Authority becomes
`https://<tenant>.ciamlogin.com`.

---

## Setup wizard flow

`node scripts/pawprint-setup.mjs`

Every prompt shows a recommended default in brackets. Pressing Enter accepts it.

**1. Detect.** Reads the signed-in Azure context: subscription, its home tenant,
and the current user. Enumerates every tenant the identity can see, including
external tenants, and marks the one bound to the subscription as the default.

**2. Choose directory.** Lists detected tenants and offers:

```
  [1] Contoso                        contoso.onmicrosoft.com   (bound to subscription)  <- default
  [2] Contoso Partners               partners.onmicrosoft.com
  [3] Contoso Customers (external)   contosoext.ciamlogin.com
  [n] Create a new tenant
```

Creating a tenant is **guided, not silent** — it has billing and governance
consequences that should not happen because someone held Enter. The wizard
explains the tradeoff, links the comparison above, and confirms explicitly.

**3. Check permissions.** Probes whether the signed-in identity can create an app
registration and grant admin consent, and reports precisely which role is missing
rather than failing at the first write. Application Administrator or Cloud
Application Administrator is sufficient; Global Administrator is not required and
is not requested.

**4. Register the application.** Creates the app registration, defines the three
app roles, sets `requireAssignment`, and configures redirect URIs for loopback.

Credentials, in preference order:

1. **Federated identity credential** — no secret exists to leak or rotate. Used
   for CI, where GitHub OIDC already provides the assertion.
2. **Certificate** — for a hosted console.
3. **Client secret** — offered only if neither is possible, written to Key Vault,
   never to config, never echoed to the terminal.

**5. Write configuration.** Non-secret values (`tenantId`, `clientId`, `authority`)
go to `config/deploy.config.json`. These are identifiers, not secrets. Nothing
sensitive is written to disk.

---

## GitHub integration

Two different things get conflated here. They are not the same.

### GitHub as a sign-in method — not recommended

Do not add GitHub as a direct identity provider for the admin console. If your
organisation federates GitHub Enterprise with Entra via SAML or OIDC SSO, your
users **already** sign in with Entra, and Entra remains the single front door
where Conditional Access, MFA and Identity Protection apply. Adding GitHub as a
parallel IdP creates a second door that bypasses all of it.

The exception is an organisation with no Entra tenant at all, where GitHub is the
only real directory. In that case `local` mode plus GitHub Enterprise SSO in front
of your own reverse proxy is more honest than pretending Pawprint has federation.

### GitHub App for repository actions — recommended

A GitHub App is **resource authorization**, letting Pawprint act on repositories:
read Actions runs, open promotion pull requests, sync environment variables,
publish scenario images. This is orthogonal to how a human signs in.

Prefer a GitHub App over a personal access token: scoped per-installation
permissions, short-lived tokens, no individual's credentials, and an audit trail
attributed to the app.

---

## What you gain and lose

### Without Entra (`local` mode)

Works: full deployment, scenarios, evidence generation, viewer, CI.

Lose: single sign-on, MFA, Conditional Access, device compliance, Identity
Protection, PIM, per-user attribution in audit logs, group-based roles,
centralised revocation. Access is one shared credential, so "who ran this" degrades
to "someone with the credential", which weakens every pawprint that machine emits.

Suitable for: evaluation, air-gapped labs, single-operator use.

### With Entra

Gain: everything above, plus per-user attribution in the pawprint `origin.operator`
field, and revocation that happens in your directory rather than in this tool.

Cost: an app registration and a role assignment. No new tenant, no new licence.

### Without the GitHub App

Works: everything, driven by GitHub Actions workflows.

Lose: opening promotion pull requests from the console, syncing environment
variables from config, reading run status in the admin console, publishing scenario
images from the console. All remain available through workflows.

### With GitHub Enterprise SSO federated to Entra

Gain: one identity across the repository and the console, with your Conditional
Access applying to both. Offboarding in Entra removes both at once.

Not required. Pawprint never assumes it.

---

## Evidence storage

Pawprints are JSON. That is the format, always — portable, diffable, schema
validated, readable with no server. Where they are *kept* is configurable.

| Sink | Durability | Use |
|---|---|---|
| `file` | Machine-local | Always on; works air-gapped |
| `githubArtifact` | Repository retention window | Convenient in CI; **not** a system of record |
| `azureBlob` | Durable, optionally immutable | Recommended system of record |

For anything you intend to treat as evidence, use `azureBlob` with `immutable:
true`. A time-based retention policy means a written pawprint cannot be altered or
deleted until it expires — which is the difference between a log and evidence.
Choose `retentionDays` to match your audit obligation, because once a policy is
locked it cannot be shortened.

Set `redactBeforeUpload: true` when the store is shared more widely than the
subscription owners.

Deploy the store with `modules/evidence-store/main.bicep`. It writes via managed
identity with **Storage Blob Data Contributor**, which permits create and read but
not delete, so the runner cannot destroy its own evidence.
