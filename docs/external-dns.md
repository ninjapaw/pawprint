# External DNS ownership

Pawprint treats a custom domain as one deployment with two provider ownership
boundaries. The boundary is deliberate: Azure resources remain declarative
Bicep, while an external DNS provider receives only the records required to
prove and route the hostname.

## Shared framework

These files are owned by Pawprint and can be vendored into another repository:

| Surface                             | Responsibility                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `modules/static-site/main.bicep`    | Deploy the Azure Static Web App and declare its DNS-validated custom-domain resource. |
| `scripts/connect-cloudflare-dns.sh` | Bootstrap validation and reconcile the Cloudflare TXT and CNAME records.              |
| `scripts/cloudflare-dns.mjs`       | Shared ownership-scoped DNS reconciliation for Static Web Apps, App Service, Front Door, and explicit platform records. |
| `modules/front-door-waf/main.bicep` | Bootstrap a managed-TLS custom domain and associate it with routing and WAF only after validation. |
| `scripts/vendor-sync.mjs`          | Synchronize shared source and verify content-hashed DNS-only snapshots offline.       |
| `schema/deploy.config.schema.json`  | Define provider-neutral DNS configuration without credentials.                        |
| `config/connectors.catalog.json`    | Declare permission tiers and the least-privilege Cloudflare token contract.           |
| `/setup/cloudflare/`                | Verify, store, and report credential readiness from the loopback admin portal.        |

Cloudflare does not expose its DNS records as Azure Resource Manager resources,
so Bicep cannot deploy them directly. An Azure deployment script would still
call the Cloudflare API but would add a storage account, container instance,
managed identity, and another secret path. Pawprint avoids those permanent
Azure resources for two DNS records.

The deployment therefore runs in three phases:

1. Bicep deploys or previews the Azure Static Web App.
2. The provider connector obtains Azure's validation token and reconciles the
   Cloudflare `_dnsauth` TXT and DNS-only CNAME records.
3. Bicep deploys again with `customDomainName`, adopting and converging the
   Azure custom-domain resource after DNS validation succeeds.

## Repository-owned configuration

Each consuming repository owns only its domain intent and invocation:

- `customDomain` and `publicSiteUrl` per environment.
- `dns.provider` and `dns.zoneName` in `config/deploy.config.json`.
- A GitHub Environment secret named `CLOUDFLARE_API_TOKEN`.
- The infrastructure workflow call that runs the shared connector between the
  base Bicep deployment and final Bicep convergence.

Each application integration manages only its validation TXT and DNS-only CNAME.
Pawprint does not change zone settings, nameservers, proxying, Cloudflare WAF,
Workers, TLS settings, registrar state, or unrelated records. Public zones in
`platform/org-dns.bicep` remain optional and disabled; this integration does not
move authority from Cloudflare to Azure DNS.

## Cross-repository ownership

Share the provider implementation, not overlapping declarations of application
records. Each application owns its hostname intent and Azure domain resource.
Only genuinely shared platform aliases belong in a reviewed Pawprint record
manifest. No shared apex, mail, or verification records have been invented or
imported from a live account.

| Repository | Domain integration |
| --- | --- |
| Pawprint | Canonical reconciler, provider contract, and explicitly declared shared records. |
| Pawton | Existing App Service `asuid` TXT, direct CNAME, Bicep hostname binding, and managed SNI certificate. |
| PHP2Shell dojo | Explicit `domain --yes` creates Front Door validation TXT/CNAME, then associates the approved managed-TLS domain with both HTTPS routing and WAF. Never points DNS at the restricted PHP origin. |
| M365 Profiles / Sentinel Optimizer | Manual infrastructure `configure-dns: true` opt-in: base deployment, shared connector, final Bicep custom-domain convergence. The default is `false`; previews and pushes do not write DNS. |
| Code-to-Cloud dojo | No custom hostname is configured. Existing Azure endpoints and private/admin restrictions are retained; no new public alias or Cloudflare credential is required. |

New records carry an exact `pawprint:dns:owner/repository:environment` comment;
disposable runs add `:instance` so another run cannot overwrite their records.
Owner identities are normalized to lowercase, matching GitHub's case-insensitive names.
Only that exact owner may update a matching record type. Equivalent legacy
records retain their existing TTL and comments: they are not silently adopted.
A different target, proxy setting, flattened CNAME, duplicate name, or record type
owned elsewhere stops the operation. Review and migrate legacy ownership
explicitly before requesting a target change.

`plan` reads Cloudflare without writing. Reconciliation inspects every requested
name before the first write, rechecks each change immediately before applying it,
and verifies the persisted record and ownership afterward. There is no automatic
delete, ownership takeover, account setting change, or API-response-body logging.
Cloudflare has no record-level token permissions or compare-and-swap guarantee:
scope tokens to the exact zone, restrict pipeline access, and serialize applies
for a hostname. Ownership comments are an IaC safety guard, not an authorization
boundary.

For App Service and Front Door, use **subdomains**, DNS-only routing, and no
CNAME flattening. Public DNS must return the exact Azure CNAME and validation TXT.
Static Web Apps additionally supports an apex with Cloudflare's normal apex
flattening; TXT verification alone is not proof of apex HTTPS readiness. Its
adapter separately requires Azure custom-domain status `Ready`.

