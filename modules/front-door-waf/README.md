# Front Door WAF and PHP origins

`profile.bicep` creates a billable **Premium** Front Door profile. Deploy the
origin using its `frontDoorId` output, then deploy `main.bicep` with the origin's
actual default hostname. This ordering avoids opening the origin while waiting
for the edge deployment.

`main.bicep` provides HTTPS-only default-domain routing, HTTPS origin forwarding,
certificate-name verification, Microsoft Default Rule Set 2.1, and access,
health-probe, and WAF diagnostic logs. It starts in **Detection**, not Prevention.
The optional `DojoBenignMarker` custom rule matches only the harmless query marker
`dojoProbe=waf-marker`. It demonstrates WAF logging/blocking, **not CVE coverage**.
It is disabled by default for general consumers.

Use `modules/php-web-app/main.bicep` for a PHP origin. Its network rule requires
**both** the `AzureFrontDoor.Backend` service tag and this profile's
`x-azure-fdid` header. A copied header alone must still receive HTTP 403 when
sent directly to the origin. Validate both direct-origin and edge requests after
deployment; configuration alone is not proof.

The PHP module creates no secrets or runtime role grants. SCM publishing uses
Entra bearer authentication; FTP and SCM basic publishing credentials are
disabled. SCM is a public authenticated management endpoint, not a private
endpoint design. Consumers requiring private publishing need a separate private
network and runner design.

An optional `customDomainName` declares a managed-TLS Front Door custom domain.
Leave `associateCustomDomain=false` while obtaining its live Azure validation
token and reconciling the `_dnsauth` TXT and DNS-only CNAME with Pawprint's
[shared Cloudflare reconciler](../../scripts/cloudflare-dns.mjs).
Only after public DNS matches and Azure reports ownership `Approved`, redeploy
with `associateCustomDomain=true`. The domain is added to both HTTPS routing
and WAF; routing depends on the WAF association. The restricted origin never
receives a public custom-domain CNAME. Empty defaults preserve existing behavior.
Validate Azure managed TLS, live HTTPS identity, and WAF on both hostnames;
certificate provisioning and DNS propagation are not instantaneous.

These modules do not enable Defender plans or Sentinel, deploy application code,
assign roles, or call external DNS providers. Premium Front Door, App Service,
and diagnostic ingestion are billable. Tags include expiry metadata but do not
automatically delete anything. The PHP2Shell defense dojo is a consuming example.

References:

- [Origin security](https://learn.microsoft.com/azure/frontdoor/origin-security)
- [App Service access restrictions](https://learn.microsoft.com/azure/app-service/app-service-ip-restrictions)
- [Front Door diagnostics](https://learn.microsoft.com/azure/frontdoor/standard-premium/how-to-logs)
