import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import {
  type Address,
  type Hex,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  keccak256,
  parseEther,
  parseEventLogs,
  parseUnits,
  stringToHex,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  type IntentOutcome,
  type PayeesFile,
  createApp,
  createVerifierChain,
  describeContractError,
  explorerTx,
  mandateVaultAbi,
  signIntent,
  verifyEvidence,
} from '@agent-gateway/gateway';

import { type Context, NAMES } from './context';
import { agentIsReady, registerAgent } from './erc8004';

/** The demo mandate. Amounts are in USDC and fit one claim from Circle's testnet faucet. */
export const MANDATE = {
  perPaymentCap: '2',
  dailyCap: '8',
  hardCeiling: '20',
  validDays: 30,
  /** What the principal keeps in the vault for the demo. */
  vaultFunds: '10',
} as const;

const GAS_FLOOR = parseEther('0.0005');
const GAS_TOP_UP = parseEther('0.003');

export type StepOptions = { fresh: boolean };

// --- Gas ---------------------------------------------------------------------------------------------

/** The deployer shares its testnet ETH with the roles that send transactions. */
export async function gas(context: Context): Promise<void> {
  const { accounts, publicClient, wallet, confirm, log } = context;
  log('Gas: make sure the principal and the executor can pay for transactions');

  for (const role of ['PRINCIPAL', 'EXECUTOR'] as const) {
    const { address } = accounts[role];
    const balance = await publicClient.getBalance({ address });
    if (balance >= GAS_FLOOR) {
      log(`  ok       ${role.toLowerCase()} holds ${formatEther(balance)} ETH`);
      continue;
    }
    const available = await publicClient.getBalance({ address: accounts.DEPLOYER.address });
    if (available < GAS_TOP_UP * 2n) {
      throw new Error(
        `The deployer ${accounts.DEPLOYER.address} holds ${formatEther(available)} ETH, too little to share. ` +
          'Send it some Arbitrum Sepolia ETH from a faucet.',
      );
    }
    await confirm(
      'gas',
      `deployer sends ${formatEther(GAS_TOP_UP)} ETH to the ${role.toLowerCase()}`,
      await wallet(accounts.DEPLOYER).sendTransaction({ to: address, value: GAS_TOP_UP }),
    );
  }
}

// --- Step 1 ------------------------------------------------------------------------------------------

/** The plain-text mandate the principal approves. Its hash goes onchain as `termsHash`. */
function mandateText(context: Context, agentId: bigint, validUntil: bigint): string {
  const { accounts, info } = context;
  const until = new Date(Number(validUntil) * 1000).toISOString().replace('.000Z', 'Z');
  return [
    'AGENT PAYMENT MANDATE',
    '',
    `Principal: ${NAMES.principal} (${accounts.PRINCIPAL.address})`,
    `Agent: ${NAMES.agent}, ERC-8004 agent ${agentId} in eip155:${info.chainId}:${info.identityRegistry}`,
    `Executor (gateway): ${accounts.EXECUTOR.address}`,
    `Approver: ${accounts.APPROVER.address}`,
    '',
    'The agent may pay these payees without asking:',
    `  - ${NAMES.spendWallet} (${accounts.SPEND_WALLET.address})`,
    `  - ${NAMES.vendorA} (${accounts.VENDOR_A.address})`,
    `  - ${NAMES.vendorB} (${accounts.VENDOR_B.address})`,
    `up to ${MANDATE.perPaymentCap} ${info.tokenSymbol} per payment and ${MANDATE.dailyCap} ${info.tokenSymbol} per UTC day.`,
    '',
    `Any other payment needs the approver's signature. No more than ${MANDATE.hardCeiling} ${info.tokenSymbol} may leave`,
    'under this mandate in one UTC day, approved payments included.',
    '',
    `Valid until ${until}. The principal may revoke this mandate at any time.`,
    `Vault: ${info.vault} on Arbitrum Sepolia (${info.chainId}). Token: ${info.tokenSymbol} (${info.token}).`,
    '',
  ].join('\n');
}

