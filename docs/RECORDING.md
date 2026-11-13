# Recording the final run

How to make the run that goes into [`docs/sepolia-run`](sepolia-run/README.md), the README and the video:
the demo on Arbitrum Sepolia, with step 4 signed in the console by a browser wallet.

Everything here uses testnet keys and test funds. The order matters, so follow it from top to bottom.

Every command stands in a block without comments, so that it can be pasted into a shell as it is. A shell
such as zsh would pass a comment on to the command as arguments. The notes are in the text around the
commands.

1. [Set up the wallet](#1-set-up-the-wallet), once.
2. [One live pass of step 4](#2-one-live-pass-of-step-4), before the day of recording.
3. [Check before recording](#3-check-before-recording).
4. [The recorded run](#4-the-recorded-run): three commands.
5. [Screenshots](#5-screenshots) from that run.
6. [Afterwards](#6-afterwards).

## 1. Set up the wallet

The approver signs in a browser wallet, in the browser that shows the console. The examples name MetaMask;
any wallet that signs typed data (EIP-712) works.

1. **Add Arbitrum Sepolia** if the wallet does not have it: chain id `421614`, RPC
   `https://sepolia-rollup.arbitrum.io/rpc`, currency ETH, explorer `https://sepolia.arbiscan.io`.
2. **Import the approver's key** as a new account. It is `APPROVER_PRIVATE_KEY` in `.env`. Copy it from the
   file straight into the wallet's "Import account" form and nowhere else. It is a testnet-only key, and it
   still should not end up in a chat, a screenshot or the recording.
3. **Check the address.** The imported account must show the address of `APPROVER_ADDRESS` in `.env`. The
   demo prints the same address as `approver` when it starts.
4. **Decline any "smart account" offer** for this account, now and later. If the wallet offers to switch,
   upgrade or enable a smart account, choose no.

Why step 4 matters: such an offer puts contract code at the approver's address (an EIP-7702 delegation).
The vault then asks that code about a signature instead of checking the key, and the approval can fail.
The gateway notices and sends nothing, but the take is spoiled.

The approver needs no ETH. Signing costs no gas: the gateway sends the payment.

## 2. One live pass of step 4

Try the one step that needs the wallet before the day of recording. The tests and the rehearsals on a
local fork use a stand-in for the wallet, and cannot show the wallet's own windows.

This pass was first made on 12 November 2026, with MetaMask and the approver's key imported into it:
[the payment](https://sepolia.arbiscan.io/tx/0x6f9d1361603ec1e4d6694ac3e285a7b774321dceb91ed6a67262d7cb8a9964e5).
The recorded run of 13 November 2026 was signed in the built console too, on the code with the security
review's fixes:
[its step 4](https://sepolia.arbiscan.io/tx/0x96ed2f5fb5e17afaae2f723777527649b1245b8c1e7732552aed928723285868).

Make the pass again before a new recording if the wallet, the browser, the approver's key or the console's
code has changed since then.

A pass leaves its 6 USDC with the vendor. If the principal then lacks the test USDC to fill the vault, the
demo stops and says so. This brings the vendors' test USDC back:

```bash
pnpm demo --steps recycle
```

A pass keeps the agent's two mandates while they are active. Its approval then carries the mandate's next
approval number, which the terminal prints.

In one terminal, build the console and serve it on <http://127.0.0.1:5173>:

```bash
pnpm console:built
```

In a second terminal, run three steps of the demo:

```bash
pnpm demo --console --steps gas,1,4
```

`pnpm console:built` is the console for this pass and for the recording. It is a production build: it shows
the gateway and the chain and nothing else. `pnpm console` is the development build, with a "Data shown"
switch for made-up data at the bottom left. Do not record that one.

Step 1 fills the vault. A first pass also creates the agent's two mandates there; a second pass finds
them active and keeps them. At step 4 the terminal prints `waiting  for the approver in the console` and
waits, for up to 30 minutes. Then, in the browser:

1. Open <http://127.0.0.1:5173/#/approvals>. A 6.00 USDC payment to Nagikumo Research is waiting.
2. Open the wallet menu at the top right and choose your wallet by its name. (A wallet that does not
   announce its name is listed as "Browser wallet".) Confirm the connection in the wallet. The strip must
   then say **Approver**.
3. Choose **Sign approval**. The wallet shows a typed message named `PaymentApproval` for `MandateVault`,
   with the mandate, the payee, the amount `6000000`, the evidence hash, a nonce and a deadline. These are
   the values the console lists under "What your wallet will ask you to sign". Sign it.

What a good pass looks like:

- The console shows **Paid, approved** with a transaction link, and the link opens a real
  `payWithApproval` transaction on Arbiscan.
- The terminal prints `approver signs the approval in the console`, then
  `evidence VERIFIED: 25 of 25 checks passed`.
- The wallet asked for one signature and no transaction, and made no smart-account offer.

If the console says something else:

| The console says                                                                | What to do                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The wallet is on another network"                                              | Wallet menu, "Switch to Arbitrum Sepolia".                                                                                                                                               |
| "The connected wallet is not this mandate's approver"                           | The wrong account is selected in the wallet. Select the approver.                                                                                                                        |
| "The approver's address … has contract code"                                    | The account was made a smart account. See [step 4 above](#1-set-up-the-wallet); remove the delegation in the wallet, or record with the approver's key in the terminal (no `--console`). |
| "The wallet did not sign"                                                       | The request was rejected or closed. Choose "Sign approval" again.                                                                                                                        |
| "Checking what the gateway says about the vault against the chain…"             | Wait a moment. The console reads the vault from the chain before it lets anything be signed.                                                                                             |
| "The vault could not be read from the chain"                                    | The public RPC endpoint did not answer. Reload the page.                                                                                                                                 |
| "The gateway serves vault … That is not the vault this console was started for" | The console was built for another vault. Look for `MANDATE_VAULT_ADDRESS` in the shell that ran `pnpm console:built`, unset it, and start the console again.                             |
| "… Signing is switched off."                                                    | Do not sign. The console found that what the gateway wants signed is not the payment the page shows. Stop the run and say so.                                                            |

Stop the demo with Ctrl+C when it has finished. The 6 USDC come back with `recycle` below.

## 3. Check before recording

| Check                                | How                                                                                                     | Good when                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| The code is the released state       | `git status` and `git log -1`                                                                           | Clean, on `main`, up to date                |
| Tests pass                           | `pnpm test`                                                                                             | No failure                                  |
| The approver is a plain key          | `cast code "$(sed -n 's/^APPROVER_ADDRESS=//p' .env)" --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | Prints `0x`                                 |
| The agent will be Claude             | `grep -c '^ANTHROPIC_API_KEY=.' .env`                                                                   | Prints `1`                                  |
| Nothing holds the ports              | `lsof -nP -iTCP:8787 -iTCP:8788 -iTCP:5173 -sTCP:LISTEN`                                                | Prints nothing before `pnpm console:built`  |
| The wallet is ready                  | Open the wallet                                                                                         | Arbitrum Sepolia, approver account selected |
| The console is the built one         | Look at the bottom left of the console                                                                  | No "Data shown" switch                      |
| The day will not turn during the run | Look at the clock                                                                                       | Not close to 00:00 UTC (09:00 in Tokyo)     |

The last one matters because the vault counts spending per UTC day. A run that crosses midnight UTC still
passes, but "paid today" on the screen starts again from zero in the middle of it.

With `ANTHROPIC_API_KEY` set the agent is Claude, and its calls cost money. If the API cannot be reached,
the demo says so and runs the scripted agent instead. Look at the `agent` line of each step: the video
script has a line for either agent in step 5.

## 4. The recorded run

Three commands make the run: `recycle`, the demo, and `demo:record`. Between the first two come a clean
data folder and the built console. Do everything in this order.

```bash
pnpm demo --steps recycle
```

It sends the test USDC of the vendors and the merchant back to the principal, and prints what the
principal holds. The vault is filled to 12 USDC in step 1, so the principal needs 12 USDC minus what the
vault already holds. The demo stops with a clear message if that is missing.

Then give the run a clean data folder, so that its ledger and evidence hold this run only. Keep
`demo-state.json`: it names the agent and the transaction that registered it.

```bash
cd apps/gateway/data
mkdir archive-before-final
mv evidence mandates ledger.jsonl payees.json demo-run.json archive-before-final/
cd ../../..
```

In one terminal, start the built console:

```bash
pnpm console:built
```

In a second terminal, start the run:

```bash
pnpm demo --fresh --valid-days 90 --reissue --console --pause
```

With `--pause` the run waits for Enter before each step. That is the easy way to switch screens, take the
pictures below and record at your own pace. Nothing times out while it waits. Without `--pause` it runs
straight through and only stops at step 4, for the approver.

With the two mandates of the live pass still active, a good run ends with `Done. 19 transactions:`.
Sixteen of them succeed, and three are the reverts of step 6. (The run revokes those two mandates first.
Without them it is 17.) The purposes in the feed are the agent's own words when the agent is Claude, so
they differ a little from run to run and from the pictures taken with the scripted agent.

| Step    | What the terminal does                                                      | What the console shows                                                      |
| ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| gas, 1  | Revokes the old mandates, fills the vault, creates two mandates for 90 days | Mandates: two active mandates, nothing spent                                |
| 2       | The agent buys a quote for 0.10 USDC                                        | Live feed: **Paid**, with "Bought per call from …"                          |
| 3       | The agent pays Koishi Supply 1.50 USDC                                      | Live feed: **Paid**                                                         |
| 4       | Waits for the approver                                                      | Approvals: the 6.00 USDC payment. Connect the wallet and sign               |
| 5       | The planted note. Prints "what happened"                                    | Live feed: **Refused**, with the reason                                     |
| 6       | Three drills, three `REVERTED` lines with Arbiscan links                    | Nothing: these go to the vault directly, not through the gateway            |
| 7       | Revokes both mandates. The next request is refused                          | Mandates: **Revoked**. Live feed: **Refused**, "Mandate … has been revoked" |
| reissue | Creates two new mandates for 90 days                                        | Mandates: two active mandates on top                                        |

After the last step the gateway keeps serving the console. Take the remaining pictures, then stop it with
Ctrl+C.

If a step fails, the run stops and says why. Nothing is lost: run `pnpm demo --steps recycle` and start
again. `--fresh` replaces the mandates.

Then record the run:

```bash
pnpm demo:record
pnpm verify-evidence docs/sepolia-run/evidence/*.json
```

`demo:record` copies the run into `docs/sepolia-run`, writes its README, and rewrites the demo table and
the gas figures in the main README. It says what this run did: the agent was registered in an earlier run,
so step 1 names that transaction as an earlier one. It refuses a run that stopped early, or one in which
the approver declined. To add a line of context under the page's introduction, for example where the
mandates with lower numbers came from, pass `--note "..."`.

The second command must end with `6 of 6 files verified`. Then look at `git diff --stat`: only
`docs/sepolia-run` and `README.md` should have changed.

## 5. Screenshots

All six pictures in [`docs/console`](console/README.md) are retaken from this run, so that every
transaction in them can be looked up on Arbiscan.

| File              | Screen                                       | When                                                      | Wallet connected |
| ----------------- | -------------------------------------------- | --------------------------------------------------------- | ---------------- |
| `approvals.png`   | Approvals, the waiting payment               | At step 4, before signing                                 | Approver         |
| `mandates.png`    | Mandates, both active, with today's spending | After step 4, before step 5 (use `--pause`)               | Approver         |
| `evidence.png`    | Evidence of the approved 6 USDC payment      | Any time after step 4                                     | Any or none      |
| `feed.png`        | Live feed with all six requests              | After step 7                                              | Any or none      |
| `ledger.png`      | Ledger                                       | After step 7                                              | Any or none      |
| `new-mandate.png` | Mandates, the form for a new mandate         | Any time. Fill in agent id 354; do not create the mandate | Principal        |

`new-mandate.png` needs the principal's wallet, because the form opens only for the principal. That means
importing `PRINCIPAL_PRIVATE_KEY` into the browser wallet as well. If you would rather not, keep the
existing picture: it shows no transaction, and its caption says where it comes from.

To take a picture of exactly 1440 by 900 pixels in Chrome:

1. Open DevTools and switch on the device toolbar (Cmd+Shift+M).
2. Set the dimensions to "Responsive", 1440 × 900. In the toolbar's menu (⋮), choose "Add device pixel
   ratio" and set it to 1.
3. In the same menu, choose "Capture screenshot".

Save each file under its name in `docs/console`, and update the table in
[`docs/console/README.md`](console/README.md): every row then reads "Recorded run on Sepolia".

## 6. Afterwards

- **The video.** The script and the shot list are in [`docs/video/SCRIPT.md`](video/SCRIPT.md). When the
  video is online, put its link into the README: replace "to be added" in the
  line that starts with "Video, 2 minutes".
- **A pull request** with the recorded run, the pictures and the link, as for every change.
- **The tag.** `v0.1.0` is pushed after that pull request is merged: set the date in
  [`CHANGELOG.md`](../CHANGELOG.md) and the version in the `package.json` files first.
- **Going public.** When the repository becomes public, switch on "Private vulnerability reporting" in its
  settings (Settings, Code security). [`SECURITY.md`](../SECURITY.md) points reporters to it.

## Recording the screen

The console is laid out for a page area of 1440 by 900. For the video:

- Open the console in a window of its own with exactly that page area. In the browser's DevTools console:
  `window.open(location.href, 'console', 'popup,width=1440,height=900')`. A wallet extension works in that
  window as in any other.
- A 14-inch MacBook display at its default scaling (1512 × 982) is not tall enough for it. Choose "More
  Space" in the display settings for the take.
- Keep the wallet's window in the picture when you sign in step 4: the signature is the point of that shot.
- Record the built console, `pnpm console:built`, as in the commands above. If a "Data shown" switch is
  at the bottom left, the development build is running: stop it and start the built one.

- Keep the terminal out of the picture while `.env` is open anywhere, and never show `.env`.
