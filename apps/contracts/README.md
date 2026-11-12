# MandateVault

`MandateVault` holds a company's USDC on Arbitrum and pays it out only under mandates the company has set.
It is the onchain half of Agent Gateway: the gateway service decides and records, the vault enforces.

> Testnet demo. Not audited. Do not use with real funds.

## Deployed on Arbitrum Sepolia

| Item                   | Value                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MandateVault`         | [`0x7293763f6b73783834484cd976528D01Cb6c8CCf`](https://sepolia.arbiscan.io/address/0x7293763f6b73783834484cd976528D01Cb6c8CCf#code)                         |
| Source                 | Verified on Arbiscan. Exact match on [Sourcify](https://repo.sourcify.dev/421614/0x7293763f6b73783834484cd976528D01Cb6c8CCf).                               |
| Deployment transaction | [`0x603faebb…e9ba2834`](https://sepolia.arbiscan.io/tx/0x603faebb93056f90439d871951ebdd449775a6c7ac2856de9398cef7e9ba2834), block 328251484, 2026-11-11 UTC |
| Principal              | `0xd42f974802a327789F217Db9f61DeA26EA5418A5`, a demo key                                                                                                    |
| Token                  | Circle test USDC, `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`                                                                                              |
| Identity Registry      | ERC-8004, `0x8004A818BFB912233c491871b3d84c89A494BD9e`                                                                                                      |

The same data is in [`deployments/arbitrum-sepolia.json`](deployments/arbitrum-sepolia.json), and Foundry's
broadcast log is in `broadcast/`. `pnpm test:fork` checks that the code at this address is byte for byte
what this repository builds.

## Roles

| Role      | Who                                          | Can do                                                                                   |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Principal | The company that owns the funds              | Deposit, withdraw, create and revoke mandates, pause and unpause. Fixed at deployment.   |
| Executor  | The gateway service, named per mandate       | Submit payments for that mandate, inside its limits.                                     |
| Approver  | A person or smart account, named per mandate | Sign an approval for one exact payment outside the mandate. Never submits a transaction. |
| Agent     | An AI agent with an ERC-8004 identity        | Nothing onchain. The mandate and every payment event carry its `agentId`.                |

There is no other role: no owner, no admin, no upgrade path.

## What a mandate allows

A mandate names an agent, an executor, an approver, a list of allowed payees, three limits and an expiry.
Its terms never change. It can only be revoked.

| Payment                                | Function           | Needs                         | Limits enforced by the vault                                                             |
| -------------------------------------- | ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Inside the mandate                     | `payWithinMandate` | The executor                  | Payee on the allowlist. At most `perPaymentCap` per payment and `dailyCap` per UTC day.  |
| Outside the mandate                    | `payWithApproval`  | The executor and the approver | At most `hardCeiling` per UTC day in total, counting every payment the mandate has made. |
| Anything after revoke, expiry or pause | none               |                               | Reverts.                                                                                 |

So if the executor key is stolen, the most it can move is `dailyCap` per day, and only to payees the
principal listed. If the executor and approver keys are both stolen, the most they can move is `hardCeiling`
per day, until the principal revokes the mandate or pauses the vault.

An agent can hold more than one mandate, and each counts its own day. The demo uses that to keep the
gateway's spend wallet, whose key the gateway holds, on a small mandate of its own (0.50 USDC per payment,
1 USDC per day) and off the vendor mandate. A thief with the gateway's keys can then move at most 1 USDC a
day to an address of their own. See [`SECURITY.md`](../../SECURITY.md).

## Design notes

- **UTC day buckets.** `day = block.timestamp / 86400`. Daily counters reset at 00:00 UTC (09:00 JST).
  On Arbitrum the block time is the sequencer's clock, which is accurate to well within a day.
- **One counter per day.** Approved payments count toward the same day total as payments inside the mandate.
  Once the total reaches `dailyCap`, every further payment that day needs an approval.
- **Approvals are EIP-712 messages.** The approver signs
  `PaymentApproval(mandateId, payee, amount, evidenceHash, nonce, deadline)` for the domain
  `MandateVault` / version `1` / this chain / this contract. `nonce` is the mandate's current
  `approvalNonce`. An approval works once, only for that payment, and only until its deadline.
  `SignatureChecker` accepts an ERC-1271 smart account such as a Safe as the approver.
- **Two keys for anything outside the mandate.** Only the executor can submit an approved payment, and
  the executor and approver must be different accounts.
- **Evidence.** Every payment carries an `evidenceHash`: the keccak256 hash of the gateway's evidence record
  for that decision. The vault refuses a zero hash and refuses to use the same hash twice, so one record
  matches exactly one payment. The hash is indexed in the payment event.
- **Agent identity.** `createMandate` checks that `agentId` exists in the ERC-8004 Identity Registry given
  at deployment.
- **Funds.** One vault serves one principal and one token. Withdrawals go to the principal only and keep
  working while the vault is paused.
- **Token.** The vault assumes a plain ERC-20 such as USDC: no transfer fees, no rebasing, no hooks.

Events are the onchain audit trail: `MandateCreated`, `MandateRevoked`, `MandatePayment`, `ApprovedPayment`,
`Deposited`, `Withdrawn`, plus `Paused` and `Unpaused`.

## Test

Needs [Foundry](https://getfoundry.sh) 1.0 or later.

```bash
git submodule update --init --recursive
cd apps/contracts
forge test
pnpm test:fork
pnpm coverage
```

`forge test` runs the unit, fuzz and invariant tests. `pnpm test:fork` runs the demo's onchain steps and
the check of the live deployment on a fork of Arbitrum Sepolia.

| Suite                               | What it checks                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/MandateVault.t.sol`           | 80 unit tests: every function, every revert, and the "gateway compromised" drill.                                                                                                                |
| `test/MandateVault.fuzz.t.sol`      | 22 property tests over random inputs: caps, expiry, allowlist, roles, approvals, revoke, pause.                                                                                                  |
| `test/MandateVault.invariant.t.sol` | 5 invariants over random call sequences by every role, checked against the test's own books.                                                                                                     |
| `test/MandateVault.split.t.sol`     | 8 tests of the demo's two mandates: what a stolen executor key can do with a vendor mandate and a small spend wallet mandate, including a fuzz test over arbitrary payment sequences.            |
| `test/fork/`                        | 5 tests on a fork of Arbitrum Sepolia: the demo's onchain steps against Circle's test USDC and the live ERC-8004 Identity Registry, and a check that the deployed vault matches this repository. |

