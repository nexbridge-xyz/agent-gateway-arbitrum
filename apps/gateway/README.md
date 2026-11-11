# Gateway

The gateway is the offchain half of Agent Gateway. An agent sends it a signed payment request. The gateway
checks who is asking, decides by fixed rules, writes an evidence record and, when the rules allow it, pays
through [`MandateVault`](../contracts/README.md).

> Testnet demo. Not audited. Runs on Arbitrum Sepolia only and listens on localhost.

## What happens to a request

1. **The agent asks.** It signs a `PaymentIntent` (EIP-712) with its request-signing key and posts it. That
   key can ask for a payment. It cannot make one.
2. **Identity.** The signature must come from the wallet registered for that agent id in the ERC-8004
   Identity Registry.
3. **Policy.** Fourteen checks in plain code, no model, give one of three decisions: `auto`,
   `needs_approval` or `refused`.
4. **Evidence.** The gateway writes down who asked, what for and how each check went. The record's
   keccak256 hash over its canonical JSON (RFC 8785) is the evidence hash.
5. **Execution.** `auto` is paid at once with `payWithinMandate(mandateId, payee, amount, evidenceHash)`,
   so the vault's event points at the record. `needs_approval` waits for the approver. `refused` sends
   nothing.
6. **Ledger.** Every decision and payment is appended to a hash-chained ledger.

The vault enforces the mandate's limits on its own. If the gateway decided wrongly, or its executor key were
stolen, the vault would still refuse anything outside those limits.

## API

| Method and path                     | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `POST /v1/payment-intents`          | Decide one signed intent and pay it if the decision is `auto`. |
| `GET /v1/payment-intents/:intentId` | The evidence file for one intent.                              |
| `GET /v1/ledger`                    | The ledger, with the result of checking its hash chain.        |
| `GET /healthz`                      | Chain, vault and executor address.                             |

A request:

```json
{
  "intent": {
    "agentId": "354",
    "payee": "0x84d6943216c05bc96b72791d5a76875e08D539F0",
    "amount": "1500000",
    "purpose": "Invoice INV-2026-1107: market data feed, November",
    "invoiceId": "INV-2026-1107",
    "context": { "source": "vendor invoice" },
    "nonce": "0x…32 random bytes",
    "expiresAt": 1794420531
  },
  "signature": "0x…65 bytes"
}
```

`amount` is in the token's smallest unit: `1500000` is 1.50 USDC. `expiresAt` may be at most 15 minutes
ahead. The answer:

```json
{
  "intentId": "0x93d05350…9704b997",
  "decision": "auto",
  "reasons": ["All 14 checks passed"],
  "status": "paid",
  "evidenceHash": "0x82583c55…07e3ad59",
  "transactionHash": "0xac89ad80…301079bf",
  "error": null,
  "explorerUrl": "https://sepolia.arbiscan.io/tx/0xac89ad80…301079bf"
}
```

The intent id is the EIP-712 hash of the intent. Sending the same intent again returns the same answer and
never pays twice. A body that is not a well-formed signed intent gets `400` and leaves no record.

Build and sign an intent with the helpers in [`src/protocol`](src/protocol):

```ts
import { signIntent } from '@agent-gateway/gateway/protocol';

const signed = await signIntent(agentAccount, { chainId: 421614, vault }, intent);
```

## Policy

A failed **hard** check refuses the request. A failed **soft** check sends it to the approver. If nothing
fails, the payment goes through on its own.

| Check                      | Kind | Passes when                                                                            |
| -------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `request_current`          | hard | The request has not expired and is valid for at most 15 minutes.                       |
| `agent_registered`         | hard | The agent id exists in the ERC-8004 Identity Registry.                                 |
| `agent_active`             | hard | The agent's onchain registration file does not say `active: false`.                    |
| `agent_signature`          | hard | The request is signed by the agent's registered wallet.                                |
| `mandate_active`           | hard | The agent has a mandate that is not revoked or expired, with this gateway as executor. |
| `vault_open`               | hard | The principal has not paused the vault.                                                |
| `payee_not_denied`         | hard | The payee is not on the gateway's denylist.                                            |
| `payee_in_vendor_registry` | hard | The payee is in the principal's vendor registry.                                       |
| `amount_positive`          | hard | The amount is more than zero.                                                          |
| `within_hard_ceiling`      | hard | Today's total, with this payment, stays within the mandate's hard ceiling.             |
| `vault_funded`             | hard | The vault holds enough of the token.                                                   |
| `payee_on_allowlist`       | soft | The payee is on the mandate's allowlist.                                               |
| `within_per_payment_cap`   | soft | The amount is within the per-payment cap.                                              |
| `within_daily_cap`         | soft | Today's total, with this payment, stays within the daily cap.                          |

