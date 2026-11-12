import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mandateVaultAbi } from '../../src/chain/abis';
import { createPaymentExecutor } from '../../src/chain/executor';
import { Gateway } from '../../src/gateway';
import { type SignedIntent, signIntent } from '../../src/protocol/intent';
import { EvidenceStore } from '../../src/store/evidenceStore';
import { Ledger } from '../../src/store/ledger';
import { PayeeDirectory } from '../../src/store/payees';
import { FakeWorld } from '../fakes';
import { DOMAIN, NOW, VAULT, makeIntent } from '../helpers';

/**
 * Review finding: when the executor has sent a payment transaction and then cannot read its receipt
 * (the RPC endpoint times out or drops the connection), the gateway wrote "failed" into the evidence
 * file and told the agent "failed". The transaction is still on its way, or already mined. An agent,
 * or the person reading the console, takes "failed" to mean "not paid" and asks again: the vendor is
 * paid twice.
 *
 * The honest answer at that moment is "sent, not confirmed". Only the chain knows the rest.
 */

const TRANSACTION: Hex = keccak256(stringToHex('the payment that was sent'));

/** What the chain connection says about the transaction, as the test goes on. */
type Fate = 'unknown' | 'paid' | 'reverted';

let dir = '';
let world: FakeWorld;
let gateway: Gateway;
let ledger: Ledger;
let fate: Fate;
let sent: number;
let signed: SignedIntent;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agw-unconfirmed-'));
  world = new FakeWorld();
  fate = 'unknown';
  sent = 0;
  let evidenceHash: Hex = `0x${'00'.repeat(32)}`;

  // The real executor, on a chain connection that accepts the transaction and then goes quiet.
  const publicClient = {
    simulateContract: (call: { args: readonly unknown[] }) => {
      evidenceHash = call.args[3] as Hex;
      return Promise.resolve({ request: call });
    },
    waitForTransactionReceipt: () =>
      Promise.reject(new Error('Timed out while waiting for transaction to be confirmed')),
    getTransactionReceipt: () => {
      if (fate === 'unknown') return Promise.reject(new Error('transaction receipt not found'));
      return Promise.resolve({
        transactionHash: TRANSACTION,
        blockNumber: 1_234n,
        status: fate === 'paid' ? 'success' : 'reverted',
        logs:
          fate === 'paid'
            ? [
                {
                  address: VAULT,
                  blockHash: `0x${'cd'.repeat(32)}`,
                  blockNumber: 1_234n,
                  logIndex: 0,
                  transactionHash: TRANSACTION,
                  transactionIndex: 0,
                  removed: false,
                  topics: encodeEventTopics({
                    abi: mandateVaultAbi,
                    eventName: 'MandatePayment',
                    args: { mandateId: 1n, payee: world.vendorA, evidenceHash },
                  }),
                  data: encodeAbiParameters(
                    [{ type: 'uint256' }, { type: 'uint256' }],
                    [world.agentId, 1_500_000n],
                  ),
                },
              ]
            : [],
      });
    },
  } as unknown as PublicClient;
  const walletClient = {
    account: world.executorAccount,
    writeContract: () => {
      sent += 1;
      return Promise.resolve(TRANSACTION);
    },
  } as unknown as WalletClient<Transport, Chain, Account>;

  ledger = await Ledger.open(join(dir, 'ledger.jsonl'));
  gateway = new Gateway({
    chain: world,
    executor: createPaymentExecutor(publicClient, walletClient, VAULT),
    ledger,
    evidence: new EvidenceStore(join(dir, 'evidence')),
    loadPayees: () =>
      Promise.resolve(
        new PayeeDirectory({
          vendors: [{ name: 'Koishi Supply', address: world.vendorA }],
          denylist: [],
        }),
      ),
    now: () => new Date(NOW * 1000),
  });
  signed = await signIntent(
    world.agent,
    DOMAIN,
    makeIntent({ agentId: world.agentId.toString(), payee: world.vendorA }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('review: a payment that was sent but could not be confirmed', () => {
  it('must not be recorded as failed', async () => {
    const outcome = await gateway.submit(signed);

    // The transaction left this machine. Whether the vault paid is not known here.
    expect(sent).toBe(1);
    expect(outcome.transactionHash).toBe(TRANSACTION);
    expect(outcome.status).not.toBe('failed');

    const file = await gateway.evidenceFor(outcome.intentId);
    expect(file?.result.status).not.toBe('failed');
    expect(ledger.entries.map((entry) => entry.kind)).not.toContain('PAYMENT_FAILED');
  });

  it('is written down as paid once its receipt can be read, and is not sent again', async () => {
    const first = await gateway.submit(signed);
    expect(first.status).not.toBe('paid');

    // The endpoint is back, and the transaction turns out to have been mined.
    fate = 'paid';
    const again = await gateway.submit(signed);
    expect(again.status).toBe('paid');
    expect(again.transactionHash).toBe(TRANSACTION);
    expect(sent).toBe(1);
    expect((await gateway.evidenceFor(first.intentId))?.result).toMatchObject({
      status: 'paid',
      transactionHash: TRANSACTION,
      event: 'MandatePayment',
      blockNumber: '1234',
    });
  });

  it('is written down as failed once the transaction is known to have reverted', async () => {
    await gateway.submit(signed);
    fate = 'reverted';
    const again = await gateway.submit(signed);
    expect(again.status).toBe('failed');
    expect(again.transactionHash).toBe(TRANSACTION);
    expect(sent).toBe(1);
  });
});