Coverage of `src/MandateVault.sol` (`pnpm coverage`):

| Lines            | Statements       | Branches       | Functions      |
| ---------------- | ---------------- | -------------- | -------------- |
| 100% (109 / 109) | 100% (137 / 137) | 100% (31 / 31) | 100% (19 / 19) |

## Deploy to Arbitrum Sepolia

1. Make fresh testnet-only keys. They are written to `.env`.

   ```bash
   pnpm keys:generate
   ```

2. Fund `DEPLOYER_ADDRESS` with a little Sepolia ETH, and set `ETHERSCAN_API_KEY` in `.env`.

3. Simulate the deployment. Nothing is sent.

   ```bash
   pnpm --filter @agent-gateway/contracts deploy:sepolia:dry-run
   ```

4. Deploy, record the address and verify the source.

   ```bash
   pnpm --filter @agent-gateway/contracts deploy:sepolia
   ```

The script refuses any chain other than Arbitrum Sepolia (421614). It writes the address to
`deployments/arbitrum-sepolia.json` and verifies the source on Arbiscan.

## Use from TypeScript

`pnpm --filter @agent-gateway/contracts build` writes the ABI to `abi/MandateVault.ts` (`as const`, for viem
and wagmi) and `abi/MandateVault.json`.

```ts
import { mandateVaultAbi } from '@agent-gateway/contracts/abi';
```
