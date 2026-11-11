# Agent Gateway on Arbitrum

**Agents get a mandate, never the keys.**

Agent Gateway is a spending-control layer for AI agents that pay in stablecoins on Arbitrum.
A company gives each agent an identity and a mandate: whom it may pay, how much per payment and per day,
and until when. Payments inside the mandate go through on their own. Payments outside it wait for a person
to approve. Payments against the rules are refused. Every decision leaves an evidence record whose hash is
anchored onchain.

> Status: work in progress. Testnet demo only. Not audited. Do not use with real funds.

## How it fits together

Control has two layers:

1. **Gateway service** (offchain): checks each payment request against the mandate, routes approvals and
   writes the evidence record.
2. **`MandateVault`** (onchain, Arbitrum): holds the company's USDC and enforces hard limits. Even if the
   gateway is compromised, it cannot move more than the vault's caps allow.

The company owns the vault and the funds. The gateway holds only a capped executor role.

## Repository layout

| Path             | What                                                                | Status             |
| ---------------- | ------------------------------------------------------------------- | ------------------ |
| `apps/contracts` | `MandateVault` and its tests (Solidity, Foundry)                    | Contract and tests |
| `apps/gateway`   | Identity, policy, approvals and evidence service (TypeScript, viem) | Planned            |
| `apps/merchant`  | Demo market-data API paid per call                                  | Planned            |
| `apps/agent`     | Demo research and procurement agent                                 | Planned            |
| `apps/console`   | Web console for mandates, approvals and evidence (React, wagmi)     | Planned            |

## Quickstart

Needs Node 22, pnpm (through `corepack enable`) and [Foundry](https://getfoundry.sh).

```bash
git clone --recurse-submodules https://github.com/nexbridge-xyz/agent-gateway-arbitrum.git
cd agent-gateway-arbitrum
corepack enable && pnpm install
pnpm contracts:test
```

See [`apps/contracts`](apps/contracts/README.md) for what the vault enforces, how it is tested and how to
deploy it to Arbitrum Sepolia.

## License

[MIT](LICENSE). Copyright (c) 2026 NexBridge Inc.
