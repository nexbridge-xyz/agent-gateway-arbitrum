import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Account,
  type Address,
  type Hex,
  type TransactionReceipt,
  createWalletClient,
  formatEther,
  http,
} from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

import { type Runtime, configFromEnv, createRuntime, explorerTx } from '@agent-gateway/gateway';

/** Everything a demo step needs: the role keys, clients for the chain, and a log of what was done. */

const ROLES = [
  'DEPLOYER',
  'PRINCIPAL',
  'EXECUTOR',
  'APPROVER',
  'SPEND_WALLET',
  'MERCHANT',
  'AGENT',
  'VENDOR_A',
  'VENDOR_B',
] as const;

export type Role = (typeof ROLES)[number];

/** The fictional company and vendors of the demo. No real brands. */
export const NAMES = {
  principal: 'Mizunara Trading',
  agent: 'Mizunara research and procurement agent',
  vendorA: 'Tsukimi Data',
  vendorB: 'Koishi Supply',
  spendWallet: 'Agent Gateway spend wallet',
} as const;

export type LoggedTransaction = {
  step: string;
  label: string;
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: string;
  url: string;
};

/** What the setup step created, kept between runs so later steps can find it. */
export type DemoState = {
  chainId: number;
  vault: Address;
  agentId: string | null;
  mandateId: string | null;
  termsHash: Hex | null;
};

export type Context = Awaited<ReturnType<typeof createContext>>;

export async function createContext(envFile: string) {
  if (!existsSync(envFile)) {
    throw new Error(`No settings file at ${envFile}. Run: pnpm keys:generate`);
  }
  // Variables that are already set win over the file, so a single run can be pointed elsewhere.
  process.loadEnvFile(envFile);

  const accounts = Object.fromEntries(
    ROLES.map((role) => {
      const key = process.env[`${role}_PRIVATE_KEY`] ?? '';
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error(`${role}_PRIVATE_KEY is missing in ${envFile}. Run: pnpm keys:generate`);
      }
      return [role, privateKeyToAccount(key as Hex)];
    }),
  ) as Record<Role, PrivateKeyAccount>;

  const runtime: Runtime = await createRuntime(configFromEnv());
  const { publicClient, config } = runtime;
  const info = await runtime.chain.info();
  const transport = http(config.rpcUrl);
  const wallet = (account: Account) =>
    createWalletClient({ account, chain: arbitrumSepolia, transport });

  const transactions: LoggedTransaction[] = [];
  const statePath = join(config.dataDir, 'demo-state.json');

  const log = (line = '') => {
    console.log(line);
  };

  /** Waits for a transaction and prints its explorer link. A revert is an error unless it is expected. */
  const confirm = async (
    step: string,
    label: string,
    transactionHash: Hex,
    expect: 'success' | 'reverted' = 'success',
  ): Promise<TransactionReceipt> => {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      timeout: 120_000,
    });
    const url = explorerTx(transactionHash);
    transactions.push({
      step,
      label,
      transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      url,
    });
    log(`  ${receipt.status === 'success' ? 'ok      ' : 'REVERTED'} ${label}`);
    log(`           ${url}`);
    if (receipt.status !== expect) {
      throw new Error(`"${label}" was expected to end as ${expect} but ended as ${receipt.status}`);
    }
    return receipt;
  };

  const readState = async (): Promise<DemoState> => {
    const empty: DemoState = {
      chainId: info.chainId,
      vault: info.vault,
      agentId: null,
      mandateId: null,
      termsHash: null,
    };
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as DemoState;
      // State from another vault or chain is of no use here.
      return state.chainId === info.chainId && state.vault === info.vault ? state : empty;
    } catch {
      return empty;
    }
  };

  const writeState = async (state: DemoState) => {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  };

  const ethBalance = async (address: Address) =>
    formatEther(await publicClient.getBalance({ address }));

  return {
    accounts,
    runtime,
    publicClient,
    info,
    wallet,
    confirm,
    log,
    transactions,
    readState,
    writeState,
    ethBalance,
  };
}
