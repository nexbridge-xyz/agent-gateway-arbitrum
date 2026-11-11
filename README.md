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

Needs Node 22 or later, pnpm and [Foundry](https://getfoundry.sh) 1.0 or later.

- **Node.** `.nvmrc` selects Node 22 for `nvm use` and `fnm use`. `package.json` states the same minimum in
  `engines` and `devEngines`, and pnpm stops with a clear error on an older Node.
- **pnpm.** `corepack enable` provides the version pinned in `package.json`.

```bash
git clone --recurse-submodules https://github.com/nexbridge-xyz/agent-gateway-arbitrum.git
cd agent-gateway-arbitrum
nvm use                # Node 22, from .nvmrc
corepack enable        # pnpm, at the version pinned in package.json
pnpm install
pnpm contracts:test
```

See [`apps/contracts`](apps/contracts/README.md) for what the vault enforces, how it is tested and how to
deploy it to Arbitrum Sepolia.

## Versions

| Component              | Version | Where it is pinned                    |
| ---------------------- | ------- | ------------------------------------- |
| Solidity               | 0.8.30  | `apps/contracts/foundry.toml`         |
| OpenZeppelin Contracts | 5.7.0   | git submodule in `apps/contracts/lib` |
| forge-std              | 1.17.0  | git submodule in `apps/contracts/lib` |
| `@arbitrum/mpp`        | 0.1.0   | `catalog` in `pnpm-workspace.yaml`    |
| `mppx`                 | 0.6.31  | `catalog` in `pnpm-workspace.yaml`    |
| viem                   | 2.57.15 | `catalog` and `overrides`, same file  |
| pnpm                   | 12.18.0 | `packageManager` in `package.json`    |

Per-call payments use the Machine Payments Protocol (MPP) through
[`@arbitrum/mpp`](https://github.com/OffchainLabs/arbitrum-mpp), Offchain Labs' Arbitrum charge method for
[`mppx`](https://github.com/wevm/mppx). `@arbitrum/mpp` 0.1.0 is an early release and requires `mppx` `^0.6.7`,
so the demo merchant and the gateway's MPP client both use `mppx` 0.6.31, the newest release in that line.
`mppx` 0.6 in turn sets the viem version. These pins move forward once `@arbitrum/mpp` supports a current
`mppx`.

## License

[MIT](LICENSE). Copyright (c) 2026 NexBridge Inc.
