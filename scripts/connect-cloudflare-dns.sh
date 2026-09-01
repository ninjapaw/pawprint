#!/usr/bin/env bash
# Reconciles only the DNS records Azure Static Web Apps needs for a custom
# domain. Azure remains the application authority; Cloudflare remains DNS.

set -Eeuo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "Set $name before running this script."
}

require_command az
require_command curl
require_command jq

require_value AZURE_RESOURCE_GROUP
require_value AZURE_STATIC_WEB_APP_NAME
require_value AZURE_CUSTOM_DOMAIN
require_value CLOUDFLARE_ZONE_NAME
require_value CLOUDFLARE_API_TOKEN

[[ "$AZURE_CUSTOM_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'AZURE_CUSTOM_DOMAIN must be a hostname.'
[[ "$CLOUDFLARE_ZONE_NAME" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'CLOUDFLARE_ZONE_NAME must be a DNS zone name.'

cloudflare_api='https://api.cloudflare.com/client/v4'
cloudflare_headers=(
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  --header 'Content-Type: application/json'
)

cloudflare() {
  local method="$1"
  local path="$2"
  local payload="${3:-}"
  local response
  local args=(--fail-with-body --silent --show-error "${cloudflare_headers[@]}" --request "$method")
  [[ -z "$payload" ]] || args+=(--data "$payload")
  response="$(curl "${args[@]}" "$cloudflare_api$path")"
  [[ "$(jq -r '.success' <<<"$response")" == true ]] || fail "Cloudflare API request failed: $(jq -c '.errors' <<<"$response")"
  printf '%s' "$response"
}

zone_response="$(cloudflare GET "/zones?name=$CLOUDFLARE_ZONE_NAME&status=active")"
[[ "$(jq '.result | length' <<<"$zone_response")" -eq 1 ]] || fail "Cloudflare did not return one active zone named '$CLOUDFLARE_ZONE_NAME'."
zone_name="$(jq -r '.result[0].name' <<<"$zone_response")"
zone_id="$(jq -r '.result[0].id' <<<"$zone_response")"
[[ "$AZURE_CUSTOM_DOMAIN" == "$zone_name" || "$AZURE_CUSTOM_DOMAIN" == *".$zone_name" ]] || \
  fail "AZURE_CUSTOM_DOMAIN '$AZURE_CUSTOM_DOMAIN' is not inside Cloudflare zone '$zone_name'."

hostname_response="$(az staticwebapp hostname show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --hostname "$AZURE_CUSTOM_DOMAIN" \
  --output json 2>/dev/null || true)"
validation_token="$(jq -r '.validationToken // .properties.validationToken // empty' <<<"${hostname_response:-{}}")"

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

[[ -n "$validation_token" ]] || fail 'Azure did not return a custom-domain validation token.'

upsert_record() {
  local record_name="$1"
  local record_type="$2"
  local record_content="$3"
  local records_response record_count record_id payload result

  records_response="$(cloudflare GET "/zones/$zone_id/dns_records?name=$record_name")"
  record_count="$(jq '.result | length' <<<"$records_response")"
  if [[ "$record_count" -gt 1 ]]; then
    fail "Refusing to modify $record_name because it has multiple Cloudflare DNS records."
  fi
  if [[ "$record_count" -eq 1 && "$(jq -r '.result[0].type' <<<"$records_response")" != "$record_type" ]]; then
    fail "Refusing to replace the existing $(jq -r '.result[0].type' <<<"$records_response") record at $record_name."
  fi

  record_id="$(jq -r '.result[0].id // empty' <<<"$records_response")"
  payload="$(jq -n \
    --arg type "$record_type" \
    --arg name "$record_name" \
    --arg content "$record_content" \
    --arg comment 'Managed by ninjapaw/pawprint' \
    '{type:$type,name:$name,content:$content,ttl:1,proxied:false,comment:$comment}')"

  if [[ -n "$record_id" ]]; then
    result="$(cloudflare PUT "/zones/$zone_id/dns_records/$record_id" "$payload")"
    printf 'Updated Cloudflare %s record %s.\n' "$record_type" "$record_name"
  else
    result="$(cloudflare POST "/zones/$zone_id/dns_records" "$payload")"
    printf 'Created Cloudflare %s record %s.\n' "$record_type" "$record_name"
  fi
  [[ "$(jq -r '.result.content' <<<"$result")" == "$record_content" ]] || fail "Cloudflare did not persist $record_name as requested."
}

default_hostname="$(az staticwebapp show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --query defaultHostname \
  --output tsv)"
[[ -n "$default_hostname" ]] || fail 'Azure Static Web Apps default hostname was empty.'

upsert_record "_dnsauth.$AZURE_CUSTOM_DOMAIN" TXT "$validation_token"
upsert_record "$AZURE_CUSTOM_DOMAIN" CNAME "$default_hostname"

# The second call completes the pending operation after DNS is in place and
# waits for Azure to issue the managed certificate.
az staticwebapp hostname set \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --hostname "$AZURE_CUSTOM_DOMAIN" \
  --validation-method dns-txt-token \
  --output none

az staticwebapp hostname show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_STATIC_WEB_APP_NAME" \
  --hostname "$AZURE_CUSTOM_DOMAIN" \
  --output none

printf 'Cloudflare DNS and Azure custom domain are reconciled for https://%s.\n' "$AZURE_CUSTOM_DOMAIN"