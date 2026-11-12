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
   `needs_approval` or `refused`. A per-call purchase gets three more checks.
4. **Evidence.** The gateway writes down who asked, what for and how each check went. The record's
   keccak256 hash over its canonical JSON (RFC 8785) is the evidence hash.
5. **Execution.**
   - `auto` is paid at once with `payWithinMandate(mandateId, payee, amount, evidenceHash)`, so the vault's
     event points at the record.
   - `needs_approval` waits until the mandate's approver signs. The gateway then pays with
     `payWithApproval`, and the vault checks the signature itself.
   - `refused` sends nothing.
6. **Ledger.** Every decision, approval and payment is appended to a hash-chained ledger.

The vault enforces the mandate's limits on its own. If the gateway decided wrongly, or its executor key were
stolen, the vault would still refuse anything outside those limits.

## API

| Method and path                        | What it does                                                                |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/payment-intents`             | Decide one signed intent and pay it if the decision is `auto`.              |
| `GET /v1/payment-intents/:intentId`    | The evidence file for one intent.                                           |
| `GET /v1/approvals`                    | Payments waiting for an approver, each with the EIP-712 message to sign.    |
| `POST /v1/approvals/:intentId`         | The approver's signature. The gateway checks it and pays through the vault. |
| `POST /v1/approvals/:intentId/decline` | The approver's signed refusal.                                              |
| `GET /v1/ledger`                       | The ledger, with the result of checking its hash chain.                     |
| `GET /healthz`                         | Chain, vault, executor and spend wallet address.                            |

The [console](../console/README.md) also reads these:

| Method and path                                  | What it does                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `GET /v1/payment-intents?limit=`                 | The newest decisions first, one summary each. At most 500.                               |
| `GET /v1/payment-intents/:intentId/verification` | The evidence file checked against the chain and the ledger, check by check.              |
| `GET /v1/config`                                 | Chain, vault, principal, token, executor, spend wallet and the explorer's address.       |
| `GET /v1/payees`                                 | The principal's vendor registry and denylist, for showing names next to addresses.       |
| `GET /v1/mandate-terms/:termsHash`               | The plain text of a mandate, by the hash the vault stores for it.                        |
| `PUT /v1/mandate-terms/:termsHash`               | Stores a mandate's text (`text/plain`, at most 16 KB). Accepted only under its own hash. |

The types of all answers are exported from [`src/server.ts`](src/server.ts), and the console takes its
types from there.

The gateway answers requests addressed to this machine only (`127.0.0.1`, `localhost`, `[::1]`). A request
that names another host gets `403`: it has been pointed here by a web page elsewhere.

A request:

```json
{
  "intent": {
    "agentId": "354",
    "payee": "0x84d6943216c05bc96b72791d5a76875e08D539F0",
    "amount": "1500000",
    "purpose": "Invoice KS-2026-1107: packing materials, November",
    "invoiceId": "KS-2026-1107",
    "context": {},
    "nonce": "0x…32 random bytes",
    "expiresAt": 1794455209
  },
  "signature": "0x…65 bytes"
}
```

`amount` is in the token's smallest unit: `1500000` is 1.50 USDC. `expiresAt` may be at most 15 minutes
ahead. The answer:

```json
{
  "intentId": "0xfacad653…98fc784b",
  "decision": "auto",
  "reasons": ["All 14 checks passed"],
  "status": "paid",
  "evidenceHash": "0xaec6fba1…55af517b",
  "transactionHash": "0x88770bd7…7cbae77f",
  "error": null,
  "purchase": null,
  "explorerUrl": "https://sepolia.arbiscan.io/tx/0x88770bd7…7cbae77f",
  "settlementUrl": null
}
```

The intent id is the EIP-712 hash of the intent. Sending the same intent again returns the same answer and
never pays twice. A body that is not a well-formed signed intent gets `400` and leaves no record.

Build and sign an intent with the helpers in [`src/protocol`](src/protocol):

```ts
import { signIntent } from '@agent-gateway/gateway/protocol';

