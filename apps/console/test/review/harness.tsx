import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { act } from '@testing-library/react';
import { type Address, type Hex, getAddress, numberToHex } from 'viem';
import { afterEach, beforeEach, vi } from 'vitest';
import { connect } from 'wagmi/actions';

import { MandateTermsStore, createApp, verifyEvidence } from '@agent-gateway/gateway';

import { App } from '@/App';
import type { Mandate } from '@/lib/vault';

import { type FakeMandate, type Harness, createHarness } from '../../../gateway/test/fakes';
import { DOMAIN, NOW, VAULT } from '../../../gateway/test/helpers';
import { bridge, fakeNode, show, testConfig } from '../helpers';

/**
 * For the review's console tests: the gateway's real code in this process, a stand-in node that plays
 * the wallet, and a way to change one of the gateway's answers on its way to the page, as a gateway
 * would change it that somebody else controls.
 *
 * A test file that uses this must mock '@/lib/vault' itself (mocks are per file) and hand the mock's
 * state to `useLyingGateway`.
 */

export const TERMS_HASH: Hex = `0x${'11'.repeat(32)}`;
export const TX_HASH: Hex = `0x${'ab'.repeat(32)}`;
/** A contract somebody else deployed. */
export const DECOY: Address = getAddress('0x00000000000000000000000000000000000dec07');
export const THIEF: Address = getAddress('0x000000000000000000000000000000000007e1ef');

export type ChainState = {
  mandates: () => unknown[];
  /** What the vault and its token say of themselves on the chain. */
  facts: () => Promise<unknown>;
};

export type World = {
  h: Harness;
  node: ReturnType<typeof fakeNode>;
};

/** Registers the setup and teardown, and returns the world of the running test. */
export function useLyingGateway(chainState: ChainState): World {
  const world = {} as World;
  let server: Server;

  const asMandate = (mandate: FakeMandate): Mandate => ({
    id: mandate.id,
    agentId: mandate.agentId,
    executor: mandate.executor,
    approver: world.h.world.approver,
    validUntil: mandate.validUntil,
    revoked: mandate.revoked,
    perPaymentCap: mandate.perPaymentCap,
    dailyCap: mandate.dailyCap,
    hardCeiling: mandate.hardCeiling,
    approvalNonce: mandate.approvalNonce,
    termsHash: TERMS_HASH,
    payees: [...mandate.payees],
    spentToday: mandate.spentToday,
    active: !mandate.revoked && NOW <= mandate.validUntil,
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);

    const h = await createHarness();
    world.h = h;
    chainState.mandates = () =>
      [h.world.spendMandate, h.world.mandate].filter((mandate) => mandate !== null).map(asMandate);
    // The chain tells the truth, whatever the gateway says.
    chainState.facts = async () => {
      const info = await h.world.info();
      return {
        principal: info.principal,
        identityRegistry: info.identityRegistry,
        token: { address: info.token, symbol: info.tokenSymbol, decimals: info.tokenDecimals },
      };
    };

    server = createApp({
      gateway: h.gateway,
      chain: h.world,
      ledger: h.ledger,
      explorerTx: (hash) => `https://explorer.example/tx/${hash}`,
      explorerUrl: 'https://explorer.example',
      mandateTerms: new MandateTermsStore(join(h.dir, 'mandates')),
      verify: (file) => verifyEvidence(file, { chain: null, ledger: h.ledger.entries }),
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    world.node = fakeNode({
      // The wallet signs whatever it is handed, as a wallet does once its owner has pressed "Sign".
      eth_signTypedData_v4: ([address, typedData]) => {
        if ((address as string).toLowerCase() !== h.world.approver.toLowerCase()) {
          throw new Error('the test node holds no key for this account');
        }
        return h.world.approverAccount.signTypedData(
          JSON.parse(typedData as string) as Parameters<
            typeof h.world.approverAccount.signTypedData
          >[0],
        );
      },
      eth_sendTransaction: () => TX_HASH,
      eth_getTransactionReceipt: () => ({
        transactionHash: TX_HASH,
        transactionIndex: '0x0',
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x3e9',
        from: h.world.principal,
        to: VAULT,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        type: '0x2',
      }),
      eth_getBlockByNumber: () => ({
        number: '0x3e8',
        hash: `0x${'cd'.repeat(32)}`,
        parentHash: `0x${'00'.repeat(32)}`,
        timestamp: numberToHex(NOW),
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        baseFeePerGas: '0x1',
        difficulty: '0x0',
        totalDifficulty: '0x0',
        size: '0x0',
        nonce: '0x0000000000000000',
        transactions: [],
        uncles: [],
      }),
      eth_blockNumber: () => '0x3e9',
      eth_chainId: () => numberToHex(DOMAIN.chainId),
    });
    bridge({
      gatewayUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      node: world.node,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await new Promise((resolve) => server.close(resolve));
    await world.h.cleanup();
  });

  return world;
}

/**
 * Changes one of the gateway's answers on its way to the page. `change` gets the real answer and
 * returns what the page is to see.
 */
export function lie(path: string, change: (real: Response) => Promise<Response>) {
  const honest = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const answer = await honest(input, init);
    return url.split('?')[0] === path && (init?.method ?? 'GET') === 'GET'
      ? change(answer)
      : answer;
  });
}

export const json = async <T,>(response: Response, change: (body: T) => T): Promise<Response> =>
  new Response(JSON.stringify(change((await response.json()) as T)), {
    headers: { 'content-type': 'application/json' },
  });

/** Opens a screen with the given wallets on offer, and connects the first of them. */
export async function open(hash: string, wallets: Address[] = []) {
  const config = testConfig(wallets);
  window.location.hash = hash;
  const view = show(<App />, config);
  const [first] = config.connectors;
  if (first !== undefined) {
    await act(async () => {
      await connect(config, { connector: first });
    });
  }
  return view;
}
