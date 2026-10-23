#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "Set $name before running this script."
}

for command in az jq node; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command not found: $command"
done
[[ $# -eq 0 ]] || fail 'This Azure orchestration applies changes. Use cloudflare-dns.mjs plan for a read-only DNS plan.'
for name in AZURE_RESOURCE_GROUP AZURE_STATIC_WEB_APP_NAME AZURE_CUSTOM_DOMAIN CLOUDFLARE_API_TOKEN; do
  require_value "$name"
done
[[ -n "${CLOUDFLARE_ZONE_NAME:-}${CLOUDFLARE_ZONE_ID:-}" ]] || fail 'Set CLOUDFLARE_ZONE_NAME or CLOUDFLARE_ZONE_ID.'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PAWPRINT_DNS_SERVICE=static-web-app
if [[ -z "${PAWPRINT_DNS_OWNER:-}" ]]; then
  environment="${PAWPRINT_ENVIRONMENT:-${AZURE_ENVIRONMENT:-}}"
  case "$environment" in
    dev|development) environment=dev ;;
    prod|production) environment=prod ;;
    *) fail 'Set PAWPRINT_DNS_OWNER=owner/repository:dev (or :prod), or supply the repository and environment.' ;;
  esac
  require_value GITHUB_REPOSITORY
  export PAWPRINT_DNS_OWNER="$GITHUB_REPOSITORY:$environment"
fi

# Verify the external authority before starting Azure domain validation.
node "$SCRIPT_DIR/cloudflare-dns.mjs" zone
hostnames="$(az staticwebapp hostname list \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --output json)"
hostname_response="$(jq --arg domain "$AZURE_CUSTOM_DOMAIN" \
  '[.[] | select((.domainName // .name // .properties.domainName) == $domain)]
   | if length > 1 then error("Ambiguous Azure custom domains") else .[0] // {} end' <<<"$hostnames")"
validation_token="$(jq -r '.validationToken // .properties.validationToken // empty' <<<"$hostname_response")"

if [[ -z "$validation_token" ]]; then
  az staticwebapp hostname set \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_STATIC_WEB_APP_NAME" \
    --hostname "$AZURE_CUSTOM_DOMAIN" \
    --validation-method dns-txt-token \
    --no-wait \
    --output none
  hostname_response="$(az staticwebapp hostname show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_STATIC_WEB_APP_NAME" \
    --hostname "$AZURE_CUSTOM_DOMAIN" \
    --output json)"
  validation_token="$(jq -r '.validationToken // .properties.validationToken // empty' <<<"$hostname_response")"
fi
[[ -n "$validation_token" ]] || fail 'Azure did not return a custom-domain validation token. Allow the pending operation to settle and retry.'

AZURE_DEFAULT_HOSTNAME="$(az staticwebapp show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --query defaultHostname \
  --output tsv)"
export AZURE_DEFAULT_HOSTNAME
export AZURE_DOMAIN_VALIDATION_TOKEN="$validation_token"
node "$SCRIPT_DIR/cloudflare-dns.mjs" plan
node "$SCRIPT_DIR/cloudflare-dns.mjs" apply --yes

az staticwebapp hostname set \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --hostname "$AZURE_CUSTOM_DOMAIN" \
  --validation-method dns-txt-token \
  --output none
status="$(az staticwebapp hostname show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --hostname "$AZURE_CUSTOM_DOMAIN" \
  --query status \
  --output tsv)"
[[ "$status" == Ready ]] || fail 'Azure custom-domain HTTPS is not Ready. Allow DNS/certificate propagation and retry; no success is asserted.'
printf 'Cloudflare DNS and Azure custom domain are reconciled for https://%s.\n' "$AZURE_CUSTOM_DOMAIN"