export async function setup(context: Context, options: StepOptions): Promise<void> {
  const { accounts, info, publicClient, runtime, wallet, confirm, log } = context;
  const principal = wallet(accounts.PRINCIPAL);
  const vault = { address: info.vault, abi: mandateVaultAbi } as const;
  const units = (value: string) => parseUnits(value, info.tokenDecimals);
  const money = (value: bigint) => `${formatUnits(value, info.tokenDecimals)} ${info.tokenSymbol}`;

  log('Step 1: the principal funds the vault, registers the agent and creates its mandate');
  if (accounts.PRINCIPAL.address !== info.principal) {
    throw new Error(
      `PRINCIPAL_PRIVATE_KEY does not belong to the vault's principal ${info.principal}`,
    );
  }

  // Fund the vault up to the demo amount.
  const balanceOf = (owner: Address) =>
    publicClient.readContract({
      address: info.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    });
  const held = await balanceOf(info.vault);
  const missing = units(MANDATE.vaultFunds) - held;
  if (missing > 0n) {
    const own = await balanceOf(accounts.PRINCIPAL.address);
    if (own < missing) {
      throw new Error(
        `The principal ${accounts.PRINCIPAL.address} holds ${money(own)}; the demo needs ${money(missing)} more in the vault. ` +
          'Claim test USDC at faucet.circle.com (network: Arbitrum Sepolia).',
      );
    }
    await confirm(
      '1',
      `principal allows the vault to take ${money(missing)}`,
      await principal.writeContract({
        address: info.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [info.vault, missing],
      }),
    );
    await confirm(
      '1',
      `principal deposits ${money(missing)} into the vault`,
      await principal.writeContract({ ...vault, functionName: 'deposit', args: [missing] }),
    );
  } else {
    log(`  ok       the vault already holds ${money(held)}`);
  }

  // Agent identity in ERC-8004.
  let state = await context.readState();
  if (options.fresh) state = { ...state, agentId: null, mandateId: null, termsHash: null };

  let agentId = state.agentId === null ? null : BigInt(state.agentId);
  if (
    agentId === null ||
    !(await agentIsReady(context, agentId, accounts.PRINCIPAL.address, accounts.AGENT.address))
  ) {
    agentId = await registerAgent(context, '1', {
      owner: accounts.PRINCIPAL,
      agent: accounts.AGENT,
      name: NAMES.agent,
      description:
        `Research and procurement agent of ${NAMES.principal}, a fictional trading firm. ` +
        'It buys market data and pays vendor invoices through Agent Gateway, inside an onchain mandate.',
    });
    state = { ...state, agentId: agentId.toString(), mandateId: null, termsHash: null };
    await context.writeState(state);
  } else {
    log(`  ok       agent ${agentId} is registered and its wallet is the agent's signing key`);
  }

  // The mandate.
  let mandateId = state.mandateId === null ? null : BigInt(state.mandateId);
  const reusable =
    mandateId !== null &&
    (await publicClient.readContract({ ...vault, functionName: 'isActive', args: [mandateId] }));
  if (mandateId === null || !reusable) {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const validUntil = block.timestamp + BigInt(MANDATE.validDays * 86_400);
    const terms = mandateText(context, agentId, validUntil);
    const termsHash = keccak256(stringToHex(terms));

    const receipt = await confirm(
      '1',
      `principal creates the mandate: ${MANDATE.perPaymentCap} per payment, ${MANDATE.dailyCap} per day, ceiling ${MANDATE.hardCeiling} ${info.tokenSymbol}, ${MANDATE.validDays} days`,
      await principal.writeContract({
        ...vault,
        functionName: 'createMandate',
        args: [
          agentId,
          accounts.EXECUTOR.address,
          accounts.APPROVER.address,
          [accounts.SPEND_WALLET.address, accounts.VENDOR_A.address, accounts.VENDOR_B.address],
          units(MANDATE.perPaymentCap),
          units(MANDATE.dailyCap),
          units(MANDATE.hardCeiling),
          validUntil,
          termsHash,
        ],
      }),
    );
    const created = parseEventLogs({
      abi: mandateVaultAbi,
      logs: receipt.logs,
      eventName: 'MandateCreated',
    })[0];
    if (created === undefined) throw new Error('The vault did not emit MandateCreated');
    mandateId = created.args.mandateId;

    const mandatesDir = join(runtime.config.dataDir, 'mandates');
    await mkdir(mandatesDir, { recursive: true });
    await writeFile(join(mandatesDir, `${termsHash}.txt`), terms, 'utf8');
    state = { ...state, mandateId: mandateId.toString(), termsHash };
    await context.writeState(state);
    log(`           mandate ${mandateId}, terms hash ${termsHash}`);
  } else {
    log(`  ok       mandate ${mandateId} is active`);
  }

  // The principal's payee lists, which the gateway treats as the trusted source.
  const payees: PayeesFile = {
    vendors: [
      { name: NAMES.vendorA, address: accounts.VENDOR_A.address, note: 'market data' },
      { name: NAMES.vendorB, address: accounts.VENDOR_B.address, note: 'office supplies' },
      {
        name: NAMES.spendWallet,
        address: accounts.SPEND_WALLET.address,
        note: 'pays per-call API charges',
      },
    ],
    denylist: [],
  };
  await mkdir(runtime.config.dataDir, { recursive: true });
  await writeFile(runtime.payeesPath, `${JSON.stringify(payees, null, 2)}\n`, 'utf8');
  log(`  ok       vendor registry written for the gateway (${payees.vendors.length} vendors)`);
}

