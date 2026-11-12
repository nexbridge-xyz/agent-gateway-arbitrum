import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '../src/gateway';
import {
  APPROVAL_DECLINE_TYPES,
  PAYMENT_APPROVAL_TYPES,
  approvalTypedData,
} from '../src/protocol/approval';
import { type EvidenceFile, evidenceHash } from '../src/protocol/evidence';
import { signIntent } from '../src/protocol/intent';
import { type VerifierChain, verifyEvidence } from '../src/verify';
import { type Harness, MERCHANT_ORIGIN, createHarness } from './fakes';
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
    // The fake chain does not keep its blocks. Each is taken to have the time its record names.
    blockTimestamp: () => Promise.resolve(file.record.chain.blockTimestamp),
    vaultSettings: async () => {
      const { principal, token, identityRegistry } = await info;
      return { principal, token, identityRegistry };
    },
    agentWallet: (_registry, agentId) =>
      Promise.resolve(h.world.agents.get(agentId)?.wallet ?? null),
    evidenceUsed: (_vault, hash) => Promise.resolve(h.world.usedEvidence.has(hash)),
    tokenTransfers: (_token, transactionHash) => {
      const transfer = h.purchases?.settlements.get(transactionHash);
      return Promise.resolve(
        transfer === undefined
          ? { found: false, succeeded: false, transfers: [] }
          : { found: true, succeeded: true, transfers: [transfer] },
      );
    },
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
      const approved = paid.event === 'ApprovedPayment';
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
            approver: approved ? h.world.approver : null,
            nonce: approved ? (h.world.approvalNonces.get(paid.evidenceHash) ?? null) : null,
          },
        ],
      });
    },
    token: async () => {
      const { tokenSymbol, tokenDecimals } = await info;
      return { symbol: tokenSymbol, decimals: tokenDecimals };
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

describe('verify-evidence: approvals and declines as the gateway records them', () => {
  async function waiting(): Promise<{ file: EvidenceFile; pending: PendingApproval }> {
    const file = await decide({ payee: h.world.vendorB, amount: (6n * USDC).toString() });
    const pending = (await h.gateway.pendingApprovals())[0] as PendingApproval;
    return { file, pending };
  }

  function signApproval(pending: PendingApproval, account = h.world.approverAccount) {
    const { message } = pending.approval;
    return account.signTypedData({
      domain: pending.approval.domain,
      types: PAYMENT_APPROVAL_TYPES,
      primaryType: 'PaymentApproval',
      message: {
        mandateId: BigInt(message.mandateId),
        payee: message.payee,
        amount: BigInt(message.amount),
        evidenceHash: message.evidenceHash,
        nonce: BigInt(message.nonce),
        deadline: BigInt(message.deadline),
      },
    });
  }

  function signDecline(pending: PendingApproval, account = h.world.approverAccount) {
    return account.signTypedData({
      domain: pending.decline.domain,
      types: APPROVAL_DECLINE_TYPES,
      primaryType: 'ApprovalDecline',
      message: pending.decline.message,
    });
  }

  it('verifies an approved payment against itself, the chain and the ledger', async () => {
    const { file, pending } = await waiting();
    await h.gateway.approve(file.record.intentId, {
      signature: await signApproval(pending),
      deadline: pending.approval.message.deadline,
    });
    const paid = (await h.gateway.evidenceFor(file.record.intentId)) as EvidenceFile;

    const report = await verifyEvidence(paid, { chain: chainOf(paid), ledger: h.ledger.entries });
    expect(failedLabels(report)).toEqual([]);
    expect(report.checks.map((check) => check.label)).toEqual(
      expect.arrayContaining([
        'A payment that needed approval carries the approval',
        "Approval is signed by the mandate's approver, for this payee, amount and evidence hash",
        'Vault event names the approver and the approval nonce',
        'Ledger records the approval',
      ]),
    );
  });

  it('catches an approval swapped for one signed by the executor', async () => {
    const { file, pending } = await waiting();
    await h.gateway.approve(file.record.intentId, {
      signature: await signApproval(pending),
      deadline: pending.approval.message.deadline,
    });
    const paid = (await h.gateway.evidenceFor(file.record.intentId)) as EvidenceFile;
    const forged = structuredClone(paid);
    if (forged.approval === null) throw new Error('expected an approval');
    forged.approval.signature = await signApproval(pending, h.world.executorAccount);

    const report = await verifyEvidence(forged, { chain: chainOf(paid), ledger: h.ledger.entries });
    expect(failedLabels(report)).toEqual([
      "Approval is signed by the mandate's approver, for this payee, amount and evidence hash",
    ]);
  });

  it('catches an approval removed from a payment that needed one', async () => {
    const { file, pending } = await waiting();
    await h.gateway.approve(file.record.intentId, {
      signature: await signApproval(pending),
      deadline: pending.approval.message.deadline,
    });
    const paid = (await h.gateway.evidenceFor(file.record.intentId)) as EvidenceFile;
    const report = await verifyEvidence({ ...paid, approval: null }, { chain: chainOf(paid) });
    expect(failedLabels(report)).toContain('A payment that needed approval carries the approval');
  });

  it('verifies a declined request: signed by the approver, nothing paid', async () => {
    const { file, pending } = await waiting();
    await h.gateway.decline(file.record.intentId, { signature: await signDecline(pending) });
    const declined = (await h.gateway.evidenceFor(file.record.intentId)) as EvidenceFile;

    const report = await verifyEvidence(declined, {
      chain: chainOf(declined),
      ledger: h.ledger.entries,
    });
    expect(failedLabels(report)).toEqual([]);
    expect(report.checks.map((check) => check.label)).toEqual(
      expect.arrayContaining([
        "Decline is signed by the mandate's approver, for this request",
        'Vault has not paid anything on this evidence hash',
      ]),
    );
  });

  it('catches a decline that the approver did not sign', async () => {
    const { file, pending } = await waiting();
    await h.gateway.decline(file.record.intentId, { signature: await signDecline(pending) });
    const declined = (await h.gateway.evidenceFor(file.record.intentId)) as EvidenceFile;
    const forged = structuredClone(declined);
    if (forged.result.status !== 'declined') throw new Error('expected a declined record');
    forged.result.signature = await signDecline(pending, newAccount());

    const report = await verifyEvidence(forged, { chain: chainOf(declined) });
    expect(failedLabels(report)).toEqual([
      "Decline is signed by the mandate's approver, for this request",
    ]);
  });
});

describe('verify-evidence: per-call purchases', () => {
  async function bought(): Promise<EvidenceFile> {
    return decide({
      payee: h.world.merchant,
      amount: '100000',
      purpose: 'Market data: TSK-LOGI20 quote',
      invoiceId: '',
      context: { mpp: { resource: `${MERCHANT_ORIGIN}/v1/quotes/TSK-LOGI20` } },
    });
  }

  it('verifies the top-up from the vault and the settlement at the merchant', async () => {
    const file = await bought();
    const report = await verifyEvidence(file, { chain: chainOf(file), ledger: h.ledger.entries });

    expect(failedLabels(report)).toEqual([]);
    expect(report.checks.map((check) => check.label)).toEqual(
      expect.arrayContaining([
        'A per-call purchase names the spend wallet and says what happened at the merchant',
        "Merchant's settlement moved the same amount from the spend wallet to the merchant",
      ]),
    );
  });

  it.each<[string, (transfer: { from: Address; to: Address; value: bigint }) => void]>([
    ['went to another address', (transfer) => (transfer.to = newAddress())],
    ['came from another wallet', (transfer) => (transfer.from = newAddress())],
    ['moved a different amount', (transfer) => (transfer.value += 1n)],
  ])('catches a settlement that %s', async (_name, change) => {
    const file = await bought();
    for (const transfer of h.purchases!.settlements.values()) change(transfer);
    const report = await verifyEvidence(file, { chain: chainOf(file) });
    expect(failedLabels(report)).toEqual([
      "Merchant's settlement moved the same amount from the spend wallet to the merchant",
    ]);
  });

  it('catches a settlement transaction that does not exist', async () => {
    const file = await bought();
    h.purchases!.settlements.clear();
    const report = await verifyEvidence(file, { chain: chainOf(file) });
    expect(report.verified).toBe(false);
  });

  it('catches a purchase recorded as paid to the merchant directly', async () => {
    // The vault paid the spend wallet. A record that drops the purchase claims the vault paid the merchant.
    const file = await bought();
    const forged = structuredClone(file);
    forged.record.purchase = null;
    const report = await verifyEvidence(rehash(forged), { chain: chainOf(file) });
    expect(report.verified).toBe(false);
  });

  it('verifies a purchase that failed at the merchant, and shows that it did', async () => {
    h.purchases!.failWith = 'the merchant answered 503 to the signed payment';
    const file = await bought();
    const report = await verifyEvidence(file, { chain: chainOf(file), ledger: h.ledger.entries });
    expect(failedLabels(report)).toEqual([]);
    expect(
      report.checks.find((check) =>
        check.label.startsWith('A per-call purchase names the spend wallet'),
      )?.detail,
    ).toBe('failed');
  });
});
