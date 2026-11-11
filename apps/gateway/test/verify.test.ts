import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { approvalTypedData } from '../src/protocol/approval';
import { type EvidenceFile, evidenceHash } from '../src/protocol/evidence';
import { signIntent } from '../src/protocol/intent';
import { type VerifierChain, verifyEvidence } from '../src/verify';
import { type Harness, createHarness } from './fakes';
import { DOMAIN, USDC, VAULT, makeIntent, newAccount, newAddress } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function decide(overrides: Parameters<typeof makeIntent>[0] = {}): Promise<EvidenceFile> {
  const intent = makeIntent({
    agentId: h.world.agentId.toString(),
    payee: h.world.vendorA,
    ...overrides,
  });
  const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
  return (await h.gateway.evidenceFor(outcome.intentId)) as EvidenceFile;
}

/** The chain as the fake world left it, seen through the verifier's eyes. */
function chainOf(file: EvidenceFile, changes: Partial<VerifierChain> = {}): VerifierChain {
  const info = h.world.info();
  return {
    chainId: () => Promise.resolve(421_614),
    vaultSettings: async () => {
      const { principal, token, identityRegistry } = await info;
      return { principal, token, identityRegistry };
    },
    agentWallet: (_registry, agentId) =>
      Promise.resolve(h.world.agents.get(agentId)?.wallet ?? null),
    evidenceUsed: (_vault, hash) => Promise.resolve(h.world.usedEvidence.has(hash)),
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
            name: 'MandatePayment' as const,
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
    ...changes,
  };
}

const failedLabels = (report: Awaited<ReturnType<typeof verifyEvidence>>) =>
  report.checks.filter((check) => check.verdict === 'fail').map((check) => check.label);

/** What someone does who edits a record and then covers their tracks by recomputing the hash. */
function rehash(file: EvidenceFile): EvidenceFile {
  return { ...file, evidenceHash: evidenceHash(file.record) };
}

describe('verify-evidence: honest files', () => {
  it('verifies a paid record against itself, the chain and the ledger', async () => {
    const file = await decide();
    const report = await verifyEvidence(file, { chain: chainOf(file), ledger: h.ledger.entries });

    expect(failedLabels(report)).toEqual([]);
    expect(report.verified).toBe(true);
    expect(report.checks.every((check) => check.verdict === 'pass')).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(16);
  });

  it('verifies a file that went through JSON on disk', async () => {
    const file = await decide();
    const fromDisk: unknown = JSON.parse(JSON.stringify(file, null, 2));
    const report = await verifyEvidence(fromDisk, {
      chain: chainOf(file),
      ledger: h.ledger.entries,
    });
    expect(report.verified).toBe(true);
  });

  it('verifies a refused record: nothing was paid on it', async () => {
    const file = await decide({ payee: newAddress(), context: { payeeSource: 'tool response' } });
    expect(file.result.status).toBe('refused');
    const report = await verifyEvidence(file, { chain: chainOf(file), ledger: h.ledger.entries });
    expect(failedLabels(report)).toEqual([]);
    expect(report.checks.map((check) => check.label)).toContain(
      'Vault has not paid anything on this evidence hash',
    );
  });

  it('verifies a record that is waiting for approval', async () => {
    const file = await decide({ amount: (6n * USDC).toString() });
    expect(file.result.status).toBe('pending_approval');
    const report = await verifyEvidence(file, { chain: chainOf(file), ledger: h.ledger.entries });
    expect(failedLabels(report)).toEqual([]);
  });

  it('runs offline and says what it did not check', async () => {
    const file = await decide();
    const report = await verifyEvidence(file, { chain: null });
    expect(report.verified).toBe(true);
    expect(report.checks.filter((check) => check.verdict === 'skipped')).toHaveLength(3);
  });
});

