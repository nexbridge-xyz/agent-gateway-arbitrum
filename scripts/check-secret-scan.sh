#!/usr/bin/env bash
# Tests the rules in .gitleaks.toml on made-up secrets: every shape a key takes in this project must be
# found, and every public value that looks like a key must be passed over.
#
#   bash scripts/check-secret-scan.sh
#
# Needs gitleaks on the PATH, or its location in GITLEAKS. Every value is made up when the script runs,
# so nothing here is a secret and nothing secret is written into the repository.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gitleaks="${GITLEAKS:-gitleaks}"
if ! command -v "$gitleaks" >/dev/null 2>&1; then
  echo "gitleaks was not found. Install it, or set GITLEAKS to where it is." >&2
  exit 2
fi
# Each check runs in a folder of its own, so a location given relative to this one is made absolute.
case "$gitleaks" in
  */*) gitleaks="$(cd "$(dirname "$gitleaks")" && pwd)/$(basename "$gitleaks")" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

hex() { openssl rand -hex "$1"; }
# Twelve words, chosen anew each time, in the shape of a recovery phrase.
words=(amber basket candle dolphin ember falcon garden harbor island jacket kettle lantern meadow napkin orchard pepper quartz ribbon saddle timber umbrella velvet walnut zipper)
phrase() {
  local picked=()
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do picked+=("${words[RANDOM % ${#words[@]}]}"); done
  echo "${picked[*]}"
}

failures=0
count=0

# check <found|passed> <what it is> <file, relative to a scratch folder> <content>
check() {
  local want="$1" what="$2" file="$3" content="$4" dir got
  count=$((count + 1))
  dir="$work/case-$count"
  mkdir -p "$dir/$(dirname "$file")"
  printf '%s\n' "$content" >"$dir/$file"
  if (cd "$dir" && "$gitleaks" dir --config "$root/.gitleaks.toml" --no-banner --redact . >/dev/null 2>&1); then
    got=passed
  else
    got=found
  fi
  if [ "$got" = "$want" ]; then
    echo "ok    $want: $what"
  else
    echo "FAIL  $got, must be $want: $what"
    failures=$((failures + 1))
  fi
}

# --- What must be found ---------------------------------------------------------------------------

check found "a key in an .env file" "notes/.env" "EXECUTOR_PRIVATE_KEY=0x$(hex 32)"
check found "a key handed to a command" "README.md" "cast send 0x00 --private-key 0x$(hex 32)"
check found "a key handed to a command, without 0x" "run.sh" "forge script Deploy --private-key=$(hex 32) --broadcast"
check found "a key as a constant in TypeScript" "scripts/pay.ts" "const pk = '0x$(hex 32)';"
check found "a key as a constant in Solidity" "apps/contracts/script/Pay.s.sol" "    uint256 internal constant DEPLOYER = 0x$(hex 32);"
check found "a key alone on a line" "key.txt" "$(hex 32)"
check found "a key in JSON under a name that says nothing" "wallet.json" "{ \"value\": \"0x$(hex 32)\" }"
check found "a recovery phrase alone on a line" "phrase.txt" "$(phrase)"
check found "a recovery phrase in an .env file" "notes/.env" "MNEMONIC=\"$(phrase)\""
check found "a recovery phrase handed to a command" "README.md" "cast wallet import deployer --mnemonic \"$(phrase)\""
check found "an Alchemy address with its key" ".env.example" "ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/$(hex 16)"
check found "an Infura address with its key" "docs/setup.md" "Use https://arbitrum-sepolia.infura.io/v3/$(hex 16) as the endpoint."
check found "an access token of 20 bytes" "config.toml" "access_token = \"0x$(hex 20)\""
check found "a 20-byte value in a token field that is not a known token" "config.json" "{ \"token\": \"0x$(hex 20)\" }"

# --- What must be passed over ---------------------------------------------------------------------

check passed "USDC on Arbitrum Sepolia in a token field" "deployment.json" '{ "token": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" }'
check passed "USDC on Arbitrum One in a token field" "test.ts" "  token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',"
check passed "a link to a transaction" "README.md" "[paid](https://sepolia.arbiscan.io/tx/0x$(hex 32))"
check passed "an evidence file named after its hash" "README.md" "pnpm verify-evidence docs/sepolia-run/evidence/0x$(hex 32).json"
check passed "a mandate text named after its hash" "README.md" "[text](mandates/0x$(hex 32).txt)"
check passed "hashes in the recorded run" "docs/sepolia-run/ledger.jsonl" "{\"hash\":\"0x$(hex 32)\",\"previous\":\"0x$(hex 32)\"}"
check passed "hashes in a broadcast log" "apps/contracts/broadcast/Deploy.s.sol/421614/run-latest.json" "{ \"hash\": \"0x$(hex 32)\" }"
check passed "a checksum" ".github/workflows/ci.yml" "      GITLEAKS_SHA256: $(hex 32)"
check passed "the order of the secp256k1 curve" "apps/contracts/test/Curve.t.sol" "    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;"
check passed "a selector padded to 32 bytes" "apps/contracts/test/Mock.sol" "        return 0x1626ba7e00000000000000000000000000000000000000000000000000000000;"
check passed "an address padded to 32 bytes" "topics.ts" "const topic = '0x000000000000000000000000$(hex 20)';"
check passed "a signature of 65 bytes" "evidence.ts" "const signature = '0x$(hex 65)';"
check passed "the public endpoint, which has no key" ".env.example" "ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc"
check passed "an address" "README.md" "The vault is at 0x7293763f6b73783834484cd976528D01Cb6c8CCf."
check passed "a sentence" "README.md" "the gateway decides by fixed rules in plain code and no model is involved"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures of $count checks failed. See .gitleaks.toml."
  exit 1
fi
echo "All $count checks passed."
