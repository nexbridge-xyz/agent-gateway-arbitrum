#!/usr/bin/env bash
# Checks that git cannot pick up a file that holds keys: .gitignore names the files keys live in, it
# hides nothing that is tracked, and the key generator writes only where git does not look.
#
#   bash scripts/check-ignored-files.sh
#
# Nothing is created except one empty folder for the last check, which is removed again.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

failures=0
ok() { echo "ok    $1"; }
fail() {
  echo "FAIL  $1"
  failures=$((failures + 1))
}

# --- Files that hold keys or local data must be ignored, at any depth -----------------------------

ignored=(
  .env
  .env.local
  .env.bak
  apps/gateway/.env
  .envrc
  apps/gateway/.envrc
  key.pem
  apps/contracts/deployer.pem
  server.key
  wallet.p12
  wallet.pfx
  apps/contracts/keystore.json
  deployer-keystore.json
  keystore/deployer
  apps/contracts/keystores/demo
  UTC--2026-11-12T03-41-31.000000000Z--d42f974802a327789f217db9f61dea26ea5418a5
  apps/gateway/data/ledger.jsonl
  apps/gateway/data/evidence/record.json
  coverage/lcov.info
  apps/console/coverage/index.html
)
for path in "${ignored[@]}"; do
  if git check-ignore -q --no-index -- "$path"; then ok "ignored: $path"; else fail "not ignored: $path"; fi
done

# --- What the repository needs must not be ignored ------------------------------------------------

kept=(
  .env.example
  .gitignore
  apps/contracts/broadcast/Deploy.s.sol/421614/run-latest.json
  apps/contracts/deployments/arbitrum-sepolia.json
  docs/sepolia-run/ledger.jsonl
  apps/gateway/src/store/payees.ts
  scripts/generate-keys.sh
)
for path in "${kept[@]}"; do
  if git check-ignore -q --no-index -- "$path"; then fail "ignored, must be kept: $path"; else ok "kept: $path"; fi
done

hidden="$(git ls-files -ci --exclude-standard)"
if [ -z "$hidden" ]; then
  ok "no tracked file matches an ignore rule"
else
  fail "tracked files match an ignore rule: $hidden"
fi

# --- The key generator writes keys only into a file that git ignores ------------------------------

# Run without Foundry in reach, so that this check creates no key whatever the script does.
target="$root/keys-for-this-check.txt"
empty="$(mktemp -d)"
trap 'rm -rf "$empty" "$target"' EXIT
answer="$(ENV_FILE="$target" HOME="$empty" PATH="/usr/bin:/bin" bash scripts/generate-keys.sh 2>&1)" && status=0 || status=$?
if [ "$status" -ne 0 ] && [ ! -e "$target" ] && printf '%s' "$answer" | grep -q "git does not ignore it"; then
  ok "the key generator refuses a file in the repository that git does not ignore"
else
  fail "the key generator did not refuse keys-for-this-check.txt: $answer"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures checks failed. See .gitignore and scripts/generate-keys.sh."
  exit 1
fi
echo "All checks passed."