describe('verify-evidence: files that were changed', () => {
  it('catches a changed amount', async () => {
    const file = await decide();
    file.record.what.amount = '15000000';
    const report = await verifyEvidence(file, { chain: chainOf(file) });
    expect(report.verified).toBe(false);
    expect(failedLabels(report)).toContain('Evidence hash is the hash of the record');
  });

  it('catches a changed amount even when the hash was recomputed to match', async () => {
    const original = await decide();
    const forged = structuredClone(original);
    forged.record.what.amount = '15000000';
    const report = await verifyEvidence(rehash(forged), {
      chain: chainOf(original),
      ledger: h.ledger.entries,
    });

    expect(report.verified).toBe(false);
    expect(failedLabels(report)).toEqual(
      expect.arrayContaining([
        'Recorded agent, payee, amount and purpose are the ones the agent signed',
        'Ledger records this decision',
      ]),
    );
  });

  it('catches a request that was rewritten together with the record', async () => {
    const original = await decide();
    const forged = structuredClone(original);
    forged.record.what.amount = '15000000';
    forged.record.request.intent.amount = '15000000';
    const report = await verifyEvidence(rehash(forged), { chain: chainOf(original) });

    expect(report.verified).toBe(false);
    expect(failedLabels(report)).toEqual(
      expect.arrayContaining([
        'Intent id is the hash of the signed request',
        'Request signature recovers the recorded signer',
      ]),
    );
  });

  it('catches a payee swapped after the fact', async () => {
    const original = await decide();
    const forged = structuredClone(original);
    const thief = newAddress();
    forged.record.what.payee = thief;
    forged.record.request.intent.payee = thief;
    const report = await verifyEvidence(rehash(forged), { chain: chainOf(original) });
    expect(report.verified).toBe(false);
  });

  it('catches a refusal turned into an approval', async () => {
    const original = await decide({ payee: newAddress() });
    const forged = structuredClone(original);
    forged.record.why.decision = 'auto';
    const report = await verifyEvidence(rehash(forged), { chain: chainOf(original) });
    expect(failedLabels(report)).toContain('Decision follows from the recorded checks');
  });

  it('catches a failed check quietly flipped to passed', async () => {
    const original = await decide({ payee: newAddress() });
    const forged = structuredClone(original);
    for (const check of forged.record.why.checks) check.result = 'pass';
    forged.record.why.decision = 'auto';
    const report = await verifyEvidence(rehash(forged), {
      chain: chainOf(original),
      ledger: h.ledger.entries,
    });
    expect(report.verified).toBe(false);
    expect(failedLabels(report)).toEqual(
      expect.arrayContaining(['Result fits the decision', 'Ledger records this decision']),
    );
  });

  it('catches a payment claimed with a transaction that does not exist', async () => {
    const file = await decide();
    const forged = structuredClone(file);
    if (forged.result.status !== 'paid') throw new Error('expected a paid record');
    forged.result.transactionHash = `0x${'12'.repeat(32)}`;
    const report = await verifyEvidence(forged, { chain: chainOf(file) });
    expect(failedLabels(report)).toContain('Payment transaction exists and succeeded');
  });

  it('catches a paid claim on a record the vault never paid', async () => {
    const pending = await decide({ amount: (6n * USDC).toString() });
    const paid = await decide();
    if (paid.result.status !== 'paid') throw new Error('expected a paid record');
    const forged = structuredClone(pending);
    forged.result = { ...paid.result };
    const report = await verifyEvidence(forged, { chain: chainOf(paid) });
    expect(report.verified).toBe(false);
  });

  it('catches a record for another vault or another principal', async () => {
    const file = await decide();
    const report = await verifyEvidence(file, {
      chain: chainOf(file, {
        vaultSettings: async () => ({
          ...(await chainOf(file).vaultSettings(VAULT)),
          principal: newAddress(),
        }),
      }),
    });
    expect(failedLabels(report)).toContain('Vault settings onchain match the record');
  });

  it('catches an agent wallet that the registry does not name', async () => {
    const file = await decide();
    const report = await verifyEvidence(file, {
      chain: chainOf(file, { agentWallet: () => Promise.resolve(newAddress()) }),
    });
    expect(failedLabels(report)).toContain('ERC-8004 registry names the recorded agent wallet');
  });

  it('catches an event with a different amount', async () => {
    const file = await decide();
    const honest = chainOf(file);
    const report = await verifyEvidence(file, {
      chain: chainOf(file, {
        payment: async (vault: Address, hash: Hex) => {
          const payment = await honest.payment(vault, hash);
          return {
            ...payment,
            events: payment.events.map((event) => ({ ...event, amount: event.amount + 1n })),
          };
        },
      }),
    });
    expect(failedLabels(report)).toContain(
      'Vault event carries this evidence hash and the same mandate, agent, payee and amount',
    );
  });

  it('refuses to check against the wrong chain', async () => {
    const file = await decide();
    const report = await verifyEvidence(file, {
      chain: chainOf(file, { chainId: () => Promise.resolve(42_161) }),
    });
    expect(failedLabels(report)).toEqual(['RPC endpoint is on the chain named in the record']);
  });

  it('catches a ledger that was edited', async () => {
    const file = await decide();
    const entries = h.ledger.entries.map((entry) => structuredClone(entry));
    (entries[0] as (typeof entries)[number]).summary = 'nothing to see here';
    const report = await verifyEvidence(file, { chain: chainOf(file), ledger: entries });
    expect(failedLabels(report)).toContain('Ledger hash chain is intact');
  });

  it('catches a ledger that does not mention the payment', async () => {
    const file = await decide();
    const report = await verifyEvidence(file, {
      chain: chainOf(file),
      ledger: h.ledger.entries.slice(0, 1),
    });
    expect(failedLabels(report)).toEqual(['Ledger records this payment']);
  });

  it.each([
    ['null', null],
    ['a string', 'paid, trust me'],
    ['an empty object', {}],
    ['a file with an extra field', 'extra'],
    ['a file of another format', 'format'],
  ])('rejects %s without guessing', async (_name, input) => {
    let candidate: unknown = input;
    if (input === 'extra') candidate = { ...(await decide()), note: 'approved by the CFO' };
    if (input === 'format') candidate = { ...(await decide()), format: 'something-else/v9' };
    const report = await verifyEvidence(candidate, { chain: null });
    expect(report.verified).toBe(false);
    expect(report.file).toBeNull();
    expect(report.checks).toHaveLength(1);
  });
});

