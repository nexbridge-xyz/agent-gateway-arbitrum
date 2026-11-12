# Agent Gateway on Arbitrum

**Agents get a mandate, never the keys.**

Agent Gateway is a spending-control layer for AI agents that pay in stablecoins on Arbitrum.
A company gives each agent an identity and a mandate: whom it may pay, how much per payment and per day,
and until when. Payments inside the mandate go through on their own. Payments outside it wait for a person
to approve. Payments against the rules are refused. Every decision leaves an evidence record whose hash is
anchored onchain.

**Live on Arbitrum Sepolia:** `MandateVault` at
[`0x7293763f6b73783834484cd976528D01Cb6c8CCf`](https://sepolia.arbiscan.io/address/0x7293763f6b73783834484cd976528D01Cb6c8CCf#code),
source verified on Arbiscan.

> Status: work in progress. Testnet demo only. Not audited. Do not use with real funds.

## How it fits together

Control has two layers:

1. **Gateway service** (offchain): checks each payment request against the mandate, routes approvals and
   writes the evidence record.
2. **`MandateVault`** (onchain, Arbitrum): holds the company's USDC and enforces hard limits. Even if the
   gateway is compromised, it cannot move more than the vault's caps allow.

The company owns the vault and the funds. The gateway holds only a capped executor role.

## Repository layout

| Path             | What                                                                                | Status                                    |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `apps/contracts` | `MandateVault` and its tests (Solidity, Foundry)                                    | Deployed and verified on Arbitrum Sepolia |
| `apps/gateway`   | Identity, policy, approvals, per-call purchases and evidence (TypeScript, viem)     | Runs on Arbitrum Sepolia                  |
| `apps/merchant`  | Demo market-data API paid per call over MPP (Express, `mppx`, `@arbitrum/mpp`)      | Runs on Arbitrum Sepolia                  |
| `apps/agent`     | Demo research and procurement agent: Claude with tool use, or a scripted agent      | Runs in the demo                          |
| `apps/console`   | Web console for mandates, approvals and evidence (React, wagmi)                     | Planned                                   |
| `scripts`        | `pnpm demo`, the demo path on Arbitrum Sepolia, and `pnpm demo:record`              |                                           |
| `docs`           | [`sepolia-run`](docs/sepolia-run/README.md): a recorded run with its evidence files |                                           |

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
pnpm test              # contract tests (Foundry) and gateway, merchant and agent tests (vitest)
```

- [`apps/contracts`](apps/contracts/README.md): what the vault enforces, how it is tested and how to deploy it.
- [`apps/gateway`](apps/gateway/README.md): the request format, the policy checks, approvals, per-call
  purchases, the evidence format and how to check an evidence file.
- [`apps/merchant`](apps/merchant/README.md): the demo merchant and how a purchase over MPP works.
- [`apps/agent`](apps/agent/README.md): the demo agent, its two tools and its two modes.

## The demo

`pnpm demo` runs the whole path on Arbitrum Sepolia and prints an Arbiscan link for every transaction.
This is the run recorded in [`docs/sepolia-run`](docs/sepolia-run/README.md): 16 transactions, of which
13 succeeded and 3 reverted. The reverts are the point of step 6.

| Step | What happens                                                                                                                                                                              | Onchain                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | The principal funds the vault, registers the agent in the ERC-8004 Identity Registry and creates the mandate: 2 USDC per payment, 8 per day, hard ceiling 20.                             | [mandate created](https://sepolia.arbiscan.io/tx/0xf22e1f10bcd1b0b57e38a025b2b74896d675f37e95232caa23ca2e427e1ddbec)                                                                                                                                                                                                                                                                                |
| 2    | The agent buys market data over MPP for 0.10 USDC. The gateway decides `auto`: the vault funds the spend wallet with exactly the price, and the spend wallet pays the merchant.           | [funded from the vault](https://sepolia.arbiscan.io/tx/0xf0741e97d3657dedf7d3c7994bcc3306135fa8cbe8435cd6194186fc73e7cb47), [settled by the merchant](https://sepolia.arbiscan.io/tx/0x2e734c7e51c5ef7ed1af9167a60d10de0de422932362664613974cfcbf90b6b8)                                                                                                                                            |
| 3    | The agent asks to pay a known vendor 1.50 USDC. The gateway decides `auto` and pays through the vault.                                                                                    | [paid](https://sepolia.arbiscan.io/tx/0xf065b734f752ed964f3d032cdd4a6ef31bf56dbb76e19a9bf3d828cf62c69af1)                                                                                                                                                                                                                                                                                           |
| 4    | The agent asks to pay a 6 USDC invoice, above the per-payment cap. The gateway decides `needs_approval`. The approver signs (EIP-712), and the vault checks that signature before paying. | [paid with approval](https://sepolia.arbiscan.io/tx/0x4d857a039c04f18f450ed00bf2936c1110401f4786ff6b8bb912b3b5f95d1ad2)                                                                                                                                                                                                                                                                             |
| 5    | A vendor note planted in a market-data response asks for 4 USDC to an unknown address. The gateway decides `refused` and says where the address came from.                                | no transaction; [evidence](docs/sepolia-run/evidence/0x0b2ea794abe2c57f7f09018c687c0958da381c0ef87351d7c8388ad8e07eb2c9.json)                                                                                                                                                                                                                                                                       |
| 6    | "Gateway compromised" drills. The executor key is used directly, without the gateway: to an unlisted address, to a listed vendor above the cap, and with an approval it signed itself.    | reverted by the vault: [`PayeeNotAllowed`](https://sepolia.arbiscan.io/tx/0xeb9a700f8246935a87e63f95ef10c3fc286dbe1c827c031528b03338e8c39673), [`PerPaymentCapExceeded`](https://sepolia.arbiscan.io/tx/0x73942ff99f2220a23f0ff25846ac3da24e94f072b89a1724ed19c6da165354d0), [`InvalidApproval`](https://sepolia.arbiscan.io/tx/0xa86c31de8f74a4cb34d278b3dc212e2d7a08148705b6e7cc83024a3813203ee3) |
| 7    | The principal revokes the mandate. The agent's next request is refused.                                                                                                                   | [revoked](https://sepolia.arbiscan.io/tx/0x198a021b74405f2afb2cdfe2ff18cefbe6a970a56e11e2f19ff206853c296af5)                                                                                                                                                                                                                                                                                        |

Anyone can check the evidence against the chain, without keys. For example, the approved payment of
step 4:

```bash
pnpm verify-evidence docs/sepolia-run/evidence/0x64b65bcc89e6e77be788ceb99b8fd36ebbefb75c32a7083f08f664d5a7253f0e.json
```

To run it yourself you need your own vault, because a vault's principal is fixed when it is deployed:

```bash
pnpm keys:generate               # testnet-only keys for every role, written to .env; prints the addresses
# Send Arbitrum Sepolia ETH to DEPLOYER and at least 12 test USDC to PRINCIPAL (faucet.circle.com).
pnpm contracts:deploy:sepolia    # deploys and verifies; see apps/contracts/README.md
# Put the printed address into .env as MANDATE_VAULT_ADDRESS, then:
pnpm demo
```

- **The agent.** With `ANTHROPIC_API_KEY` in `.env`, the agent is Claude with tool use. Without it, a
  scripted agent runs the same tools through the same gateway and is labelled "Scripted agent". The
  recorded run used the scripted agent.
- **The approver.** In this terminal demo the approver's key signs in the terminal. The console will ask a
  wallet for the same signature.
- **The merchant** runs on localhost; its payments settle on Arbitrum Sepolia.

All company and vendor names in the demo are fictional.

## Versions

| Component              | Version | Where it is pinned                    |
| ---------------------- | ------- | ------------------------------------- |
| Solidity               | 0.8.30  | `apps/contracts/foundry.toml`         |
| OpenZeppelin Contracts | 5.7.0   | git submodule in `apps/contracts/lib` |
| forge-std              | 1.17.0  | git submodule in `apps/contracts/lib` |
| `@arbitrum/mpp`        | 0.1.0   | `catalog` in `pnpm-workspace.yaml`    |
| `mppx`                 | 0.6.31  | `catalog` in `pnpm-workspace.yaml`    |
| viem                   | 2.57.15 | `catalog` and `overrides`, same file  |
| `@anthropic-ai/sdk`    | 1.8.0   | `catalog` in `pnpm-workspace.yaml`    |
| pnpm                   | 12.18.0 | `packageManager` in `package.json`    |

Per-call payments use the Machine Payments Protocol (MPP) through
[`@arbitrum/mpp`](https://github.com/OffchainLabs/arbitrum-mpp), Offchain Labs' Arbitrum charge method for
[`mppx`](https://github.com/wevm/mppx). `@arbitrum/mpp` 0.1.0 is an early release and requires `mppx` `^0.6.7`,
so the demo merchant and the gateway's MPP client both use `mppx` 0.6.31, the newest release in that line.
`mppx` 0.6 in turn sets the viem version. These pins move forward once `@arbitrum/mpp` supports a current
`mppx`.

## License

[MIT](LICENSE). Copyright (c) 2026 NexBridge Inc.
