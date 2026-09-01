# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub Security Advisories on
this repository. Do not open a public issue for an unpatched vulnerability.

Include the affected version or commit, reproduction steps, and impact. Expect an
acknowledgement and a remediation plan or rejection rationale.

## Scope

Pawprint is deployment and evidence tooling. In scope: the runner, schemas,
reusable workflows, Bicep modules, bootstrap scripts, and the viewer.

Scenario content lives in consuming repositories. Some scenarios provision
**intentionally vulnerable** infrastructure by design. A scenario behaving as its
manifest declares is not a vulnerability in Pawprint. A scenario that exceeds its
declared blast radius, ignores its TTL, or fails to tear down **is**.

## Handling pawprints

A pawprint is an evidence artifact. Unredacted, it may contain subscription IDs,
tenant IDs, resource IDs, hostnames, and the operator identity.

- `output/` and `*.pawprint.json` are git-ignored by default. Keep it that way.
- Use `--redact` before sharing a pawprint outside your organization.
- The viewer runs entirely client-side and transmits nothing.

## Credentials

Pawprint authenticates to Azure with GitHub OIDC federated credentials. It never
requires a long-lived client secret. Report any code path that appears to
require, log, or persist one as a vulnerability.

## Safe deployment and operations

- Use PawPrint only in tenants, subscriptions, organizations, repositories,
  domains, and accounts you are authorized to manage.
- Review Bicep what-if and provider authorization before apply. Treat
  delete/re-create, disable, remove, and credential rotation as separate
  changes requiring recovery planning and verification.
- Prefer least-privilege roles such as Security Reader, Security Admin, Cloud
  Application Administrator, and Groups Administrator at the narrowest scope.
  Do not use Owner or Global Administrator for routine operation.
- Test intentionally vulnerable scenarios in isolated non-production
  subscriptions and confirm TTL-based cleanup independently.
- Treat cost, licensing, compliance, and security output as decision support,
  not as an invoice, entitlement decision, certification, or guarantee.

## Data and privacy

The local portal uses the operator's existing Azure, Microsoft Graph, GitHub,
and configured provider sessions. Local setup plans and pawprints may contain
tenant, subscription, resource, hostname, cost, and operator identifiers.
Never commit or publicly share unredacted artifacts.

PawPrint does not add advertising analytics. The hosted portal uses Azure Static
Web Apps authentication, which can set cookies necessary for sign-in. Review
provider privacy and retention behavior before connecting customer or regulated
environments.

## Incident response

If a deployment may have exposed credentials, data, or public access, stop the
affected workflow, preserve audit evidence, revoke or rotate credentials in
every provider, contain exposed resources, and follow your organization's
incident-response process. Removing an Azure connector does not necessarily
revoke authorization or retained data in GitHub, Azure DevOps, GitLab,
Cloudflare, AWS, GCP, or another provider.