// --- Step 3 ------------------------------------------------------------------------------------------

/** Starts the gateway on a free local port, as `pnpm gateway` would, and returns its address. */
async function startGateway(context: Context): Promise<{ url: string; stop: () => Promise<void> }> {
  const { runtime } = context;
  const app = createApp({
    gateway: runtime.gateway,
    chain: runtime.chain,
    ledger: runtime.ledger,
    explorerTx,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The agent signs a payment request with its own key and sends it to the gateway over HTTP. */
async function askGateway(
  context: Context,
  request: {
    payee: Address;
    amount: bigint;
    purpose: string;
    invoiceId: string;
    context: Record<string, string>;
  },
): Promise<IntentOutcome & { explorerUrl: string | null }> {
  const { accounts, info, publicClient, runtime, log } = context;
  const state = await context.readState();
  if (state.agentId === null) throw new Error('No agent yet. Run step 1 first.');

  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const signed = await signIntent(
    accounts.AGENT,
    { chainId: info.chainId, vault: info.vault },
    {
      agentId: state.agentId,
      payee: request.payee,
      amount: request.amount.toString(),
      purpose: request.purpose,
      invoiceId: request.invoiceId,
      context: request.context,
      nonce: toHex(randomBytes(32)),
      expiresAt: Number(block.timestamp) + 300,
    },
  );

  const gateway = await startGateway(context);
  try {
    const response = await fetch(`${gateway.url}/v1/payment-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    });
    const outcome = (await response.json()) as IntentOutcome & { explorerUrl: string | null };
    if (!response.ok)
      throw new Error(`The gateway answered ${response.status}: ${JSON.stringify(outcome)}`);

    log(`  decision ${outcome.decision} (${outcome.status})`);
    for (const reason of outcome.reasons) log(`           ${reason}`);
    if (outcome.explorerUrl !== null) log(`           ${outcome.explorerUrl}`);
    if (outcome.error !== null) log(`           error: ${outcome.error}`);

    // Check the evidence the way an outside party would.
    const file = await runtime.gateway.evidenceFor(outcome.intentId);
    const report = await verifyEvidence(file, {
      chain: createVerifierChain(publicClient),
      ledger: runtime.ledger.entries,
    });
    const passed = report.checks.filter((check) => check.verdict === 'pass').length;
    log(
      `  evidence ${report.verified ? 'VERIFIED' : 'NOT VERIFIED'}: ${passed} of ${report.checks.length} checks passed`,
    );
    log(`           hash ${outcome.evidenceHash}`);
    log(`           file ${runtime.evidence.pathFor(outcome.intentId)}`);
    if (!report.verified) {
      throw new Error(
        `Evidence did not verify: ${report.checks.find((check) => check.verdict === 'fail')?.label ?? ''}`,
      );
    }
    return outcome;
  } finally {
    await gateway.stop();
  }
}

export async function payVendor(context: Context): Promise<void> {
  const { accounts, info, publicClient, log, transactions } = context;
  const amount = parseUnits('1.5', info.tokenDecimals);
  log(`Step 3: the agent pays a known vendor, ${NAMES.vendorA}, 1.50 ${info.tokenSymbol}`);

  const before = await publicClient.readContract({
    address: info.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [accounts.VENDOR_A.address],
  });
  const outcome = await askGateway(context, {
    payee: accounts.VENDOR_A.address,
    amount,
    purpose: 'Invoice INV-2026-1107: market data feed, November',
    invoiceId: 'INV-2026-1107',
    context: { source: 'vendor invoice' },
  });
  if (
    outcome.decision !== 'auto' ||
    outcome.status !== 'paid' ||
    outcome.transactionHash === null
  ) {
    throw new Error(
      `Expected the payment to go through on its own, but the gateway said ${outcome.decision} (${outcome.status})`,
    );
  }

  const receipt = await publicClient.getTransactionReceipt({ hash: outcome.transactionHash });
  transactions.push({
    step: '3',
    label: `gateway pays 1.50 ${info.tokenSymbol} to ${NAMES.vendorA} inside the mandate`,
    transactionHash: outcome.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    url: explorerTx(outcome.transactionHash),
  });
  const after = await publicClient.readContract({
    address: info.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [accounts.VENDOR_A.address],
  });
  if (after - before !== amount) throw new Error('The vendor did not receive exactly 1.50');
  log(`  ok       ${NAMES.vendorA} received 1.50 ${info.tokenSymbol}`);
}

// --- Step 6 ------------------------------------------------------------------------------------------

/**
 * The "gateway compromised" drill. Whoever holds the executor key skips the gateway and tells the
 * vault to send 9 USDC to their own address. The vault refuses, and the refusal is onchain.
 */
export async function drill(context: Context): Promise<void> {
  const { accounts, info, publicClient, wallet, confirm, log } = context;
  const state = await context.readState();
  if (state.mandateId === null) throw new Error('No mandate yet. Run step 1 first.');

  // A fresh address nobody has listed anywhere. Its key is thrown away.
  const attacker = privateKeyToAccount(generatePrivateKey()).address;
  const amount = parseUnits('9', info.tokenDecimals);
  const args = [
    BigInt(state.mandateId),
    attacker,
    amount,
    keccak256(toHex(randomBytes(32))),
  ] as const;
  const call = {
    address: info.vault,
    abi: mandateVaultAbi,
    functionName: 'payWithinMandate',
    args,
  } as const;

  log('Step 6: "gateway compromised" drill');
  log(
    `  The executor key is used directly, without the gateway, to send 9 ${info.tokenSymbol} to ${attacker}.`,
  );

  const balanceOf = (owner: Address) =>
    publicClient.readContract({
      address: info.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    });
  const vaultBefore = await balanceOf(info.vault);

  // Ask the vault first. If it would not refuse, stop: nothing must ever reach this address.
  let refusal: string;
  try {
    await publicClient.simulateContract({ account: accounts.EXECUTOR, ...call });
    throw new Error('The vault would have accepted the drill payment. Nothing was sent.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The vault would have accepted'))
      throw error;
    refusal = describeContractError(error);
  }

  // Send it anyway with a fixed gas limit, so the refusal is on the public record.
  const transactionHash: Hex = await wallet(accounts.EXECUTOR).sendTransaction({
    to: info.vault,
    data: encodeFunctionData(call),
    gas: 300_000n,
  });
  await confirm(
    '6',
    `executor key tries to pay 9 ${info.tokenSymbol} to the attacker; the vault reverts`,
    transactionHash,
    'reverted',
  );
  log(`           ${refusal}`);

  const [stolen, vaultAfter] = await Promise.all([balanceOf(attacker), balanceOf(info.vault)]);
  if (stolen !== 0n || vaultAfter !== vaultBefore) throw new Error('Funds moved during the drill');
  log(
    `  ok       the attacker received 0 ${info.tokenSymbol}; the vault still holds ${formatUnits(vaultAfter, info.tokenDecimals)} ${info.tokenSymbol}`,
  );
}
