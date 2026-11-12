import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { z } from 'zod';

import deployment from '@agent-gateway/contracts/deployments/arbitrum-sepolia.json' with { type: 'json' };

import { createPaymentExecutor } from './chain/executor';
import { createPurchaseClient } from './chain/purchases';
import { createChainReader } from './chain/reader';
import { Gateway } from './gateway';
import type { AppOptions } from './server';
import { EvidenceStore } from './store/evidenceStore';
import { Ledger } from './store/ledger';
import { MandateTermsStore } from './store/mandateTerms';
import { PayeeDirectory } from './store/payees';
import { createVerifierChain, verifyEvidence } from './verify';

/** Settings come from the environment. Secrets are read here and nowhere else, and are never logged. */

const blankAsMissing = (value: unknown) => (value === '' ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankAsMissing, schema.optional());
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key');

const envSchema = z.object({
  ARBITRUM_SEPOLIA_RPC_URL: z.preprocess(
    blankAsMissing,
    z.url().default('https://sepolia-rollup.arbitrum.io/rpc'),
  ),
  EXECUTOR_PRIVATE_KEY: privateKey,
  SPEND_WALLET_PRIVATE_KEY: optional(privateKey),
  MANDATE_VAULT_ADDRESS: optional(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  GATEWAY_PORT: z.preprocess(
    blankAsMissing,
    z.coerce.number().int().min(1).max(65_535).default(8787),
  ),
  GATEWAY_DATA_DIR: optional(z.string().min(1)),
  GATEWAY_PURCHASE_CALL_CAP: optional(
    z.string().regex(/^[0-9]+(\.[0-9]+)?$/, 'must be an amount such as 0.5'),
  ),
});

export type GatewayConfig = {
  rpcUrl: string;
  executorKey: Hex;
  /** The low-value wallet that pays per-call API charges. Without it the gateway refuses purchases. */
  spendWalletKey: Hex | null;
  /** The most the gateway pays for one API call, in whole tokens. */
  purchaseCallCap: string;
  vault: Address;
  port: number;
  dataDir: string;
};

/** The repository root, three levels above this file. */
export const repositoryRoot = new URL('../../../', import.meta.url).pathname;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (env.EXECUTOR_PRIVATE_KEY === undefined || env.EXECUTOR_PRIVATE_KEY === '') {
    throw new Error(
      'EXECUTOR_PRIVATE_KEY is not set. Run `pnpm keys:generate`, or see .env.example.',
    );
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Gateway settings are incomplete. ${problems}. See .env.example.`);
  }
  return {
    rpcUrl: parsed.data.ARBITRUM_SEPOLIA_RPC_URL,
    executorKey: parsed.data.EXECUTOR_PRIVATE_KEY as Hex,
    spendWalletKey: (parsed.data.SPEND_WALLET_PRIVATE_KEY as Hex | undefined) ?? null,
    purchaseCallCap: parsed.data.GATEWAY_PURCHASE_CALL_CAP ?? '0.5',
    vault: getAddress(
      parsed.data.MANDATE_VAULT_ADDRESS ?? deployment.contracts.MandateVault.address,
    ),
    port: parsed.data.GATEWAY_PORT,
    dataDir: parsed.data.GATEWAY_DATA_DIR ?? join(repositoryRoot, 'apps/gateway/data'),
  };
}

export const EXPLORER_URL = 'https://sepolia.arbiscan.io';
export const explorerTx = (hash: Hex) => `${EXPLORER_URL}/tx/${hash}`;

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

/** Wires the gateway to Arbitrum Sepolia and to its data directory. */
export async function createRuntime(config: GatewayConfig) {
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });

  // Testnet only. Running against Arbitrum One is a separate, deliberate change.
  const chainId = await publicClient.getChainId();
  if (chainId !== arbitrumSepolia.id) {
    throw new Error(
      `The RPC endpoint is chain ${chainId}. This build runs on Arbitrum Sepolia (${arbitrumSepolia.id}) only.`,
    );
  }

  const account = privateKeyToAccount(config.executorKey);
  const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport });

  await mkdir(config.dataDir, { recursive: true });
  const chain = createChainReader(publicClient, config.vault);
  const executor = createPaymentExecutor(publicClient, walletClient, config.vault);
  const ledger = await Ledger.open(join(config.dataDir, 'ledger.jsonl'));
  const evidence = new EvidenceStore(join(config.dataDir, 'evidence'));
  const payeesPath = join(config.dataDir, 'payees.json');
  const mandateTerms = new MandateTermsStore(join(config.dataDir, 'mandates'));

  const info = await chain.info();
  const purchases =
    config.spendWalletKey === null
      ? null
      : createPurchaseClient(privateKeyToAccount(config.spendWalletKey), { rpcUrl: config.rpcUrl });

  const gateway = new Gateway({
    chain,
    executor,
    ledger,
    evidence,
    loadPayees: () => PayeeDirectory.load(payeesPath),
    purchases,
    purchaseCallCap: parseUnits(config.purchaseCallCap, info.tokenDecimals),
  });

  return {
    config,
    publicClient,
    chain,
    executor,
    purchases,
    ledger,
    evidence,
    gateway,
    payeesPath,
    mandateTerms,
  };
}

/** Everything the HTTP API needs from a runtime. */
export function appOptions(runtime: Runtime): AppOptions {
  const { gateway, chain, ledger, publicClient, mandateTerms } = runtime;
  return {
    gateway,
    chain,
    ledger,
    explorerTx,
    explorerUrl: EXPLORER_URL,
    mandateTerms,
    verify: (file) =>
      verifyEvidence(file, { chain: createVerifierChain(publicClient), ledger: ledger.entries }),
  };
}
