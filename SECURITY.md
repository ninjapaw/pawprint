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
