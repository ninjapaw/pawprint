# Connectors

Pawprint connects to three environments. Each is optional, each has permission
tiers, and each unlocks specific capabilities. Nothing is requested until a
capability you enabled actually needs it.

```bash
node scripts/pawprint-connect.mjs                      # detect what is present
node scripts/pawprint-connect.mjs --connector microsoft365
node scripts/pawprint-connect.mjs --plan microsoft365=read,azure=write
```

`--plan` models the consent cost and resulting capabilities **without requesting
anything**. Use it to have the permissions conversation with your directory admin
before touching the tenant.

---

## The two rules

**One app registration does not get the union of every permission.** Requesting
everything up front is how an admin ends up refusing all of it. Consent is
incremental and per-tier.

**Delegated beats application.** A delegated permission means the connector acts
as the signed-in user and can never exceed what that person can already do — your
RBAC, PIM and Conditional Access still bind it. An application permission is
standing access that ignores all of that. Application permissions appear in
exactly one tier (`microsoft365=admin`), exist only for unattended polling, and
the planner warns whenever a plan includes one.

---

## Tiers

Tiers are cumulative: `write` includes `read`.

| Tier | Meaning |
|---|---|
| `none` | Connected for identity only, or not connected |
| `read` | Observe. Cannot change anything |
| `write` | Act within the intended blast radius |
| `admin` | Elevated. Either app-only standing access, or the ability to grant roles |

Pick the **lowest tier that unlocks what you need**. The capability matrix tells
you exactly what each one buys.

---

## Microsoft 365 and Entra

Detected by reading your own organisation from Graph — a probe that needs nothing
beyond sign-in.

| Tier | Permissions | Consent |
|---|---|---|
| `none` | — | User (sign-in only) |
| `read` | `SecurityEvents.Read.All`, `SecurityIncident.Read.All`, `AuditLog.Read.All` (delegated) | **Admin** |
| `write` | adds `SecurityEvents.ReadWrite.All`, `SecurityIncident.ReadWrite.All` (delegated) | **Admin** |
| `admin` | `SecurityEvents.Read.All` (**application**) | **Admin** |

Graph security scopes require admin consent even when delegated. That is a
Microsoft requirement, not a Pawprint one. Delegated still constrains the
connector to the signed-in user's own access, so it remains the better choice.

`read` is the useful tier: it is what makes detect-stage evidence real rather
than assumed. Without it, detection assertions honestly report `unknown`.

---

## Azure

| Tier | Role | Scope |
|---|---|---|
| `read` | Reader | Approved subscription |
| `write` | Contributor | **Run resource group**, not the subscription |
| `admin` | Role Based Access Control Administrator | Run resource group |

`write` is deliberately scoped to the run's own resource group so the permission
matches the blast radius.

`admin` exists only for scenarios that pull images with a managed identity. It
can grant other roles, so it is a privilege-escalation path. **Avoid it** by
publishing scenario images to GHCR, which is the recommended path anyway.

### Approved subscriptions

Deployment is restricted to an explicit allowlist and **fails closed**:

```json
{
  "defaults": {
    "approvedSubscriptions": ["00000000-0000-0000-0000-000000000000"]
  }
}
```

- A subscription absent from the list is refused before any resource is touched
- An **empty or missing** list approves nothing, rather than approving everything
- Matching is case-insensitive; malformed ids are rejected by the schema

Enforced at preflight:

```bash
node scripts/pawprint-config.mjs --environment dev --subscription <id>
```

---

## GitHub

Works with personal, Pro, Team and Enterprise accounts. A **GitHub App** is
preferred over a personal access token: permissions are scoped per installation,
tokens are short-lived, no individual's credentials are involved, and the audit
trail attributes actions to the app rather than a person.

| Tier | Permissions |
|---|---|
| `read` | `metadata:read`, `actions:read`, `contents:read` |
| `write` | adds `pull_requests:write`, `packages:write` |
| `admin` | adds `environments:write` |

`admin` can change environment variables, which can gate deployments — so it is
effectively deployment-configuration control. Sync variables by hand if that is
more than you want to grant; drift detection still reports mismatches.

**GitHub Enterprise** changes nothing about the App model. If your organisation
federates GitHub Enterprise to Entra for SSO, users already sign in through
Entra, so Conditional Access covers both the repository and the console, and
offboarding in Entra removes both at once. Pawprint never assumes this.

Note that GitHub is **not** a sign-in method for the admin console. See
[IDENTITY.md](IDENTITY.md) for why adding it as a parallel identity provider
would create a second door around your Conditional Access.

---

## Capability matrix

Every capability declares what it needs and what happens without it. A capability
with unmet requirements is unavailable **and says why**, rather than failing at
the point of use.

| Capability | Requires | Without it |
|---|---|---|
| `evidence.detection-alerts` | `microsoft365=read` | Detect assertions report `unknown` |
| `evidence.audit-attribution` | `microsoft365=read` | Local operator name only |
| `remediate.close-alerts` | `microsoft365=write` | Alerts left for an analyst |
| `detect.scheduled-poll` | `microsoft365=admin` | Slow detections report `unknown` |
| `verify.control-plane` | `azure=read` | Runtime and HTTP evidence only |
| `deploy.scenario` | `azure=write` | Validation and rendering only |
| `deploy.managed-identity-pull` | `azure=admin` | Use GHCR instead |
| `reap.expired-runs` | `azure=write` | Manual teardown |
| `evidence.workflow-runs` | `github=read` | No CI correlation |
| `promote.pull-request` | `github=write` | Run the workflow from GitHub |
| `config.sync-variables` | `github=admin` | Set variables by hand |

Nothing here is required. With no connectors at all, Pawprint still validates
scenarios, resolves configuration, and renders pawprints.

---

## Recommended starting point

```json
{
  "defaults": {
    "connectors": { "microsoft365": "read", "azure": "write", "github": "read" }
  }
}
```

Six of eleven capabilities, every permission delegated, nothing app-only, and
Azure write scoped to the run resource group. Raise a single tier later if a
specific capability justifies it.

## Disconnecting

Connector grants are part of the application object, so
`npm run uninstall -- --apply` removes them with it. Lowering a tier is a
configuration change; revoking a consent grant already made is done in Entra, and
note that revocation does not invalidate tokens already issued — they remain
valid until expiry. See [REVERSIBILITY.md](REVERSIBILITY.md).
