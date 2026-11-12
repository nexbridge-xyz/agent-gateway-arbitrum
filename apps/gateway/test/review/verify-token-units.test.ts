import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChainInfo } from '../../src/chain/reader';
import type { EvidenceFile } from '../../src/protocol/evidence';
import { signIntent } from '../../src/protocol/intent';
import { type VerifierChain, verifyEvidence } from '../../src/verify';
import { type Harness, createHarness } from '../fakes';
import { DOMAIN, VAULT, makeIntent } from '../helpers';

/**
 * Review finding: the verifier prints the amount with the token symbol and the decimals written in the
 * record, and never compares them with the token contract. The record is written by the gateway, so a
 * gateway that lies about the decimals gets a VERIFIED file that shows the wrong amount: here 6 USDC
 * left the vault and the verified record reads "0.006 USDC".
 */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

function chainOf(file: EvidenceFile): VerifierChain & Record<string, unknown> {
  return {
    chainId: () => Promise.resolve(421_614),
    vaultSettings: async () => {
      const { principal, token, identityRegistry } = await h.world.info();
      return { principal, token, identityRegistry };
    },
    agentWallet: (_registry, agentId) =>
      Promise.resolve(h.world.agents.get(agentId)?.wallet ?? null),
    evidenceUsed: (_vault, hash) => Promise.resolve(h.world.usedEvidence.has(hash)),
    tokenTransfers: () => Promise.resolve({ found: false, succeeded: false, transfers: [] }),
    payment: () => {
      const paid = h.world.payments.find((payment) => payment.evidenceHash === file.evidenceHash);
      if (file.result.status !== 'paid' || paid === undefined) throw new Error('not paid');
      return Promise.resolve({
        found: true,
        succeeded: true,
        to: VAULT,
        from: h.world.address,
        blockNumber: BigInt(file.result.blockNumber),
        events: [
          {
            name: paid.event,
            mandateId: paid.mandateId,
            agentId: h.world.agentId,
            payee: paid.payee,
            amount: paid.amount,
            evidenceHash: paid.evidenceHash,
            approver: null,
            nonce: null,
          },
        ],
      });
    },
    blockTimestamp: () => Promise.resolve(h.world.time),
    // The token contract itself: Circle's USDC has six decimals.
    token: () => Promise.resolve({ symbol: 'USDC', decimals: 6 }),
  };
}

describe('review: the amount a verified record shows', () => {
  it('must not verify a record that states other decimals than the token has', async () => {
    // A gateway that writes nine decimals into its records. Everything else is as on main.
    const info = h.world.info.bind(h.world);
    h.world.info = async (): Promise<ChainInfo> => ({ ...(await info()), tokenDecimals: 9 });

    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.vendorA,
      amount: '2000000',
    });
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    const file = (await h.gateway.evidenceFor(outcome.intentId)) as EvidenceFile;
    expect(file.result.status).toBe('paid');
    // 2,000,000 units left the vault: 2 USDC. The record says 0.002.
    expect(file.record.what.tokenDecimals).toBe(9);

    const report = await verifyEvidence(file, { chain: chainOf(file) });
    expect(report.verified).toBe(false);
    expect(
      report.checks.filter((check) => check.verdict === 'fail').map((check) => check.label),
    ).toEqual(['Token symbol and decimals in the record are the token contract’s']);
  });

  it('must not verify a record that names another symbol than the token has', async () => {
    const info = h.world.info.bind(h.world);
    h.world.info = async (): Promise<ChainInfo> => ({ ...(await info()), tokenSymbol: 'JPYC' });

    const intent = makeIntent({ agentId: h.world.agentId.toString(), payee: h.world.vendorA });
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    const file = (await h.gateway.evidenceFor(outcome.intentId)) as EvidenceFile;

    const report = await verifyEvidence(file, { chain: chainOf(file) });
    expect(report.verified).toBe(false);
  });
});
