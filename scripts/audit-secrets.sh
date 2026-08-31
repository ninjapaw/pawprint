#!/usr/bin/env bash
# MIT License
# Copyright (c) 2026 Microsoft Corporation
# See LICENSE in the repository root.

set -Eeuo pipefail

vault_name="${AZURE_KEY_VAULT_NAME:-}"
warn_days="${AZURE_SECRET_WARN_DAYS:-30}"
fail_on_expiring=false

usage() {
  cat <<'EOF'
Audit Azure Key Vault secret expiration.

Usage: scripts/audit-secrets.sh [options]

Options:
  --vault <name>          Key Vault name (default: AZURE_KEY_VAULT_NAME)
  --warn-days <number>    Days ahead to treat a secret as expiring (default: 30)
  --fail-on-expiring      Exit non-zero when a secret is expiring, not only expired
  --help                  Show this help

Exit codes:
  0  No expired secrets (and none expiring when --fail-on-expiring is set)
  1  At least one expired secret, or an expiring secret with --fail-on-expiring

Secrets without an expiration date are reported because they cannot be tracked
for rotation. Secret values are never read or printed.

Vendored copy. Edit it in ninjapaw/pawprint and re-vendor; CI fails on drift.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*" >&2
}

annotate() {
  local level="$1"
  local message="$2"

  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::%s title=Key Vault secret::%s\n' "$level" "$message"
  else
    printf '%s: %s\n' "$level" "$message" >&2
  fi
}

while (($# > 0)); do
  case "$1" in
    --vault)
      (($# >= 2)) || fail '--vault requires a value.'
      vault_name="$2"
      shift 2
      ;;
    --warn-days)
      (($# >= 2)) || fail '--warn-days requires a value.'
      warn_days="$2"
      shift 2
      ;;
    --fail-on-expiring)
      fail_on_expiring=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option '$1'. Run with --help for usage."
      ;;
  esac
done

command -v az >/dev/null 2>&1 || fail "Required command 'az' was not found."
command -v jq >/dev/null 2>&1 || fail "Required command 'jq' was not found."
[[ -n "$vault_name" ]] || fail 'Set --vault or AZURE_KEY_VAULT_NAME.'
[[ "$warn_days" =~ ^[0-9]+$ ]] || fail '--warn-days must be a whole number.'

az account show >/dev/null 2>&1 || fail "Azure CLI is not authenticated. Run 'az login' and retry."

secrets_json="$(az keyvault secret list \
  --vault-name "$vault_name" \
  --query '[].{name:name, enabled:attributes.enabled, expires:attributes.expires}' \
  --output json)"

now_epoch="$(date -u '+%s')"
warn_epoch=$((now_epoch + warn_days * 86400))
expired=0
expiring=0
untracked=0

while IFS=$'\t' read -r name enabled expires; do
  [[ -n "$name" ]] || continue

  if [[ "$enabled" != "true" ]]; then
    log "Secret '$name' is disabled."
    continue
  fi

  if [[ -z "$expires" || "$expires" == "null" ]]; then
    annotate warning "Secret '$name' has no expiration date and cannot be tracked for rotation."
    untracked=$((untracked + 1))
    continue
  fi

  expires_epoch="$(date -u -d "$expires" '+%s')"
  if ((expires_epoch <= now_epoch)); then
    annotate error "Secret '$name' expired on $expires. Rotate it now."
    expired=$((expired + 1))
  elif ((expires_epoch <= warn_epoch)); then
    annotate warning "Secret '$name' expires on $expires. Rotate it within $warn_days days."
    expiring=$((expiring + 1))
  fi
done < <(jq --raw-output '.[] | [.name, (.enabled|tostring), (.expires // "")] | @tsv' <<<"$secrets_json")

total="$(jq 'length' <<<"$secrets_json")"
log "Key Vault '$vault_name': $total secrets, $expired expired, $expiring expiring, $untracked without expiration."

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '### Key Vault secret audit\n\n'
    printf '| Vault | Secrets | Expired | Expiring (%s days) | No expiration |\n' "$warn_days"
    printf '| --- | --- | --- | --- | --- |\n'
    printf '| %s | %s | %s | %s | %s |\n' \
      "$vault_name" "$total" "$expired" "$expiring" "$untracked"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if ((expired > 0)); then
  exit 1
fi

if [[ "$fail_on_expiring" == true ]] && ((expiring > 0)); then
  exit 1
fi
