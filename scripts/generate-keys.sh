#!/usr/bin/env bash
# Creates fresh TESTNET-ONLY keys for every role and writes them to .env.
#
#   bash scripts/generate-keys.sh     (or: pnpm keys:generate)
#
# - Never prints a private key. It prints the addresses, which are what you fund at a faucet.
# - Never replaces a key that is already set: run it again at any time to fill in new roles.
# - .env is git-ignored and readable only by you (mode 600).
#
# Do not send real funds to these addresses and do not reuse these keys anywhere else.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
ROLES="DEPLOYER PRINCIPAL EXECUTOR APPROVER SPEND_WALLET MERCHANT AGENT VENDOR_A VENDOR_B"

CAST="$(command -v cast || true)"
[ -n "$CAST" ] || CAST="$HOME/.foundry/bin/cast"
[ -x "$CAST" ] || { echo "cast not found. Install Foundry first: https://getfoundry.sh" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found. Install jq first." >&2; exit 1; }

umask 077
[ -f "$ENV_FILE" ] || cp "$ROOT/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Reads NAME's value from the env file.
get_var() {
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

# Sets NAME=VALUE in the env file. The value travels through the environment, not the command line.
set_var() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  KEY_NAME="$1" KEY_VALUE="$2" awk -F= '
    BEGIN { k = ENVIRON["KEY_NAME"]; v = ENVIRON["KEY_VALUE"]; done = 0 }
    $1 == k { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  mv "$tmp" "$ENV_FILE"
}

echo "Testnet-only addresses (Arbitrum Sepolia):"
echo
for role in $ROLES; do
  key_name="${role}_PRIVATE_KEY"
  address_name="${role}_ADDRESS"
  status="existing"

  if [ -z "$(get_var "$key_name")" ]; then
    # Older versions of cast print a JSON array; newer ones wrap it in {"data": [...]}.
    wallet="$("$CAST" wallet new --json | jq -c '(if type == "array" then . else .data end)[0]')"
    private_key="$(jq -r '.private_key' <<<"$wallet")"
    address="$(jq -r '.address' <<<"$wallet")"
    if ! [[ "$private_key" =~ ^0x[0-9a-fA-F]{64}$ && "$address" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
      echo "Could not read a new wallet from cast. Nothing was written for $role." >&2
      exit 1
    fi
    set_var "$key_name" "$private_key"
    set_var "$address_name" "$address"
    unset wallet private_key address
    status="new"
  fi

  printf '  %-13s %s  (%s)\n' "$role" "$(get_var "$address_name")" "$status"
done

echo
echo "Keys are in $ENV_FILE. They were not printed and must never be committed or shared."