### Credentials and rollout

Supply `CLOUDFLARE_API_TOKEN` at runtime, with **Zone Read** and **DNS Edit**
(`DNS Write` in the API) for one zone only. Supply `CLOUDFLARE_ZONE_NAME` or
`CLOUDFLARE_ZONE_ID`; if both are provided, they must identify the same active
zone. Do not put a token in JSON, command arguments, Bicep, outputs, or artifacts.
Sentinel Optimizer prefers a separate `CLOUDFLARE_DNS_API_TOKEN` Environment secret,
mapped to the standard runtime variable, so its optional Worker deployment can
keep a different token. Its existing secret is a compatibility fallback for
DNS-only environments; do not broaden a DNS token with Worker/account privileges.

Publish reviewed Pawprint source before publishing the consumers. The static
sites and Pawton keep their existing immutable core-kit workflow pins. New DNS
source is isolated under `vendor/pawprint-dns/` with a content-hashed
`vendor/pawprint-dns.manifest.json`, rather than weakening the old core-kit drift
gate or pretending an older commit contains the new files.

From Pawprint, synchronize a DNS consumer with:

```powershell
node scripts/vendor-sync.mjs --target ..\pawton --prefix vendor/pawprint-dns --snapshot --add LICENSE --add scripts/cloudflare-dns.mjs --add scripts/vendor-sync.mjs
```

For a Static Web Apps consumer, also add
`--add scripts/connect-cloudflare-dns.sh`. The vendor manifest declares its
shared-script dependency, so resynchronizing an existing connector cannot omit
the new reconciler. Run `npm run vendor:check:dns` in
each consumer. The snapshot records exact normalized content hashes and labels
the base commit `working-tree@...`; that commit alone does not identify
unpublished source changes. Review and publish the shared source and snapshots
together. Do not edit or format vendored copies.

PHP2Shell retains its existing hash-checked `vendor/pawprint/` layout and sync
command. Its pending/associated custom domain is persisted in ownership tags,
so repair and remediation retain it without needing a Cloudflare token.
The simulator still uses the independently verified Azure endpoint.

Remove a disposable run's routing CNAME before releasing its Azure hostname.
Azure teardown deliberately does not delete Cloudflare or shared records.
Retain validation TXT until the hostname's ownership/takeover risk is reviewed.

### Explicit shared platform records

If a durable alias is genuinely shared, declare it in a non-secret manifest
owned by Pawprint, not in multiple application repositories. For example
(illustrative only; no such record is deployed):

```json
{
  "zoneName": "example.org",
  "owner": "ninjapaw/pawprint:shared",
  "records": [
    {
      "type": "CNAME",
      "name": "status.example.org",
      "content": "site.azurestaticapps.net",
      "ttl": 300
    }
  ]
}
```

Use `npm run dns -- validate --records <manifest>` offline, then
`npm run dns -- plan --records <manifest>` with the scoped runtime credential.
Only `npm run dns -- apply --records <manifest> --yes` writes. Supported shared
types are A, AAAA, CNAME, and TXT, with one unambiguous record per requested name.
Other names, mail records, DNSSEC, and nameserver delegation remain untouched.

## Credential bootstrap

Run the local portal and open the guided connector page:

```bash
npm run portal
# http://127.0.0.1:4173/setup/cloudflare/
```

Create a temporary seven-day account-owned bootstrap token from Cloudflare's
`Create Account Tokens` template. Cloudflare requires the token creator to be a
Super Administrator on that account. Keep `Account API Tokens Write`, add `Zone
Read`, and restrict zone access to the intended zone. PawPrint verifies the
bootstrap is active for the discovered account, confirms it can list token
permission groups, and then calls Cloudflare's documented
[`POST /accounts/{account_id}/tokens` Create Token API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/)
to create the child. The child is a new seven-day account-owned token restricted
to `Zone Read` and `DNS Write` for that zone. The child is verified by creating
and deleting a temporary TXT record, then only the child is streamed to
`gh secret set` over stdin for the selected repository environments. Neither
token is written to disk, returned by the API, or retained by the browser.
Revoke the bootstrap token in Cloudflare after the child is stored successfully.

GitHub stores the secret value. Pawprint stores only the token ID and expiry as
GitHub Environment variables so readiness and rotation can be reported without
retrieving the credential.

## Extending or forking

A fork changes repository-owned configuration and supplies its own environment
secret. It does not edit the shared Cloudflare connector.

To add another DNS provider:

1. Add the provider name and non-secret zone metadata to the deployment schema.
2. Add permission tiers to the connector catalog.
3. Implement a connector with the same inputs and safety properties: verify the
   zone, refuse conflicting or foreign-owned records, reconcile only explicitly
   declared records, and never print credentials or upstream response bodies.
4. Add a loopback setup page that stores credentials directly in the target
   secret store.
5. Keep Azure custom-domain declaration in the shared Bicep module and preserve
   the base, DNS bootstrap, final Bicep convergence sequence.

References:

- [Cloudflare DNS record creation and permissions](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)
- [Cloudflare record updates](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)
- [Front Door custom-domain validation](https://learn.microsoft.com/azure/frontdoor/standard-premium/how-to-add-custom-domain)