The vendor registry and the denylist are the principal's own files (`payees.json` in the data folder). They
are the only trusted answer to "who is this payee". An address that the agent found in something it read,
such as a tool response or an invoice, is refused unless the principal has registered it. The agent can
say where it found an address in `context.payeeSource`; the gateway records that and never trusts it.

The engine is a pure function in [`src/policy/evaluate.ts`](src/policy/evaluate.ts). It uses the same
inclusive bounds as the vault, and a test restates the vault's rules to show the gateway never lets through
on its own what the vault would refuse.

## Evidence

Each decision produces one file, `evidence/<intentId>.json`:

| Part           | Contents                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record`       | Who (agent, agent wallet, principal, mandate, executor, approver), what (payee, amount, purpose, invoice), the signed request, and why: the decision, the reasons and every check with pass, fail or skipped. Also the block the decision was based on. |
| `evidenceHash` | keccak256 of the canonical JSON of `record`. This is what the vault anchors.                                                                                                                                                                            |
| `approval`     | The approver's signature, for a payment outside the mandate.                                                                                                                                                                                            |
| `result`       | What happened: paid (transaction hash, block, event), pending approval, refused or failed.                                                                                                                                                              |

Only `record` is hashed. It is fixed when the decision is made, before any transaction exists, so the
transaction can carry its hash. The vault accepts each evidence hash once.

## Check an evidence file

```bash
pnpm verify-evidence <file> [--offline] [--rpc <url>] [--ledger <file>]
```

It prints PASS or FAIL for each check and exits with 0 only if all pass:

- the evidence hash is the hash of the record, and the intent id is the hash of the signed request;
- the request signature recovers the recorded signer, and the record says what the agent signed;
- the decision follows from the recorded checks, and the result fits the decision;
- an approval, if there is one, is signed by the mandate's approver for this payee, amount and evidence hash;
- onchain: the vault's settings, the agent wallet in the ERC-8004 registry, the transaction, and a vault
  event with this evidence hash and the same mandate, agent, payee and amount;
- the ledger's hash chain is intact and records the decision and the payment.

A file from someone else is treated as untrusted: a file of the wrong shape is rejected outright, and its
text is printed with control characters escaped.

Try it on the run recorded in [`docs/sepolia-run`](../../docs/sepolia-run/README.md). No keys are needed:

```bash
pnpm verify-evidence docs/sepolia-run/evidence/0x93d05350a8fbc1178eb1c66a907470018207dcc7a69d84c40aeb41689704b997.json
```

What it cannot show: that the gateway recorded every request it received, or that the ledger was not
rebuilt or cut short by whoever holds it. The vault's events onchain are the part nobody can rewrite.

## Run

```bash
pnpm keys:generate     # once: testnet-only keys into .env
pnpm demo              # demo steps on Arbitrum Sepolia, with an Arbiscan link for every transaction
pnpm gateway           # or: just the service, on http://127.0.0.1:8787
```

Settings come from the repository's `.env`:

| Variable                   | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `EXECUTOR_PRIVATE_KEY`     | The gateway's only money-moving key. The vault caps what it can do.        |
| `ARBITRUM_SEPOLIA_RPC_URL` | RPC endpoint. Defaults to the public one.                                  |
| `MANDATE_VAULT_ADDRESS`    | Defaults to the recorded deployment.                                       |
| `GATEWAY_PORT`             | Defaults to 8787.                                                          |
| `GATEWAY_DATA_DIR`         | Ledger, evidence files and `payees.json`. Defaults to `apps/gateway/data`. |

## Tests

```bash
pnpm --filter @agent-gateway/gateway test
```

142 tests: canonical JSON against the RFC 8785 examples, intent signing, the evidence hash, the ledger's
tamper checks, every policy rule and its boundaries, the gateway and its HTTP API against an in-memory
stand-in for the chain, and the verifier against files that were changed in a dozen ways.

## Not production-ready

- One process, files on disk, no database. Decisions run one at a time.
- No authentication beyond the agent's signature; the read endpoints are open. It listens on localhost only.
- A payment interrupted between decision and confirmation is not resumed.
- Agents must sign with a plain key (ECDSA). Smart-account agents are not supported yet.
- Approvals for payments outside the mandate, and per-call payments over MPP, are the next steps.