const signed = await signIntent(agentAccount, { chainId: 421614, vault }, intent);
```

## Approvals

A payment that fails only soft checks waits for the mandate's approver. `GET /v1/approvals` lists it with
the exact typed data to sign:

```
PaymentApproval(uint256 mandateId,address payee,uint256 amount,bytes32 evidenceHash,uint256 nonce,uint256 deadline)
domain: MandateVault, version 1, chain 421614, the vault's address
```

The approver signs that message in a wallet and posts `{ "signature", "deadline" }` to
`POST /v1/approvals/:intentId`. Before paying, the gateway:

1. reads the chain again, because the world may have changed while the request waited. A mandate that was
   revoked, a payee that was put on the denylist or a day total at the hard ceiling stops the payment with
   `409` and the reasons;
2. checks the signature the way the vault will: it must be the approver's, for this payee, amount,
   evidence hash and the mandate's current approval number. Anyone else's signature gets `400`, and that
   includes the gateway's own executor key. If the approver's address has contract code, which is the case
   for a smart account and for a key with an EIP-7702 delegation, the vault does not check the key: it asks
   that code through ERC-1271. The gateway then asks the same question, and answers `400` if the code does
   not confirm the signature. In both cases nothing is sent and the request stays open.

Then it calls `payWithApproval`. The vault checks the same signature onchain and counts the payment toward
the day's hard ceiling. An approval covers one payment: its number is used up, and its evidence hash can be
paid once.

To say no, the approver signs `ApprovalDecline(bytes32 intentId,bytes32 evidenceHash)` in the gateway's own
domain (`AgentGateway`, version 1) and posts it to `/decline`. Nothing is paid and the decline is kept as
evidence.

## Per-call purchases

Some APIs charge per call: they answer `402 Payment Required` and name a price (the
[Machine Payments Protocol](https://mpp.dev/protocol), MPP). The agent cannot pay that itself, so it sends
an intent whose `context.mpp.resource` is the URL it wants. The gateway then buys the call:

1. **Policy**, with three extra hard checks: the gateway has a spend wallet; the resource is on the API
   address the principal registered for this merchant (`origin` in `payees.json`); the price is within the
   per-call cap (0.50 USDC by default).
2. **Top-up.** The vault pays the gateway's **spend wallet** exactly the price, with `payWithinMandate`,
   under the mandate that lists the spend wallet. In the demo that is a small mandate of its own (0.50 USDC
   per payment, 1 USDC per day), so the vault itself bounds everything the spend wallet can ever pay.
3. **Purchase.** The spend wallet asks for the resource, checks the merchant's payment challenge and
   answers it with a signed USDC transfer authorization (EIP-3009). It signs only if the challenge asks for
   exactly the approved token, amount and registered merchant, as one plain authorization. The merchant
   submits the transfer and pays the gas.
4. **Result.** The data goes back to the agent. The evidence keeps the merchant's settlement transaction
   and a hash of the response, not the response itself.

What is onchain: the vault's payment to the spend wallet carries the evidence hash in the vault's event. The
settlement, the spend wallet's transfer to the merchant, is a plain USDC transfer and does not. The evidence
file links the two, and `verify-evidence` checks the settlement.

A purchase is paid at once or refused. It never waits for an approver, because nobody is there to wait
while an API call is open: a purchase that would need approval is refused instead.

The gateway fetches only from the registered API address and does not follow redirects, so an agent cannot
use it to reach other addresses.

Uses the [`@arbitrum/mpp`](https://github.com/OffchainLabs/arbitrum-mpp) client with `mppx`. The demo
merchant is in [`apps/merchant`](../merchant/README.md).

## More than one mandate

An agent can hold several mandates, each with its own payees and caps in the vault. The demo's agent has
two: one for vendor invoices, and a small one that lists only the gateway's spend wallet. For each request
the gateway uses:

1. the newest live mandate that lists the address the vault would pay. For a purchase that address is the
   spend wallet, so purchases fall under the spend wallet's mandate and its caps;
2. if no live mandate lists the address, the live mandate with the highest hard ceiling. The payment can
   then only go through with the approver's signature.

Only mandates with this gateway as executor count. A request that waits for approval stays with the mandate
it was decided under. The rule is a pure function in [`src/chain/mandates.ts`](src/chain/mandates.ts).

Keeping the spend wallet off the vendor mandate matters because the gateway holds the spend wallet's key:
with a mandate of its own, the most that key can ever receive is that mandate's daily cap. See
[`SECURITY.md`](../../SECURITY.md).

## Policy

A failed **hard** check refuses the request. A failed **soft** check sends it to the approver. If nothing
fails, the payment goes through on its own.

| Check                        | Kind | Passes when                                                                            |
| ---------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `request_current`            | hard | The request has not expired and is valid for at most 15 minutes.                       |
| `agent_registered`           | hard | The agent id exists in the ERC-8004 Identity Registry.                                 |
| `agent_active`               | hard | The agent's onchain registration file does not say `active: false`.                    |
| `agent_signature`            | hard | The request is signed by the agent's registered wallet.                                |
| `mandate_active`             | hard | The agent has a mandate that is not revoked or expired, with this gateway as executor. |
| `vault_open`                 | hard | The principal has not paused the vault.                                                |
| `payee_not_denied`           | hard | The payee is not on the gateway's denylist.                                            |
| `payee_in_vendor_registry`   | hard | The payee is in the principal's vendor registry.                                       |
| `amount_positive`            | hard | The amount is more than zero.                                                          |
| `within_hard_ceiling`        | hard | Today's total, with this payment, stays within the mandate's hard ceiling.             |
| `vault_funded`               | hard | The vault holds enough of the token.                                                   |
| `payee_on_allowlist`         | soft | The payee is on the mandate's allowlist.                                               |
| `within_per_payment_cap`     | soft | The amount is within the per-payment cap.                                              |
| `within_daily_cap`           | soft | Today's total, with this payment, stays within the daily cap.                          |
| `purchase_spend_wallet`      | hard | Purchases only: the gateway has a spend wallet.                                        |
| `purchase_origin_registered` | hard | Purchases only: the resource is on the merchant's registered API address.              |
| `purchase_within_call_cap`   | hard | Purchases only: the price is within the gateway's per-call cap.                        |

For a purchase the three soft checks are hard, and the allowlist check is about the spend wallet, which is
the address the vault pays.

The vendor registry and the denylist are the principal's own files (`payees.json` in the data folder). They
are the only trusted answer to "who is this payee". An address that the agent found in something it read,
such as a tool response or an invoice, is refused unless the principal has registered it. The agent can
say where it found an address in `context.payeeSource`; the gateway records that and never trusts it.

The engine is a pure function in [`src/policy/evaluate.ts`](src/policy/evaluate.ts). It uses the same
inclusive bounds as the vault, and a test restates the vault's rules to show the gateway never lets through
on its own what the vault would refuse.

## Evidence

Each decision produces one file, `evidence/<intentId>.json`:

| Part           | Contents                                                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record`       | Who (agent, agent wallet, principal, mandate, executor, approver), what (payee, amount, purpose, invoice), the signed request, and why: the decision, the reasons and every check with pass, fail or skipped. Also the block the decision was based on and, for a purchase, the resource and the spend wallet. |
| `evidenceHash` | keccak256 of the canonical JSON of `record`. This is what the vault anchors.                                                                                                                                                                                                                                   |
| `approval`     | The approver's signature, its approval number and deadline, for a payment outside the mandate.                                                                                                                                                                                                                 |
| `result`       | What happened: paid (transaction hash, block, event, and for a purchase the merchant's settlement), pending approval, declined (with the approver's signature), refused or failed.                                                                                                                             |

