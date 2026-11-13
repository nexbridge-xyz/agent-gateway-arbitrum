# Console screenshots

Taken at 1440 by 900 from the console in [`apps/console`](../../apps/console/README.md). All company and
vendor names are fictional.

Five of the pictures were taken during the [recorded run](../sepolia-run/README.md) of 13 November 2026 on
Arbitrum Sepolia, in the built console, with the approver's wallet connected. Every transaction in them
can be looked up on Arbiscan.

The sixth, the form for a new mandate, comes from a rehearsal of the same demo on a local fork of Arbitrum
Sepolia on 12 November 2026, where a test wallet played the principal. It shows no transaction. The
mandates behind the form are that fork's, not the testnet's.

| Picture                              | What it shows                                                                                                                                                                                                                                                | Data                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| [`feed.png`](feed.png)               | The live feed after the whole demo: three payments that ran on their own (two per-call purchases and a vendor invoice), one paid with an approval, the refused request from the planted note with its reason, and a refusal after the mandates were revoked. | Recorded run on Sepolia   |
| [`approvals.png`](approvals.png)     | A 6 USDC invoice waits for the approver. The screen shows the exact message the wallet will ask to sign and where the payment lands on the mandate. The approver's wallet is connected.                                                                      | Recorded run on Sepolia   |
| [`mandates.png`](mandates.png)       | The agent's two mandates read from the vault, after the approved payment: 7.50 of 8 USDC used on the vendor mandate, 0.10 of 1 USDC on the spend wallet's.                                                                                                   | Recorded run on Sepolia   |
| [`new-mandate.png`](new-mandate.png) | The form for a new mandate, with the principal's wallet connected.                                                                                                                                                                                           | Rehearsal on a local fork |
| [`evidence.png`](evidence.png)       | The evidence of the approved 6 USDC payment, checked against the chain.                                                                                                                                                                                      | Recorded run on Sepolia   |
| [`ledger.png`](ledger.png)           | The gateway's ledger of the recorded run, with its chain of hashes.                                                                                                                                                                                          | Recorded run on Sepolia   |

## Live feed

![Live feed](feed.png)

## Approvals

![Approvals](approvals.png)

## Mandates

![Mandates](mandates.png)

![New mandate](new-mandate.png)

## Evidence

![Evidence](evidence.png)

## Ledger

![Ledger](ledger.png)
