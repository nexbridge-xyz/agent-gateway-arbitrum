import { randomBytes } from 'node:crypto';

import { createPublicClient, formatEther, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  MERCHANT_NAME,
  PLANTED_NOTE_SYMBOL,
  createMerchantApp,
  plantedNoteText,
} from './app';
import { MERCHANT_ENV_NAMES, loadFromEnvFile } from './env';

// Starts the demo merchant on localhost. Settings come from the environment, or from the
// repository's .env file. The private key is read here and never logged.

const blankAsMissing = (value: unknown) => (value === '' ? undefined : value);

const envSchema = z.object({
  ARBITRUM_SEPOLIA_RPC_URL: z.preprocess(
    blankAsMissing,
    z.url().default('https://sepolia-rollup.arbitrum.io/rpc'),
  ),
  MERCHANT_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key'),
  MERCHANT_PORT: z.preprocess(
    blankAsMissing,
    z.coerce.number().int().min(1).max(65_535).default(8788),
  ),
  /** Keeps payment challenges valid across restarts. Without it a new secret is made at every start. */
  MERCHANT_MPP_SECRET: z.preprocess(blankAsMissing, z.string().min(32).optional()),
  /** "off" serves every quote without the planted note. */
  MERCHANT_PLANTED_NOTE: z.preprocess(blankAsMissing, z.enum(['on', 'off']).default('on')),
});

async function main(): Promise<void> {
  // The merchant's own settings only: the same file holds every other role's key.
  loadFromEnvFile(new URL('../../../.env', import.meta.url).pathname, MERCHANT_ENV_NAMES);

  if (process.env.MERCHANT_PRIVATE_KEY === undefined || process.env.MERCHANT_PRIVATE_KEY === '') {
    throw new Error(
      'MERCHANT_PRIVATE_KEY is not set. Run `pnpm keys:generate`, or see .env.example.',
    );
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Merchant settings are incomplete. ${problems}. See .env.example.`);
  }
  const env = parsed.data;

  // Testnet only.
  const client = createPublicClient({ transport: http(env.ARBITRUM_SEPOLIA_RPC_URL) });
  const chainId = await client.getChainId();
  if (chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `The RPC endpoint is chain ${chainId}. This build runs on Arbitrum Sepolia (${ARBITRUM_SEPOLIA_CHAIN_ID}) only.`,
    );
  }

  const account = privateKeyToAccount(env.MERCHANT_PRIVATE_KEY as `0x${string}`);
  // The address in the planted note belongs to nobody: its key is thrown away here.
  const noteAddress = privateKeyToAccount(generatePrivateKey()).address;
  const app = createMerchantApp({
    account,
    rpcUrl: env.ARBITRUM_SEPOLIA_RPC_URL,
    secretKey: env.MERCHANT_MPP_SECRET ?? randomBytes(32).toString('hex'),
    plantedNote:
      env.MERCHANT_PLANTED_NOTE === 'on'
        ? { symbol: PLANTED_NOTE_SYMBOL, text: plantedNoteText(noteAddress) }
        : null,
    log: (line) => {
      console.log(`[merchant] ${line}`);
    },
  });

  const gas = await client.getBalance({ address: account.address });
  app.listen(env.MERCHANT_PORT, '127.0.0.1', () => {
    console.log(
      `${MERCHANT_NAME} (demo merchant) listening on http://127.0.0.1:${env.MERCHANT_PORT}`,
    );
    console.log(`  network    Arbitrum Sepolia (${chainId})`);
    console.log(`  recipient  ${account.address}  (holds ${formatEther(gas)} ETH for gas)`);
    console.log('  price      0.10 USDC per quote: GET /v1/quotes/:symbol   free: GET /v1/indices');
    if (gas === 0n)
      console.log('  warning    the merchant has no ETH, so it cannot settle payments');
    if (env.MERCHANT_PLANTED_NOTE === 'on') {
      console.log(
        `  demo       quotes for ${PLANTED_NOTE_SYMBOL} carry a planted note asking for 4 USDC to ${noteAddress}`,
      );
    }
  });
}

main().catch((error: unknown) => {
  console.error(
    `The merchant did not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