Only `record` is hashed. It is fixed when the decision is made, before any transaction exists, so the
transaction can carry its hash. The vault accepts each evidence hash once. The approver signs over the same
hash, so an approval is tied to one record.

## Check an evidence file

```bash
pnpm verify-evidence <file>... [--offline] [--rpc <url>] [--ledger <file>]
```

It takes one file or several, prints PASS or FAIL for each check, and exits with 0 only if all pass:

- the evidence hash is the hash of the record, and the intent id is the hash of the signed request;
- the request signature recovers the recorded signer, and the record says what the agent signed;
- the decision follows from the recorded checks, and the result fits the decision;
- an approval, if there is one, is signed by the mandate's approver for this payee, amount and evidence
  hash; a decline is signed by the approver for this request;
- onchain: the vault's settings, the agent wallet in the ERC-8004 registry, the transaction, and a vault
  event with this evidence hash and the same mandate, agent, payee and amount;
- for a purchase: the vault's event pays the spend wallet, and the merchant's settlement transaction moves
  the same amount from the spend wallet to the merchant;
- the ledger's hash chain is intact and records the decision, the approval and the payment.

A file from someone else is treated as untrusted: a file of the wrong shape is rejected outright, and its
text is printed with control characters escaped.

Try it on the run recorded in [`docs/sepolia-run`](../../docs/sepolia-run/README.md). No keys are needed:

