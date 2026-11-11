#!/usr/bin/env bash
# Deploys MandateVault to Arbitrum Sepolia, records the deployment and verifies the source.
#
#   bash scripts/deploy-sepolia.sh --dry-run      simulate only: no transaction is sent
#   bash scripts/deploy-sepolia.sh                deploy, record, verify
#   bash scripts/deploy-sepolia.sh --skip-verify  deploy and record, do not verify
#   bash scripts/deploy-sepolia.sh --verify-only  verify the recorded deployment again
#
# Settings come from the repository's .env (see .env.example). This script prints addresses and
# transaction hashes only, never keys.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-../../.env}"
RECORD="deployments/arbitrum-sepolia.json"
CHAIN_ID=421614
MODE="${1:-deploy}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing .env at the repository root. Run: pnpm keys:generate" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${ARBITRUM_SEPOLIA_RPC_URL:=https://sepolia-rollup.arbitrum.io/rpc}"
: "${USDC_ADDRESS:=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d}"
: "${IDENTITY_REGISTRY_ADDRESS:=0x8004A818BFB912233c491871b3d84c89A494BD9e}"
export ARBITRUM_SEPOLIA_RPC_URL USDC_ADDRESS IDENTITY_REGISTRY_ADDRESS

actual_chain="$(cast chain-id --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL")"
if [ "$actual_chain" != "$CHAIN_ID" ]; then
  echo "Refusing to continue: the RPC is chain $actual_chain, expected $CHAIN_ID (Arbitrum Sepolia)." >&2
  exit 1
fi

verify() {
  : "${ETHERSCAN_API_KEY:?Set ETHERSCAN_API_KEY in .env to verify on Arbiscan}"
  local address principal args
  address="$(jq -r '.contracts.MandateVault.address' "$RECORD")"
  principal="$(jq -r '.principal' "$RECORD")"
  args="$(cast abi-encode 'constructor(address,address,address)' \
    "$(jq -r '.token' "$RECORD")" "$principal" "$(jq -r '.identityRegistry' "$RECORD")")"

  echo "Verifying $address on Arbiscan..."
  forge verify-contract "$address" src/MandateVault.sol:MandateVault \
    --chain "$CHAIN_ID" --constructor-args "$args" --license-type MIT --watch

  echo "Verifying $address on Sourcify (best effort)..."
  forge verify-contract "$address" src/MandateVault.sol:MandateVault \
    --chain "$CHAIN_ID" --constructor-args "$args" --verifier sourcify ||
    echo "Sourcify verification did not complete. The Arbiscan verification above is the one that matters."

  echo "Verified: https://sepolia.arbiscan.io/address/$address#code"
}

case "$MODE" in
--verify-only)
  [ -f "$RECORD" ] || { echo "No deployment recorded at $RECORD." >&2; exit 1; }
  verify
  exit 0
  ;;
--dry-run | deploy | --skip-verify) ;;
*)
  echo "Unknown option: $MODE" >&2
  exit 1
  ;;
esac

: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY in .env}"
: "${PRINCIPAL_ADDRESS:?Set PRINCIPAL_ADDRESS in .env}"

if [ "$MODE" = "--dry-run" ]; then
  forge script script/Deploy.s.sol --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL"
  echo "Dry run only. Nothing was sent."
  exit 0
fi

if [ "$MODE" = "deploy" ]; then
  : "${ETHERSCAN_API_KEY:?Set ETHERSCAN_API_KEY in .env, or pass --skip-verify}"
fi

forge script script/Deploy.s.sol --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" --broadcast

# Record the deployment from Foundry's broadcast log.
RUN="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
tx_hash="$(jq -r '.transactions[] | select(.contractName == "MandateVault" and .transactionType == "CREATE") | .hash' "$RUN")"
receipt="$(jq -c --arg hash "$tx_hash" '.receipts[] | select(.transactionHash == $hash)' "$RUN")"
address="$(cast to-check-sum-address "$(jq -r '.contractAddress' <<<"$receipt")")"
deployer="$(cast to-check-sum-address "$(jq -r '.from' <<<"$receipt")")"
block_number="$(cast to-dec "$(jq -r '.blockNumber' <<<"$receipt")")"

mkdir -p deployments
jq -n \
  --arg address "$address" --arg tx_hash "$tx_hash" --argjson block_number "$block_number" \
  --arg deployer "$deployer" --arg principal "$PRINCIPAL_ADDRESS" \
  --arg token "$USDC_ADDRESS" --arg registry "$IDENTITY_REGISTRY_ADDRESS" '
  {
    network: "arbitrum-sepolia",
    chainId: 421614,
    contracts: {
      MandateVault: {
        address: $address,
        transactionHash: $tx_hash,
        blockNumber: $block_number,
        deployer: $deployer
      }
    },
    principal: $principal,
    token: $token,
    identityRegistry: $registry
  }' >"$RECORD"

echo
echo "MandateVault deployed: $address"
echo "Transaction: https://sepolia.arbiscan.io/tx/$(jq -r '.contracts.MandateVault.transactionHash' "$RECORD")"
echo "Recorded in apps/contracts/$RECORD. Set MANDATE_VAULT_ADDRESS=$address in .env."

if [ "$MODE" = "deploy" ]; then
  verify
fi
