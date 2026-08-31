#!/usr/bin/env bash
# Validates the deployment environment variables a pipeline resolved before any
# Azure call is made. Failing here costs nothing; failing halfway through a
# deployment costs a partially provisioned resource group.
#
# Shared across repositories. Set PAWPRINT_REQUIRE to a space-separated list of
# additional variable names this workload cannot deploy without.
#
# Vendored copy. Edit it in ninjapaw/pawprint and re-vendor; CI fails on drift.

set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "Missing required environment variable: $name"
  fi
}

match_when_set() {
  local name="$1"
  local pattern="$2"
  local value="${!name:-}"
  if [[ -n "$value" && ! "$value" =~ $pattern ]]; then
    fail "Invalid $name."
  fi
}

require_value AZURE_LOCATION
require_value AZURE_RESOURCE_GROUP

for name in ${PAWPRINT_REQUIRE:-}; do
  require_value "$name"
done

match_when_set AZURE_LOCATION '^[a-z0-9]{2,40}$'
match_when_set AZURE_RESOURCE_GROUP '^[A-Za-z0-9._()\-]{1,90}$'
match_when_set AZURE_STATIC_WEB_APP_NAME '^[A-Za-z0-9-]{2,40}$'
match_when_set AZURE_FUNCTIONAPP_NAME '^[A-Za-z0-9-]{2,60}$'
match_when_set AZURE_KEY_VAULT_NAME '^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$'
match_when_set AZURE_CONTAINER_REGISTRY_NAME '^[a-z0-9]{5,50}$'
match_when_set AZURE_PUBLIC_SITE_URL '^https://[^[:space:]]+$'
match_when_set AZURE_SUBSCRIPTION_ID '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# A plaintext http endpoint in a deployment variable is almost always a mistake
# and is never recoverable once a custom domain has been bound to it.
if [[ "${AZURE_PUBLIC_SITE_URL:-}" == http://* ]]; then
  fail 'AZURE_PUBLIC_SITE_URL must use https.'
fi

if [[ -n "${AZURE_CUSTOM_DOMAIN:-}" && -n "${AZURE_PUBLIC_SITE_URL:-}" ]]; then
  if [[ "$AZURE_PUBLIC_SITE_URL" != "https://${AZURE_CUSTOM_DOMAIN}" ]]; then
    fail "AZURE_PUBLIC_SITE_URL must be https://${AZURE_CUSTOM_DOMAIN}."
  fi
fi

printf 'Environment validated for resource group %s in %s.\n' "$AZURE_RESOURCE_GROUP" "$AZURE_LOCATION"
