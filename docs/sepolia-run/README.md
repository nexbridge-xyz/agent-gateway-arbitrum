# A recorded run on Arbitrum Sepolia

Steps 1, 3 and 6 of the demo, run with `pnpm demo` on 2026-11-11 (UTC) against the deployed
[`MandateVault`](https://sepolia.arbiscan.io/address/0x7293763f6b73783834484cd976528D01Cb6c8CCf#code). The files in this folder are
kept exactly as the run wrote them. All company and vendor names are fictional.

| Step | What happened | Result | Transaction |
| ---- | ------------- | ------ | ----------- |
| gas | Deployer sends 0.003 ETH to the principal | Success | [`0x0f54f084…d3a7fe9e`](https://sepolia.arbiscan.io/tx/0x0f54f0842a7bd3e1cc01dc321b3f4a8e053c6d4a1b114f716b671511d3a7fe9e) |
| gas | Deployer sends 0.003 ETH to the executor | Success | [`0x3d30f344…20fc997f`](https://sepolia.arbiscan.io/tx/0x3d30f344a3cac106cb3cc0d82f816e10dbe2b71f23481b7911b8891620fc997f) |
| 1 | Principal allows the vault to take 10 USDC | Success | [`0xc4fa97fa…921487f1`](https://sepolia.arbiscan.io/tx/0xc4fa97fadf6abf15c265e13d28ba2a4b9469c238409dfe2a9aae8e60921487f1) |
| 1 | Principal deposits 10 USDC into the vault | Success | [`0xf2c2e089…0de4d6eb`](https://sepolia.arbiscan.io/tx/0xf2c2e089b94d805bd9d6f3de19da4d687e5fc444d6ec36bd238ce21a0de4d6eb) |
| 1 | Principal registers the agent in the ERC-8004 Identity Registry | Success | [`0xc5bb229f…354f07e4`](https://sepolia.arbiscan.io/tx/0xc5bb229fa23bb579d29ff41975b0b103e551abc2c1999f3a9f2b94e8354f07e4) |
| 1 | Principal stores the registration file for agent 354 onchain | Success | [`0xca9e44e6…c8aeae55`](https://sepolia.arbiscan.io/tx/0xca9e44e6df78da0bd00e8cc423a428226a06bc616bca8ed4c4410ceec8aeae55) |
| 1 | Principal sets the agent's request-signing key as the agent wallet | Success | [`0x2131b03d…7836dd54`](https://sepolia.arbiscan.io/tx/0x2131b03dd61b1e27e943272ca4460f48ea14b31233b250c05f4e79dc7836dd54) |
| 1 | Principal creates the mandate: 2 per payment, 8 per day, ceiling 20 USDC, 30 days | Success | [`0x4dbc45bf…253bbe19`](https://sepolia.arbiscan.io/tx/0x4dbc45bf09563c6a96ae1a5cec92ab1484f7879663fa8704489a03ec253bbe19) |
| 3 | Gateway pays 1.50 USDC to Tsukimi Data inside the mandate | Success | [`0xac89ad80…301079bf`](https://sepolia.arbiscan.io/tx/0xac89ad80d6bc378e845057ea61eaae0dee32d9da32564e9f80c1dae5301079bf) |
| 6 | Executor key tries to pay 9 USDC to the attacker; the vault reverts with `PayeeNotAllowed` | Reverted, as intended | [`0xf462a6c7…7f7e043d`](https://sepolia.arbiscan.io/tx/0xf462a6c733e6578febcc8a49d818932a593cb83803cee790662a5c227f7e043d) |

The agent is ERC-8004 agent 354 in the Identity Registry on Arbitrum Sepolia. The mandate is mandate 1
in the vault: 2 USDC per payment, 8 USDC per UTC day, hard ceiling 20 USDC, valid for 30 days.

## Check it yourself

No keys are needed. This reads the evidence file, recomputes its hash, checks the agent's signature and
compares the record with the vault's event onchain:

```bash
pnpm verify-evidence docs/sepolia-run/evidence/0x93d05350a8fbc1178eb1c66a907470018207dcc7a69d84c40aeb41689704b997.json
```

It should end with `VERIFIED: 18 of 18 checks passed`. Add `--offline` to skip the chain.

To check the mandate text against the chain, hash the file and compare it with the mandate's `termsHash`:

```bash
cast keccak "0x$(xxd -p -c 100000 docs/sepolia-run/mandates/0x14d904d114f0bcd1372e1db34e967fc1713cb72ca67c5daa270bcf8a3af93493.txt)"
cast call 0x7293763f6b73783834484cd976528D01Cb6c8CCf "getMandate(uint256)((uint256,address,uint64,bool,address,uint256,uint256,uint256,uint256,bytes32,address[]))" 1 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

## Files

| File | What it is |
| ---- | ---------- |
| `demo-run.json` | The transactions above, as the demo recorded them. |
| `evidence/0x93d05350….json` | The evidence file for the payment in step 3. Its hash is in the vault's `MandatePayment` event. |
| `ledger.jsonl` | The gateway's hash-chained ledger after the run: the decision and the payment. |
| `mandates/0x14d904d1….txt` | The plain-text mandate the principal approved. Its keccak256 hash is the mandate's `termsHash`. |
| `payees.json` | The principal's vendor registry the gateway used. |
