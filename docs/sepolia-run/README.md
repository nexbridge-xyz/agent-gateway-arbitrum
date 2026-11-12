# A recorded run on Arbitrum Sepolia

The demo path, run with `pnpm demo` on 2026-11-12 (UTC) against the deployed
[`MandateVault`](https://sepolia.arbiscan.io/address/0x7293763f6b73783834484cd976528D01Cb6c8CCf#code). Steps: gas, 1, 2, 3, 4, 5, 6, 7.
The agent was the **Scripted agent**. The files in this folder are kept exactly as the run wrote them.
All company and vendor names are fictional. This is a testnet demo.

Mandate 1 came from an earlier, partial run of this demo (steps 1, 3 and 6). Step 1 replaced it here. That run is in this folder's git history.

16 transactions: 13 succeeded and 3 reverted. The reverts are the point of step 6.

| Step | What happened | Result | Transaction |
| ---- | ------------- | ------ | ----------- |
| gas | Deployer sends 0.001 ETH to the merchant | Success | [`0xed8040f2…78e66498`](https://sepolia.arbiscan.io/tx/0xed8040f2a23a4f3366c80825b0ed04e04ed268b6884e2ce0444df5e178e66498) |
| 1 | Principal allows the vault to take 3.50 USDC | Success | [`0xdb565afc…5702ac02`](https://sepolia.arbiscan.io/tx/0xdb565afc03898bcb2edc95ec71fd2e45bcf3f3ee9c43b096841d179c5702ac02) |
| 1 | Principal deposits 3.50 USDC into the vault | Success | [`0x1402fef3…d91556db`](https://sepolia.arbiscan.io/tx/0x1402fef388847824287044f1021c06b178d2481caa65dad00dd5c794d91556db) |
| 1 | Principal updates the registration file of agent 354 onchain: "Kirenami research and procurement agent" | Success | [`0x6e0dfa41…8d0d4070`](https://sepolia.arbiscan.io/tx/0x6e0dfa41e43e77f4764042ea891c4218954d09f00b517fd654c448178d0d4070) |
| 1 | Principal revokes mandate 1, to replace it with a new one | Success | [`0x1722bf1c…412789ff`](https://sepolia.arbiscan.io/tx/0x1722bf1cc16f3cd311bde418b63b279375b6aa9780b13fb92fed59a5412789ff) |
| 1 | Principal creates the mandate: 2 per payment, 8 per day, ceiling 20 USDC, 30 days | Success | [`0xf22e1f10…7e1ddbec`](https://sepolia.arbiscan.io/tx/0xf22e1f10bcd1b0b57e38a025b2b74896d675f37e95232caa23ca2e427e1ddbec) |
| 2 | Gateway pays 0.10 USDC from the vault to its spend wallet, to buy from Tsukimi Data | Success | [`0xf0741e97…73e7cb47`](https://sepolia.arbiscan.io/tx/0xf0741e97d3657dedf7d3c7994bcc3306135fa8cbe8435cd6194186fc73e7cb47) |
| 2 | Tsukimi Data settles the spend wallet's payment of 0.10 USDC (MPP) | Success | [`0x2e734c7e…bf90b6b8`](https://sepolia.arbiscan.io/tx/0x2e734c7e51c5ef7ed1af9167a60d10de0de422932362664613974cfcbf90b6b8) |
| 3 | Gateway pays 1.50 USDC to Koishi Supply inside the mandate | Success | [`0xf065b734…62c69af1`](https://sepolia.arbiscan.io/tx/0xf065b734f752ed964f3d032cdd4a6ef31bf56dbb76e19a9bf3d828cf62c69af1) |
| 4 | Gateway pays 6.00 USDC to Nagikumo Research with the approver's signature (payWithApproval) | Success | [`0x4d857a03…f95d1ad2`](https://sepolia.arbiscan.io/tx/0x4d857a039c04f18f450ed00bf2936c1110401f4786ff6b8bb912b3b5f95d1ad2) |
| 5 | Gateway pays 0.10 USDC from the vault to its spend wallet, to buy from Tsukimi Data | Success | [`0x70201ac5…4221c705`](https://sepolia.arbiscan.io/tx/0x70201ac5f420e8a8b5bcc20de8fa8b43f768baf479e96ad611f3a7504221c705) |
| 5 | Tsukimi Data settles the spend wallet's payment of 0.10 USDC (MPP) | Success | [`0x7a12b9b5…fd6bde8e`](https://sepolia.arbiscan.io/tx/0x7a12b9b5dcd5fdd9fdafb18c922c6df5a12a76add5a1e0a10f46573efd6bde8e) |
| 6a | Drill a: executor key sends 9.00 USDC to an unlisted address 0xfB5eCBdE44F70cc64887210F8049db303B049b97; the vault reverts with `PayeeNotAllowed` | Reverted, as intended | [`0xeb9a700f…e8c39673`](https://sepolia.arbiscan.io/tx/0xeb9a700f8246935a87e63f95ef10c3fc286dbe1c827c031528b03338e8c39673) |
| 6b | Drill b: executor key sends 9.00 USDC to a listed vendor, Koishi Supply, above the 2 USDC cap; the vault reverts with `PerPaymentCapExceeded` | Reverted, as intended | [`0x73942ff9…165354d0`](https://sepolia.arbiscan.io/tx/0x73942ff99f2220a23f0ff25846ac3da24e94f072b89a1724ed19c6da165354d0) |
| 6c | Drill c: executor key signs its own approval for 9.00 USDC to 0xfB5eCBdE44F70cc64887210F8049db303B049b97; the vault reverts with `InvalidApproval` | Reverted, as intended | [`0xa86c31de…13203ee3`](https://sepolia.arbiscan.io/tx/0xa86c31de8f74a4cb34d278b3dc212e2d7a08148705b6e7cc83024a3813203ee3) |
| 7 | Principal revokes mandate 2 | Success | [`0x198a021b…3c296af5`](https://sepolia.arbiscan.io/tx/0x198a021b74405f2afb2cdfe2ff18cefbe6a970a56e11e2f19ff206853c296af5) |

The agent is ERC-8004 agent 354 in the Identity Registry on Arbitrum Sepolia. The demo ran under
mandate 2 in the vault: 2 USDC per payment, 8 USDC per UTC day, hard ceiling 20 USDC.

## What the gateway decided

Every request the agent signed, and what became of it. Each has an evidence file whose hash is in the
vault's event when a payment was made.

| Step | Request | Decision | Result | Evidence | Checks passed |
| ---- | ------- | -------- | ------ | -------- | ------------- |
| 2 | 0.10 USDC to Tsukimi Data | `auto` | paid | [`0x85f46d16…a5a7e1a3`](evidence/0x85f46d166693ac7be327580497ede36635b240ef5becc9c1484ca409a5a7e1a3.json) | 20 of 20 |
| 3 | 1.50 USDC to Koishi Supply | `auto` | paid | [`0x15d6bca2…e7cf32ce`](evidence/0x15d6bca217c4cd07c4e985f7bbc78b95d8fadd58ed192660e3f86233e7cf32ce.json) | 18 of 18 |
| 4 | 6.00 USDC to Nagikumo Research | `needs_approval`<br>The amount is above the per-payment cap of 2 USDC | paid | [`0x64b65bcc…a7253f0e`](evidence/0x64b65bcc89e6e77be788ceb99b8fd36ebbefb75c32a7083f08f664d5a7253f0e.json) | 21 of 21 |
| 5 | 0.10 USDC to Tsukimi Data | `auto` | paid | [`0x272fd195…baa6a534`](evidence/0x272fd195b7ef6c1507e154d7cd24f00fb3b7d590f15a18e42514eb69baa6a534.json) | 20 of 20 |
| 5 | 4.00 USDC to an address in no registry (`0x5c9ae0b4…6c902e47`) | `refused`<br>The payee is not in the principal's vendor registry. The address appears only in content the agent read (market-data response for TSK-FOOD30 from http://127.0.0.1:8788), which is not a trusted source | refused | [`0x0b2ea794…e07eb2c9`](evidence/0x0b2ea794abe2c57f7f09018c687c0958da381c0ef87351d7c8388ad8e07eb2c9.json) | 11 of 11 |
| 7 | 1.50 USDC to Koishi Supply | `refused`<br>Mandate 2 has been revoked | refused | [`0x94b456e6…976e9d9e`](evidence/0x94b456e663b608b6ce76368eb2a5ff3d355c5e40b66d3eec61d98f28976e9d9e.json) | 11 of 11 |

A market-data purchase shows up as two transactions: the vault pays the gateway's spend wallet exactly
the price, inside the mandate, and the merchant then settles the spend wallet's signed payment.

## "Gateway compromised" drills

The executor key is the key the gateway holds. Here it is used directly, without the gateway. Each
attempt was sent as a real transaction, so the vault's refusal is on the public record.

| Drill | Attempt | The vault's answer | Transaction |
| ----- | ------- | ------------------ | ----------- |
| a | Executor key sends 9.00 USDC to an unlisted address 0xfB5eCBdE44F70cc64887210F8049db303B049b97 | `PayeeNotAllowed(2, 0xfB5eCBdE44F70cc64887210F8049db303B049b97)` | [`0xeb9a700f…e8c39673`](https://sepolia.arbiscan.io/tx/0xeb9a700f8246935a87e63f95ef10c3fc286dbe1c827c031528b03338e8c39673) |
| b | Executor key sends 9.00 USDC to a listed vendor, Koishi Supply, above the 2 USDC cap | `PerPaymentCapExceeded(9000000, 2000000)` | [`0x73942ff9…165354d0`](https://sepolia.arbiscan.io/tx/0x73942ff99f2220a23f0ff25846ac3da24e94f072b89a1724ed19c6da165354d0) |
| c | Executor key signs its own approval for 9.00 USDC to 0xfB5eCBdE44F70cc64887210F8049db303B049b97 | `InvalidApproval()` | [`0xa86c31de…13203ee3`](https://sepolia.arbiscan.io/tx/0xa86c31de8f74a4cb34d278b3dc212e2d7a08148705b6e7cc83024a3813203ee3) |

## Who is who

| Role | Address |
| ---- | ------- |
| Kirenami Trading: owns the vault, creates and revokes mandates | [`0xd42f974802a327789F217Db9f61DeA26EA5418A5`](https://sepolia.arbiscan.io/address/0xd42f974802a327789F217Db9f61DeA26EA5418A5) |
| The gateway's executor: can only pay inside a mandate | [`0xB0aA521c777F8363DaA0446DD05807347d2f08B9`](https://sepolia.arbiscan.io/address/0xB0aA521c777F8363DaA0446DD05807347d2f08B9) |
| Approver: signs for payments outside the mandate | [`0x062Ac773F7470034411A7f739a5664F6B3cfcE69`](https://sepolia.arbiscan.io/address/0x062Ac773F7470034411A7f739a5664F6B3cfcE69) |
| Kirenami research and procurement agent: signs requests, holds no funds | [`0x277F7fcBEf2886A6b5F114DeeCaD52aaAE794B2a`](https://sepolia.arbiscan.io/address/0x277F7fcBEf2886A6b5F114DeeCaD52aaAE794B2a) |
| Agent Gateway spend wallet: pays per-call API charges | [`0xcd08ecaA7FF642ffEdc77514C1442E59ddbb4CF9`](https://sepolia.arbiscan.io/address/0xcd08ecaA7FF642ffEdc77514C1442E59ddbb4CF9) |
| Tsukimi Data: sells market data per call (MPP) | [`0x68213E015912D89aA99E6Dfc5FEd426CCcC691aD`](https://sepolia.arbiscan.io/address/0x68213E015912D89aA99E6Dfc5FEd426CCcC691aD) |
| Koishi Supply: a vendor on the mandate's allowlist | [`0x84d6943216c05bc96b72791d5a76875e08D539F0`](https://sepolia.arbiscan.io/address/0x84d6943216c05bc96b72791d5a76875e08D539F0) |
| Nagikumo Research: a vendor on the mandate's allowlist | [`0xDd76243f8563ea5D6E6186C0e26804F761A18792`](https://sepolia.arbiscan.io/address/0xDd76243f8563ea5D6E6186C0e26804F761A18792) |

## Check it yourself

No keys are needed. This reads an evidence file, recomputes its hash, checks the signatures and
compares the record with the vault's event onchain:

```bash
pnpm verify-evidence docs/sepolia-run/evidence/0x85f46d166693ac7be327580497ede36635b240ef5becc9c1484ca409a5a7e1a3.json
```

It should end with `VERIFIED`. Add `--offline` to skip the chain. The same works for every file in
`evidence/`.

To check the mandate text against the chain, hash the file and compare it with the mandate's `termsHash`:

```bash
cast keccak "0x$(xxd -p -c 100000 docs/sepolia-run/mandates/0x85973d32b8f1b42c2fb91d39b6870a764f99fdcc665308cc54a0ec47e764685a.txt)"
cast call 0x7293763f6b73783834484cd976528D01Cb6c8CCf "getMandate(uint256)((uint256,address,uint64,bool,address,uint256,uint256,uint256,uint256,bytes32,address[]))" 2 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

## Files

| File | What it is |
| ---- | ---------- |
| `demo-run.json` | The transactions, decisions and drills above, as the demo recorded them. |
| `evidence/` | One evidence file per request: who asked, what for, every check, the decision and the result. |
| `ledger.jsonl` | The gateway's hash-chained ledger for this run. |
| `mandates/` | The plain-text mandate the principal approved. Its keccak256 hash is the mandate's `termsHash`. |
| `payees.json` | The principal's vendor registry the gateway used. |
