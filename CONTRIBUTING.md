# Contributing

Agent Gateway is a testnet demo, and it is kept small on purpose. Issues and pull requests are welcome.
For a security problem, do not open an issue: see [`SECURITY.md`](SECURITY.md).

## Set up

You need Node 22 or later, [Foundry](https://getfoundry.sh) 1.0 or later, and git.

```bash
git clone --recurse-submodules https://github.com/nexbridge-xyz/agent-gateway-arbitrum.git
cd agent-gateway-arbitrum
nvm use
corepack enable
pnpm install
```

`nvm use` selects Node 22 from `.nvmrc`, and `corepack enable` provides pnpm at the version pinned in
`package.json`.

Nothing above needs a key. Tests run without keys and without a network. To run the demo on Arbitrum
Sepolia you need testnet keys and your own vault: see the quickstart in the [README](README.md).

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) says how the parts fit together and where to read the code.

## Before you open a pull request

```bash
pnpm format
pnpm lint
pnpm test
```

- `pnpm format` runs Prettier for TypeScript and Markdown, and `forge fmt` for Solidity.
- `pnpm lint` is the format check, ESLint, the typecheck, and a contract build that fails on warnings.
- `pnpm test` runs the contract tests (Foundry) and the tests of every TypeScript package (vitest).

CI runs the same checks on every pull request and on every push to `main`, and also:

- the contract tests with coverage. `MandateVault` has every line covered; keep it that way
  (`pnpm contracts:coverage`);
- a check that the exported ABI matches the contract (`pnpm --filter @agent-gateway/contracts run abi:check`);
- a production build of the console;
- every evidence file in `docs/sepolia-run`, checked against itself;
- `pnpm audit --prod`: an advisory for a dependency that runs fails the build, unless
  `pnpm-workspace.yaml` lists it under `auditConfig` with the reason;
- a secret scan of the full history with gitleaks, after a test of its rules on made-up secrets
  (`bash scripts/check-secret-scan.sh`, which needs gitleaks);
- a check that git ignores the files keys live in (`bash scripts/check-ignored-files.sh`).

Two more suites need a fork of Arbitrum Sepolia and so a network. CI skips them with a warning when the
public endpoint does not answer. When it answers, a failing test fails the build:

```bash
pnpm --filter @agent-gateway/contracts run test:fork
anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc --port 8546
MPP_FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @agent-gateway/gateway test
```

## Commits

- [Conventional Commits](https://www.conventionalcommits.org): `feat(gateway): …`, `fix(console): …`,
  `test(contracts): …`, `docs: …`, `ci: …`.
- Small commits, one topic each. Say in the message why the change is needed, not only what it does.
- A change in behaviour comes with a test that fails without it.

## Rules of the house

- **No secrets, ever.** Keys live only in `.env`, which git ignores. Do not paste a key into an issue, a
  commit, a test or a log. Tests create throwaway keys at run time. A private key looks like a hash, so
  the secret scan reports every 32-byte hex value outside the places where hashes belong. If it reports
  a public value of yours, add it to the list in `.gitleaks.toml` with the reason.
- **Testnet only.** The gateway refuses to start on any chain but Arbitrum Sepolia.
- **Say only what can be checked.** A claim in the docs points to a transaction, a test or a source. Say
  what is onchain and what is only in the gateway's files. No "first", no "only", no claims of audits.
- **Fictional names only** in demo data, screenshots and examples. No real companies, no third-party logos.
- **English** for code, comments, the console and the docs.
- **Pinned dependencies.** Exact versions. Shared ones are in the catalog in `pnpm-workspace.yaml`.
- **Commands that can be pasted.** A command in the docs has no comment after it, and its block holds
  nothing but commands. An interactive zsh has no comments: it passes one on to the command as arguments.
  Put notes in the text around the block, and commands for two terminals in two blocks.

## Things that are generated

Do not edit these by hand:

| What                                                                     | Made by                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `docs/sepolia-run/`                                                      | `pnpm demo:record`, from the latest run. The run's files are kept byte for byte. |
| The demo table and the gas figures in `README.md`, between their markers | `pnpm demo:record`                                                               |
| `apps/contracts/abi/`                                                    | `pnpm --filter @agent-gateway/contracts run build`                               |
| `apps/console/src/components/ui/`                                        | The shadcn CLI. Restyle through class names where they are used.                 |

`pnpm demo:record` takes the gas figures from the run log, which holds the gas and the fee of every
transaction. A log without them leaves the figures as they are. The run of 2026-11-12 has such a log: its
figures were entered by hand, and they agree with the receipts of its transactions.

## Changing the contract

The vault on Arbitrum Sepolia cannot be changed: it has no upgrade path. A change to
`apps/contracts/src/MandateVault.sol` therefore means a new deployment, a new address in the docs, and a
new recorded run. Open an issue first.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