describe('verify-evidence: approvals', () => {
  /** Builds the file the gateway will write once an approver has signed and the vault has paid. */
  async function approvedFile(signer = newAccount(), approverOnRecord?: Address) {
    const pending = await decide({ amount: (6n * USDC).toString() });
    const approver = approverOnRecord ?? signer.address;
    const file = structuredClone(pending);
    file.record.who.approver = approver;
    const hash = evidenceHash(file.record);
    const approval = {
      mandateId: 1n,
      payee: h.world.vendorA,
      amount: 6n * USDC,
      evidenceHash: hash,
      nonce: 0n,
      deadline: 1_900_000_000n,
    };
    const signature = await signer.signTypedData(
      approvalTypedData({ chainId: 421_614, address: VAULT }, approval),
    );
    const transactionHash: Hex = `0x${'ab'.repeat(32)}`;
    const complete: EvidenceFile = {
      ...file,
      evidenceHash: hash,
      approval: {
        approver,
        nonce: '0',
        deadline: '1900000000',
        signature,
        receivedAt: '2026-11-13T03:05:00.000Z',
      },
      result: {
        status: 'paid',
        transactionHash,
        blockNumber: '1001',
        event: 'ApprovedPayment',
        executedAt: '2026-11-13T03:05:02.000Z',
      },
    };
    const chain = chainOf(complete, {
      evidenceUsed: () => Promise.resolve(true),
      payment: () =>
        Promise.resolve({
          found: true,
          succeeded: true,
          to: VAULT,
          from: h.world.address,
          blockNumber: 1001n,
          events: [
            {
              name: 'ApprovedPayment' as const,
              mandateId: 1n,
              agentId: h.world.agentId,
              payee: h.world.vendorA,
              amount: 6n * USDC,
              evidenceHash: hash,
              approver,
              nonce: 0n,
            },
          ],
        }),
    });
    return { complete, chain };
  }

  it('verifies a payment made with the approver signature', async () => {
    const { complete, chain } = await approvedFile();
    const report = await verifyEvidence(complete, { chain });
    expect(failedLabels(report)).toEqual([]);
    expect(report.checks.map((check) => check.label)).toEqual(
      expect.arrayContaining([
        "Approval is signed by the mandate's approver, for this payee, amount and evidence hash",
        'Vault event names the approver and the approval nonce',
      ]),
    );
  });

  it('catches an approval signed by someone who is not the approver', async () => {
    const { complete, chain } = await approvedFile(newAccount(), newAddress());
    const report = await verifyEvidence(complete, { chain });
    expect(failedLabels(report)).toContain(
      "Approval is signed by the mandate's approver, for this payee, amount and evidence hash",
    );
  });

  it('catches an approval that was signed for a different amount', async () => {
    const { complete, chain } = await approvedFile();
    const forged = structuredClone(complete);
    forged.record.what.amount = (7n * USDC).toString();
    forged.record.request.intent.amount = (7n * USDC).toString();
    const report = await verifyEvidence(rehash(forged), { chain });
    expect(report.verified).toBe(false);
  });
});
