import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';

import {
  type Account,
  type Address,
  type Hex,
  type TransactionReceipt,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from 'viem';
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

import { type Agent, type AgentTools, createAgent, createAgentTools } from '@agent-gateway/agent';
import {
  type Runtime,
  configFromEnv,
  createApp,
  createRuntime,
  explorerTx,
  repositoryRoot,
} from '@agent-gateway/gateway';
import {
  MERCHANT_NAME,
  PLANTED_NOTE_SYMBOL,
  createMerchantApp,
  plantedNoteText,
} from '@agent-gateway/merchant';

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

/**
 * The fictional company and vendors of the demo. The names are coined for this demo; none is a real
 * company or brand.
 */
export const NAMES = {
  principal: 'Kirenami Trading',
  agent: 'Kirenami research and procurement agent',
  /** Sells market data per call. */
  merchant: MERCHANT_NAME,
  /** Sends invoices for supplies. */
  vendorA: 'Koishi Supply',
  /** Sends invoices for research reports. */
  vendorB: 'Nagikumo Research',
  spendWallet: 'Agent Gateway spend wallet',
} as const;

export type RunOptions = {
  /** Revoke the agent's current mandates, if they are still active, and create new ones. */
  fresh: boolean;
  /** How long a new mandate is valid. */
  validDays: number;
};

/** What a transaction was, for whoever turns the run log into a table. */
export type TransactionTag =
  | 'mandate-created'
  | 'purchase-funded'
  | 'purchase-settled'
  | 'paid'
  | 'paid-with-approval'
  | 'drill'
  | 'mandate-revoked';

export type LoggedTransaction = {
  step: string;
  label: string;
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: string;
  url: string;
  tag?: TransactionTag;
};

/** One decision of the gateway during the run. */
export type LoggedIntent = {
  step: string;
  intentId: Hex;
  /** The mandate the request was decided under. */
  mandateId: string | null;
  decision: string;
  status: string;
  payee: Address;
  payeeName: string | null;
  amount: string;
  reasons: string[];
  evidenceHash: Hex;
  evidenceChecks: string;
  /**
   * Who sent the request: the agent, or the runner standing in for an agent that has been fooled
   * (step 5, when the agent itself ignored the planted note).
   */
  sentBy: 'agent' | 'runner';
};

/** One "gateway compromised" drill: what was tried with the executor key, and how the vault refused. */
export type LoggedDrill = { name: string; attempt: string; refusal: string; transactionHash: Hex };

/** The agent's two mandates: one for vendor invoices, a small one that funds the spend wallet. */
export type MandateKind = 'vendors' | 'spend wallet';

/** A mandate created during the run, with the hash of its plain-text terms. */
export type LoggedMandate = {
  step: string;
  kind: MandateKind;
  mandateId: string;
  termsHash: Hex;
  validUntil: string;
  /** The transaction that created it. */
  transactionHash: Hex;
};

/** What happened to the note planted in a market-data response (step 5). */
export type PlantedNoteOutcome = {
  /** The address the note asks the agent to pay. Nobody holds its key. */
  address: Address;
  agent: string;
  /** Whether the agent asked for the payment itself, or ignored the note. */
  agentActedOnNote: boolean;
  intentId: Hex;
  decision: string;
};

/** What the setup step created, kept between runs so later steps can find it. */
export type DemoState = {
  chainId: number;
  vault: Address;
  agentId: string | null;
  /** The vendor mandate. */
  mandateId: string | null;
  termsHash: Hex | null;
  /** The spend wallet's mandate. */
  spendMandateId: string | null;
  spendTermsHash: Hex | null;
};

export type Context = Awaited<ReturnType<typeof createContext>>;

function listen(server: Server, what: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} is in use, so ${what} cannot start. Stop what is using it, or set MERCHANT_PORT and run step 1 again.`,
            )
          : error,
      );
    });
  });
}

export async function createContext(envFile: string, options: RunOptions) {
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
  if (runtime.purchases === null) {
    throw new Error(`SPEND_WALLET_PRIVATE_KEY is missing in ${envFile}. Run: pnpm keys:generate`);
  }
  const info = await runtime.chain.info();
  const transport = http(config.rpcUrl);
  const wallet = (account: Account) =>
    createWalletClient({ account, chain: arbitrumSepolia, transport });

  const merchantPort = Number(process.env.MERCHANT_PORT || 8788);
  /** Where the demo merchant listens. The principal's vendor registry names this address. */
  const merchantUrl = `http://127.0.0.1:${merchantPort}`;

  const transactions: LoggedTransaction[] = [];
  const intents: LoggedIntent[] = [];
  const drills: LoggedDrill[] = [];
  const mandates: LoggedMandate[] = [];
  const outcome: { plantedNote: PlantedNoteOutcome | null } = { plantedNote: null };
  const statePath = join(config.dataDir, 'demo-state.json');

  const log = (line = '') => {
    console.log(line);
  };

  const units = (value: string) => parseUnits(value, info.tokenDecimals);
  /** An amount as people write money: at least two decimals. */
  const money = (value: bigint) => {
    const [whole, fraction = ''] = formatUnits(value, info.tokenDecimals).split('.');
    return `${whole}.${fraction.padEnd(2, '0')} ${info.tokenSymbol}`;
  };
  const balanceOf = (owner: Address) =>
    publicClient.readContract({
      address: info.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    });

  /** A path as the reader of a log wants it: inside the repository if it is there. */
  const shown = (path: string) => {
    const inside = relative(repositoryRoot, path);
    return inside.startsWith('..') ? path : inside;
  };

  const record = (
    step: string,
    label: string,
    receipt: TransactionReceipt,
    tag: TransactionTag | undefined,
  ) => {
    const url = explorerTx(receipt.transactionHash);
    transactions.push({
      step,
      label,
      transactionHash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      url,
      ...(tag === undefined ? {} : { tag }),
    });
    log(`  ${receipt.status === 'success' ? 'ok      ' : 'REVERTED'} ${label}`);
    log(`           ${url}`);
  };

  /** Waits for a transaction and prints its explorer link. A revert is an error unless it is expected. */
  const confirm = async (
    step: string,
    label: string,
    transactionHash: Hex,
    expect: 'success' | 'reverted' = 'success',
    tag?: TransactionTag,
  ): Promise<TransactionReceipt> => {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      timeout: 120_000,
    });
    record(step, label, receipt, tag);
    if (receipt.status !== expect) {
      throw new Error(`"${label}" was expected to end as ${expect} but ended as ${receipt.status}`);
    }
    return receipt;
  };

  /** Prints the explorer link of a transaction somebody else sent: the gateway or the merchant. */
  const logTransaction = async (
    step: string,
    label: string,
    transactionHash: Hex,
    tag?: TransactionTag,
  ) => {
    record(step, label, await publicClient.getTransactionReceipt({ hash: transactionHash }), tag);
  };

  /**
   * On a local fork no block is produced until somebody sends a transaction, so the chain's clock
   * stands still and signed requests look as if they came from the future. Ask the node for a block.
   * A live network keeps its own time and does not offer this method.
   */
  const tick = async () => {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    if (Date.now() / 1000 - Number(block.timestamp) < 60) return;
    try {
      await publicClient.request({ method: 'evm_mine' } as never);
    } catch {
      // A live network: nothing to do.
    }
  };

  const readState = async (): Promise<DemoState> => {
    const empty: DemoState = {
      chainId: info.chainId,
      vault: info.vault,
      agentId: null,
      mandateId: null,
      termsHash: null,
      spendMandateId: null,
      spendTermsHash: null,
    };
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Partial<DemoState>;
      // State from another vault or chain is of no use here. A file from before the spend wallet had
      // its own mandate lacks those fields.
      return state.chainId === info.chainId && state.vault === info.vault
        ? { ...empty, ...state }
        : empty;
    } catch {
      return empty;
    }
  };

  const writeState = async (state: DemoState) => {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  };

  // --- The services of the demo: the gateway, the merchant and the agent ---------------------------

  const servers: Server[] = [];
  let running: Promise<{ gatewayUrl: string; noteAddress: Address }> | null = null;

  /** Starts the gateway and the demo merchant on localhost, once. */
  const services = () => {
    running ??= (async () => {
      const gatewayServer = createApp({
        gateway: runtime.gateway,
        chain: runtime.chain,
        ledger: runtime.ledger,
        explorerTx,
      }).listen(0, '127.0.0.1');
      servers.push(gatewayServer);
      await listen(gatewayServer, 'the gateway', 0);

      // The address in the planted note belongs to nobody: its key is thrown away here.
      const noteAddress = privateKeyToAccount(generatePrivateKey()).address;
      const merchantServer = createMerchantApp({
        account: accounts.MERCHANT,
        rpcUrl: config.rpcUrl,
        secretKey: randomBytes(32).toString('hex'),
        plantedNote: { symbol: PLANTED_NOTE_SYMBOL, text: plantedNoteText(noteAddress) },
      }).listen(merchantPort, '127.0.0.1');
      servers.push(merchantServer);
      await listen(merchantServer, 'the demo merchant', merchantPort);

      return {
        gatewayUrl: `http://127.0.0.1:${(gatewayServer.address() as AddressInfo).port}`,
        noteAddress,
      };
    })();
    return running;
  };

  let working: Promise<{ agent: Agent; tools: AgentTools }> | null = null;

  /** The demo agent: Claude if ANTHROPIC_API_KEY is set, the scripted agent if not. */
  const agent = () => {
    working ??= (async () => {
      const state = await readState();
      if (state.agentId === null) throw new Error('No agent yet. Run step 1 first.');
      const { gatewayUrl } = await services();
      const tools = createAgentTools({
        account: accounts.AGENT,
        agentId: BigInt(state.agentId),
        domain: { chainId: info.chainId, vault: info.vault },
        gatewayUrl,
        merchantUrl,
        token: { symbol: info.tokenSymbol, decimals: info.tokenDecimals },
      });
      const created = await createAgent({
        tools,
        firm: NAMES.principal,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.AGENT_MODEL,
      });
      return { agent: created, tools };
    })();
    return working;
  };

  /** The agent that ran, if any step needed one. */
  const agentLabel = async () => (working === null ? null : (await working).agent.label);

  const stop = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  };

  return {
    options,
    names: NAMES,
    accounts,
    runtime,
    publicClient,
    info,
    wallet,
    merchantUrl,
    confirm,
    logTransaction,
    log,
    shown,
    units,
    money,
    balanceOf,
    tick,
    transactions,
    intents,
    drills,
    mandates,
    outcome,
    readState,
    writeState,
    services,
    agent,
    agentLabel,
    stop,
  };
}
