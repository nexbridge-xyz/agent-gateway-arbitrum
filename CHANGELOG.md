# Changelog

What each version holds. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 (not tagged yet)

The first version: the whole demo path on Arbitrum Sepolia, from a mandate to a refused payment, with a
console and a recorded run. Testnet only, not audited.

### Contract

- `MandateVault`, deployed at
  [`0x7293763f6b73783834484cd976528D01Cb6c8CCf`](https://sepolia.arbiscan.io/address/0x7293763f6b73783834484cd976528D01Cb6c8CCf#code)
  on Arbitrum Sepolia, source verified on Arbiscan.
- Holds the principal's USDC. Only the principal deposits, withdraws, creates and revokes mandates, and
  pauses.
- A mandate names an agent (its ERC-8004 id), an executor, an approver, the payees, a cap per payment, a cap
  per UTC day, a hard ceiling per UTC day, an end date and the hash of the text the principal approved.
- `payWithinMandate`: the executor pays a listed payee within the caps.
- `payWithApproval`: the executor submits a payment the approver has signed (EIP-712), within the hard
  ceiling. Each approval has a number and a deadline and works once. A smart-account approver is asked
  through ERC-1271.
- Every payment carries an evidence hash in its event, and the vault accepts each hash once.
- No upgrade path and no admin role.
- 157 tests: unit, fuzz, invariant, the bound on a stolen executor key, and the tests of the security
  review before publication. Every line, statement, branch and function of `MandateVault` is covered.
  Sixteen more tests run on a fork of Arbitrum Sepolia.

### Gateway

- `POST /v1/payment-intents`: an agent's signed request gets one of three decisions, `auto`,
  `needs_approval` or `refused`, with the reasons.
- Identity: the request must be signed by the wallet registered for the agent in the ERC-8004 Identity
  Registry.
- Policy: fourteen checks in plain code, no model. A payee that is not in the principal's vendor registry
  is refused, wherever the agent found its address.
- Approvals and declines, signed by the approver. The gateway checks an approval the way the vault will
  before it sends anything.
- Per-call purchases over MPP: the vault funds a spend wallet with exactly the price of one call, and the
  spend wallet pays the merchant. Three more checks apply.
- Several mandates per agent, chosen by a fixed rule.
- An evidence record for every decision (canonical JSON, RFC 8785, hashed with keccak256) and a
  hash-chained ledger.
- `pnpm verify-evidence` checks evidence files against the chain without trusting the gateway.
- Read endpoints for the console. The gateway answers local requests only.
- 288 tests, and eleven more on a fork, seven of which make a real purchase.

### Demo merchant and agent

- A market-data API that charges 0.10 USDC per call over MPP, with `mppx` and `@arbitrum/mpp`. One of its
  answers carries a planted note that asks for money.
- A research and procurement agent with two tools, `get_market_data` and `request_payment`. It is Claude
  with tool use when an API key is set, and a scripted agent otherwise.
- 16 and 45 tests.

### Console

- Five screens: live feed, approvals, mandates, evidence and ledger.
- The approver signs or declines with a wallet. The principal creates and revokes mandates with a wallet.
  The console holds no key.
- Mandates are read from the vault and drawn to scale. Amounts carry a yen figure at a fixed, labelled demo
  rate.
- It can be used with the keyboard alone, and it respects "reduce motion".
- 72 tests, among them the console against the gateway's real code.

### Demo and records

- `pnpm demo` runs seven steps on Arbitrum Sepolia and prints an Arbiscan link for every transaction: set
  up, a per-call purchase, a vendor payment, an approved payment, a planted note that is refused, three
  "gateway compromised" drills that the vault reverts, and a revocation.
- `pnpm demo --console` runs it next to the console, with the approval signed there.
- `pnpm demo:record` turns a run into [`docs/sepolia-run`](docs/sepolia-run/README.md) and the demo table in
  the README.

### Repository

- CI: contract tests with coverage, lint, typecheck, the TypeScript tests, a build of the console, a
  self-check of the recorded evidence, a dependency audit, and a secret scan of the full history.
- Docs: [`README`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`SECURITY.md`](SECURITY.md),
  [`CONTRIBUTING.md`](CONTRIBUTING.md), and a README for each package.

### Known limits

See "Known limitations of the deployed contract" and "Not production-ready" in [`SECURITY.md`](SECURITY.md).
