# Security

> Testnet demo. Not audited. Do not use with real funds.

This page says what Agent Gateway is built to withstand, how, and what it does not cover yet.

## Who holds what

| Key          | Held by                 | What it can do                                                                      |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------- |
| Principal    | The company             | Deposit and withdraw (to itself only), create and revoke mandates, pause the vault. |
| Approver     | A person at the company | Sign an approval for one payment outside a mandate. It cannot submit the payment.   |
| Executor     | The gateway             | Pay inside a mandate, and submit a payment the approver has signed. Nothing else.   |
| Spend wallet | The gateway             | Pay per-call API charges from what the vault sends it.                              |
| Agent        | The AI agent            | Sign payment requests. It holds no funds and cannot move any.                       |

The vault has no owner besides the principal, no upgrade path and no admin function. The principal and the
executor of a mandate cannot be the approver's address: the vault refuses a mandate where executor and
approver are the same.

## The demo's two mandates

The agent holds two mandates in the vault:

- **Vendor invoices**: two listed vendors, 2 USDC per payment, 8 USDC per UTC day, hard ceiling 20 USDC per UTC
  day with approvals included.
- **Spend wallet**: the gateway's spend wallet alone, 0.50 USDC per payment, 1 USDC per UTC day, hard ceiling
  1 USDC.

The spend wallet is not on the vendor mandate's list. This matters because the gateway holds the spend
wallet's key.

## Threats

### The gateway is compromised, or its keys are stolen

A thief who holds every key the gateway holds, the executor key and the spend wallet key, can move **at most
1 USDC per UTC day to an address of their own**: through the spend wallet, 0.50 USDC at a time. Everything
else the executor key can move goes **only to the listed vendors**, within the vendor mandate's caps. The
vault enforces this, not the gateway.

The thief cannot pay any other address, cannot exceed a cap, cannot approve their own payment and cannot
withdraw. Each of these is a revert in the vault:

- `apps/contracts/test/MandateVault.split.t.sol` states the bound as tests, including a fuzz test over
  arbitrary sequences of payments on both mandates.
- The demo sends three such attempts for real with the executor key. The recorded reverts are in
  [`docs/sepolia-run`](docs/sepolia-run/README.md): `PayeeNotAllowed`, `PerPaymentCapExceeded` and
  `InvalidApproval`.

What the thief can still do: make the vault pay a listed vendor up to that mandate's caps without a real
invoice (the money reaches the vendor, not the thief), stop the service, and write false evidence files.
False evidence does not survive a check: the thief cannot forge the agent's or the approver's signature, and
`pnpm verify-evidence` compares every file with the chain.

The numbers above are the demo's. A principal who sets wider caps accepts a wider loss.

**Response:** the principal revokes the mandates or pauses the vault. Either is one transaction and takes
effect at once. A new executor key then gets new mandates.

### The agent is hijacked

Text an agent reads can be written to steer it: a tool response, an invoice, a web page. The agent holds no
key that can move money, so a hijacked agent can only ask. The gateway decides by fixed rules in plain code,
with no model involved. What a hijacked agent can obtain is what its mandates allow anyway: payments to the
listed vendors within the caps, and API purchases within the spend wallet's caps. Anything else is refused
or waits for the approver.

### A payee is planted

The principal's vendor registry is the only trusted answer to "who is this payee". An address that appears
only in something the agent read is refused, whatever the request says about it. The demo plants such a
note in a market-data response and records the refusal. The agent's tools also mark where an address came
from; the gateway records that claim and never relies on it.

### An approval is replayed or misused

An approval is an EIP-712 message for one vault on one chain. It names the mandate, the payee, the amount,
the evidence hash, the mandate's current approval number and a deadline. The vault accepts each approval
number once and each evidence hash once. Only the mandate's executor can submit an approved payment, so it
always takes two keys, and the day's hard ceiling still applies.

### The executor key is lost

Nothing is lost with it but the ability to pay. The principal creates mandates for a new executor key. Funds
stay in the vault, and only the principal can withdraw them.

### A merchant misbehaves

Before the spend wallet signs, the gateway checks the merchant's payment challenge: the token, the exact
amount, the registered merchant as the only recipient, and a plain one-payer authorization. The resource
must be on the API address the principal registered for that merchant, and redirects are not followed. The
spend wallet is funded for one call at a time, so it holds no balance to lose between calls.

### A record is changed after the fact

Every payment **out of the vault** carries the hash of its evidence record in the vault's event, onchain. A
per-call purchase has a second transaction, the spend wallet's transfer to the merchant. That one is a plain
USDC transfer and does **not** carry the hash: the evidence file names it, and `pnpm verify-evidence` checks
that it moved the same amount from the spend wallet to the merchant. The gateway's ledger is hash-chained,
but whoever holds it could rebuild it or cut it short. The vault's events are the part nobody can rewrite.

## Not production-ready

- No audit. The contract is small and tested (unit, fuzz, invariant and fork tests), which is not the same.
- Keys live in a `.env` file on one machine. A real deployment needs a key service or hardware keys, and a
  smart-account principal and approver.
- The gateway is one process with files on disk, listens on localhost, and has no rate limits. Its read
  endpoints are open.
- The gateway trusts its RPC endpoint for the state it decides on. The vault does not: it checks every
  payment itself.
- Daily caps use UTC days. A mandate can pay its daily cap shortly before 00:00 UTC and again shortly after.
- The gateway checks approvals as plain signatures. The vault also accepts a smart-account approver
  (ERC-1271), which the gateway does not pass through yet.
- If a per-call purchase fails after the vault funded the spend wallet, that amount stays in the spend
  wallet until the principal moves it.
- USDC itself can be paused or an address blocked by its issuer. Nothing here changes that.

## Reporting a problem

Please report a vulnerability privately with "Report a vulnerability" on this repository's Security tab, and
do not open a public issue for it.
