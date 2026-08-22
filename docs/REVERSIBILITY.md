# Reversibility and blast radius

Pawprint is designed so that adopting it is a decision you can walk back. This
page states exactly what it touches, what reverses cleanly, and what does not.

The guiding rule: **the tenant is not ours to change.** Pawprint creates one
application object and its service principal, and nothing else. Policy,
governance and directory configuration stay yours.

---

## What Pawprint creates

### In Microsoft Entra

| Object | Created by | Reversible | How |
|---|---|---|---|
| Application registration | `npm run setup` | Yes | Deleted, restorable 30 days, then purgeable |
| Service principal | `npm run setup` | Yes | Deleted with the application |
| App roles | `npm run setup` | Yes | Part of the application object |
| Federated identity credential | CI bootstrap | Yes | Deleted individually or with the application |

Every object is tagged `pawprint-managed` and `pawprint-instance:<id>`, so it is
findable even if the install manifest is lost.

### In Azure

| Object | Created by | Reversible |
|---|---|---|
| Run resource group | Platform baseline | Yes — one group per run, deleted whole |
| Scenario resources | Scenario infra | Yes — contained in that group |
| Evidence store | Optional module | **Partly.** See below |

### On disk

| File | Reversible |
|---|---|
| `config/deploy.config.json` | Yes |
| `.pawprint-install.json` | Yes |
| `.pawprint-local-admin.json` | Yes |

---

## What Pawprint deliberately does not touch

This list is enforced by design, not by convention:

- **Tenant-wide settings.** Never read-modify-write on directory configuration.
- **Conditional Access policies.** Setup recommends one. It never creates one,
  because policy is yours to own and an unexpected CA policy is an outage.
- **User consent settings** and the authorization policy.
- **Admin consent.** Never requested. See below.
- **Groups and memberships.** You assign your own existing groups, so your
  joiner-mover-leaver process keeps working untouched.
- **Other applications**, service principals, or their credentials.
- **Sign-in and audit logs.** Retained by Entra. Uninstall does not and must not
  erase the record that Pawprint was here.

### Why no admin consent

The admin application requests only `openid`, `profile`, `offline_access` and
`User.Read`. All four are user-consentable, so:

- No tenant-wide grant is created, so none has to be revoked
- No Global Administrator involvement is required to install **or** remove it
- A user consenting affects only their own account

This matters for reversal specifically. Revoking a tenant-wide admin consent grant
does **not** invalidate access tokens already issued under it; they remain valid
until they expire. Never granting it avoids that problem entirely.

---

## Reversing an installation

```bash
npm run uninstall              # what-if. Shows everything, changes nothing.
npm run uninstall -- --apply   # remove the recorded objects
npm run uninstall -- --apply --purge   # also empty the 30-day recycle bin
```

What-if is the default. There is no flag ordering that deletes something you have
not been shown first.

Uninstall reverses **recorded object ids** from `.pawprint-install.json`, never
display-name matches. Name matching risks deleting somebody else's similarly named
application; ids cannot be ambiguous.

If the manifest is lost, `--discover` finds objects by the `pawprint-managed` tag
instead. Untagged objects are never considered.

**Deleted applications remain restorable for 30 days.** Omit `--purge` and the
uninstall itself is reversible.

---

## Reversing Azure resources

One resource group per run is the blast-radius boundary. Deleting the group
removes everything the run created.

```yaml
jobs:
  reap:
    uses: ninjapaw/pawprint/.github/workflows/kit-reap-expired.yml@v1
    with:
      environment: dev
      apply: false        # report first
```

The reaper only considers groups tagged `pawprint.managed=true` with a
`pawprint.expiresAt` in the past, applies a grace period, and refuses to exceed
`max-deletions` in a single run — a large batch usually indicates a tagging or
clock problem rather than genuine expiry.

---

## What cannot be fully reversed

Being honest about this is more useful than pretending otherwise.

| Action | Why it does not fully reverse |
|---|---|
| **Creating a tenant** | Deleting a directory requires removing all subscriptions, applications and users first, and is subject to Microsoft's own retention. The wizard therefore refuses to create one silently and makes you do it deliberately. |
| **Enabling External ID on a tenant** | Tenant configuration, not an object. Practically speaking it is one-way. This is a reason to prefer your existing workforce tenant. |
| **Sign-in and audit log entries** | Retained by Entra under your policy. They should not be erasable, and Pawprint does not try. |
| **Tokens already issued** | Valid until expiry. Deleting the service principal stops new issuance; use `revokeSignInSessions` to cut existing sessions sooner. |
| **Immutable evidence blobs** | The point of a WORM policy is that a written pawprint cannot be deleted before its retention window expires. A **locked** policy cannot be shortened. Pawprint leaves the policy unlocked so a misconfigured window can be corrected; lock it deliberately once the retention period is confirmed. |
| **Defender plan activation** | Scenario runs can enable subscription-scoped Defender plans, which have billing implications beyond the resource group. Pawprint reports these but does not disable plans on teardown, because you may have enabled them for reasons unrelated to a scenario. Review them explicitly. |
| **Container images published to GHCR** | Deleting a published image breaks anyone who pulled that tag. Removal is manual and deliberate. |

---

## Production readiness checklist

Before promoting to a production tenant:

- [ ] Run `npm run setup` against a **non-production tenant first** and reverse it,
      to confirm the round trip works in your environment
- [ ] Confirm the app requests only the four user-consentable scopes
- [ ] Set `requireAssignment: true` and assign a group, not individuals
- [ ] Apply your own Conditional Access policy to the application
- [ ] Confirm `.pawprint-install.json` exists and is backed up somewhere your team
      can reach — losing it downgrades uninstall to tag discovery
- [ ] Choose the evidence store retention window before locking any policy
- [ ] Schedule the reaper with `apply: false` and review a week of reports before
      enabling deletion
- [ ] Confirm the run resource group naming does not collide with an existing group
