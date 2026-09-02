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

The Cloudflare account owns only two durable records. Pawprint does not manage
zone settings, nameservers, proxying, WAF, Workers, TLS settings, registrar
state, or unrelated records.

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
permission groups, and confirms it can create the child. It then creates a new
seven-day token restricted to `Zone Read` and `DNS Write` for that zone. The
child is verified by creating and deleting a temporary TXT record, then only the
child is streamed to `gh secret set` over stdin for the selected repository
environments. Neither token is written to disk, returned by the API, or retained
by the browser. Revoke the bootstrap token in Cloudflare after the child is
stored successfully.

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
   zone, refuse conflicting record types, upsert only validation and routing
   records, and never print credentials.
4. Add a loopback setup page that stores credentials directly in the target
   secret store.
5. Keep Azure custom-domain declaration in the shared Bicep module and preserve
   the base, DNS bootstrap, final Bicep convergence sequence.