```bash
pnpm verify-evidence docs/sepolia-run/evidence/*.json
```

What it cannot show: that the gateway recorded every request it received, or that the ledger was not
rebuilt or cut short by whoever holds it. The vault's events onchain are the part nobody can rewrite.

## Run

```bash
pnpm keys:generate     # once: testnet-only keys into .env
pnpm demo              # demo steps on Arbitrum Sepolia, with an Arbiscan link for every transaction
pnpm gateway           # or: just the service, on http://127.0.0.1:8787
pnpm demo --console    # or: the demo next to the console, with step 4 signed there
```

Settings come from the repository's `.env`:

| Variable                    | Meaning                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `EXECUTOR_PRIVATE_KEY`      | The gateway's key for the vault. The vault caps what it can do.                     |
| `SPEND_WALLET_PRIVATE_KEY`  | The low-value wallet that pays per-call charges. Without it, purchases are refused. |
| `GATEWAY_PURCHASE_CALL_CAP` | The most the gateway pays for one API call, in USDC. Defaults to 0.5.               |
| `ARBITRUM_SEPOLIA_RPC_URL`  | RPC endpoint. Defaults to the public one.                                           |
| `MANDATE_VAULT_ADDRESS`     | Defaults to the recorded deployment.                                                |
| `GATEWAY_PORT`              | Defaults to 8787.                                                                   |
| `GATEWAY_DATA_DIR`          | Ledger, evidence files and `payees.json`. Defaults to `apps/gateway/data`.          |

## Tests

```bash
pnpm --filter @agent-gateway/gateway test
```

253 tests: canonical JSON against the RFC 8785 examples, intent signing, the evidence hash, the ledger's
tamper checks, every policy rule and its boundaries, the gateway and its HTTP API against an in-memory
stand-in for the chain, approvals and declines (wrong signer, the executor's own signature, a changed
amount, an expired deadline, a used approval number, a mandate revoked while the request waited, an
approver address with contract code), per-call purchases (a challenge for another price, recipient or
token, a redirect, a resource on another address), the choice among an agent's mandates, the endpoints the
console reads, the texts of mandates, requests addressed to another host, and the verifier against files
that were changed in two dozen ways.

Seven more tests make a real purchase from the demo merchant, with settlement, on a local fork of Arbitrum
Sepolia. They run when a fork is given:

```bash
anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc --port 8546
MPP_FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @agent-gateway/gateway test
```

## Not production-ready

- One process, files on disk, no database. Decisions run one at a time.
- No authentication beyond signatures: the agent's on a request, the approver's on an approval. The read
  endpoints are open. It listens on localhost only.
- A payment interrupted between decision and confirmation is not resumed.
- If a purchase fails after the vault has funded the spend wallet, the amount stays in the spend wallet. It
  has counted toward the day's caps, and the principal, who holds that key, can move it back.
- The per-call cap (`GATEWAY_PURCHASE_CALL_CAP`) is the gateway's own check. The onchain bound on the spend
  wallet is the mandate that lists it. A principal who lists the spend wallet on a wide mandate gives it
  that mandate's caps.
- Agents and approvers must sign with a plain key (ECDSA). The vault also accepts a smart-account approver
  (ERC-1271); the gateway does not pass such approvals through yet.
