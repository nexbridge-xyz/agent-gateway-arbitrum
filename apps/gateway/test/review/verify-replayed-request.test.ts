import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type EvidenceFile, type EvidenceRecord, evidenceHash } from '../../src/protocol/evidence';
import { signIntent } from '../../src/protocol/intent';
import { type VerifierChain, verifyEvidence } from '../../src/verify';
import { type Harness, createHarness } from '../fakes';
import { DOMAIN, NOW, VAULT, makeIntent } from '../helpers';

/**
 * Review finding: SECURITY.md says of a thief who holds the gateway's keys: "False evidence does not
 * survive a check: the thief cannot forge the agent's or the approver's signature".
 *
 * The thief does not have to forge anything. Every request the agent ever signed sits in the evidence
 * store, signature included, and the read endpoints hand it out. The vault takes each *evidence hash*
 * once, but the evidence hash covers fields the gateway writes (the decision time, the block), so the
 * same signed request can stand behind any number of evidence records. `verify-evidence` looks at one
 * file at a time and never compares the request's expiry with the time of the payment, so it calls
 * each of them VERIFIED.
 */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

/** Block times the fake chain reports. The honest payment and the replay are a week apart. */
const blockTimes = new Map<bigint, number>();

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
    payment: (_vault, transactionHash) => {
      const paid = h.world.payments.find((payment) => payment.evidenceHash === file.evidenceHash);
      if (
        file.result.status !== 'paid' ||
        paid === undefined ||
        transactionHash !== file.result.transactionHash
      ) {
        return Promise.resolve({
          found: false,
          succeeded: false,
          to: null,
          from: null,
          blockNumber: null,
          events: [],
        });
      }
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
    // What a fixed verifier needs: the time of a block.
    blockTimestamp: (blockNumber: bigint) => Promise.resolve(blockTimes.get(blockNumber) ?? null),
    token: () => Promise.resolve({ symbol: 'USDC', decimals: 6 }),
  };
}

const failed = (report: Awaited<ReturnType<typeof verifyEvidence>>) =>
  report.checks.filter((check) => check.verdict === 'fail').map((check) => check.label);

describe('review: one signed request, paid twice, verified twice', () => {
  it('an honest payment verifies (control)', async () => {
    const intent = makeIntent({ agentId: h.world.agentId.toString(), payee: h.world.vendorA });
    blockTimes.set(h.world.blockNumber, h.world.time);
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    blockTimes.set(h.world.blockNumber, h.world.time + 1);
    const file = (await h.gateway.evidenceFor(outcome.intentId)) as EvidenceFile;

    const report = await verifyEvidence(file, { chain: chainOf(file) });
    expect(failed(report)).toEqual([]);
    expect(report.verified).toBe(true);
  });

  it('a record built a week later on the same signed request must not verify', async () => {
    // Day 1: the agent asks once, and the gateway pays once. All honest.
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.vendorA,
      amount: '1500000',
      expiresAt: NOW + 300,
    });
    blockTimes.set(h.world.blockNumber, h.world.time);
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    blockTimes.set(h.world.blockNumber, h.world.time + 1);
    const honest = (await h.gateway.evidenceFor(outcome.intentId)) as EvidenceFile;
    expect(honest.result.status).toBe('paid');

    // Day 8: a thief holds the executor key and the gateway's files. The request expired a week ago.
    h.world.time = NOW + 7 * 86_400;
    h.world.blockNumber += 2_000_000n;
    h.world.spentToday = 0n; // a new UTC day in the vault
    blockTimes.set(h.world.blockNumber, h.world.time);

    // The thief writes a new record around the agent's old request. Only gateway-written fields
    // change: the time, the block. The request and its signature are copied as they are.
    const record: EvidenceRecord = {
      ...structuredClone(honest.record),
      decidedAt: new Date(h.world.time * 1000).toISOString(),
      chain: {
        ...honest.record.chain,
        blockNumber: h.world.blockNumber.toString(),
        blockTimestamp: h.world.time,
      },
    };
    const hash = evidenceHash(record);
    expect(hash).not.toBe(honest.evidenceHash);

    // The vault sees a fresh evidence hash and an executor inside the mandate. It pays again.
    const receipt = await h.world.payWithinMandate({
      mandateId: BigInt(record.who.mandateId as string),
      payee: record.what.payee,
      amount: BigInt(record.what.amount),
      evidenceHash: hash,
    });
    blockTimes.set(receipt.blockNumber, h.world.time + 1);
    expect(h.world.payments).toHaveLength(2);

    const replayed: EvidenceFile = {
      format: honest.format,
      evidenceHash: hash,
      record,
      approval: null,
      result: {
        status: 'paid',
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        event: 'MandatePayment',
        executedAt: new Date((h.world.time + 1) * 1000).toISOString(),
      },
      updatedAt: new Date((h.world.time + 1) * 1000).toISOString(),
    };

    // The agent asked once. This file says it asked again, a week after the request ran out.
    expect(replayed.record.request.signature).toBe(honest.record.request.signature);
    expect(replayed.record.chain.blockTimestamp).toBeGreaterThan(intent.expiresAt);

    const report = await verifyEvidence(replayed, { chain: chainOf(replayed) });
    expect(report.verified).toBe(false);
    expect(failed(report)).toContain('Request was current at the block the decision was based on');
  });

  it('a replay that backdates its decision to the old block must not verify either', async () => {
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.vendorA,
      expiresAt: NOW + 300,
    });
    const decisionBlock = h.world.blockNumber;
    blockTimes.set(decisionBlock, h.world.time);
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    blockTimes.set(h.world.blockNumber, h.world.time + 1);
    const honest = (await h.gateway.evidenceFor(outcome.intentId)) as EvidenceFile;

    h.world.time = NOW + 7 * 86_400;
    h.world.blockNumber += 2_000_000n;
    h.world.spentToday = 0n;

    // This time the thief keeps the old block in the record, so the request looks current, and
    // changes only the gateway's own clock field to get a new hash.
    const record: EvidenceRecord = {
      ...structuredClone(honest.record),
      decidedAt: new Date((NOW + 1) * 1000).toISOString().replace('.000Z', '.123Z'),
    };
    expect(record.chain.blockNumber).toBe(decisionBlock.toString());
    const hash = evidenceHash(record);
    const receipt = await h.world.payWithinMandate({
      mandateId: BigInt(record.who.mandateId as string),
      payee: record.what.payee,
      amount: BigInt(record.what.amount),
      evidenceHash: hash,
    });
    blockTimes.set(receipt.blockNumber, h.world.time + 1);

    const replayed: EvidenceFile = {
      format: honest.format,
      evidenceHash: hash,
      record,
      approval: null,
      result: {
        status: 'paid',
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        event: 'MandatePayment',
        executedAt: new Date((h.world.time + 1) * 1000).toISOString(),
      },
      updatedAt: new Date((h.world.time + 1) * 1000).toISOString(),
    };

    const report = await verifyEvidence(replayed, { chain: chainOf(replayed) });
    expect(report.verified).toBe(false);
    expect(failed(report)).toContain(
      'Payment inside the mandate was mined right after the decision',
    );
  });
});
