import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { z } from 'zod';

import deployment from '@agent-gateway/contracts/deployments/arbitrum-sepolia.json' with { type: 'json' };

import { createPaymentExecutor } from './chain/executor';
import { createChainReader } from './chain/reader';
import { Gateway } from './gateway';
import { EvidenceStore } from './store/evidenceStore';
import { Ledger } from './store/ledger';
import { PayeeDirectory } from './store/payees';

/** Settings come from the environment. Secrets are read here and nowhere else, and are never logged. */

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  ARBITRUM_SEPOLIA_RPC_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url().default('https://sepolia-rollup.arbitrum.io/rpc'),
  ),
  EXECUTOR_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key'),
  MANDATE_VAULT_ADDRESS: optional(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  GATEWAY_PORT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(1).max(65_535).default(8787),
  ),
  GATEWAY_DATA_DIR: optional(z.string().min(1)),
});

export type GatewayConfig = {
  rpcUrl: string;
  executorKey: Hex;
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
    vault: getAddress(
      parsed.data.MANDATE_VAULT_ADDRESS ?? deployment.contracts.MandateVault.address,
    ),
    port: parsed.data.GATEWAY_PORT,
    dataDir: parsed.data.GATEWAY_DATA_DIR ?? join(repositoryRoot, 'apps/gateway/data'),
  };
}

export const explorerTx = (hash: Hex) => `https://sepolia.arbiscan.io/tx/${hash}`;

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

  const gateway = new Gateway({
    chain,
    executor,
    ledger,
    evidence,
    loadPayees: () => PayeeDirectory.load(payeesPath),
  });

  return { config, publicClient, chain, executor, ledger, evidence, gateway, payeesPath };
}
