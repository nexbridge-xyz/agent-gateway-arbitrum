import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signIntent } from '../../src/protocol/intent';
import { type Harness, createHarness } from '../fakes';
import { DOMAIN, NOW, USDC, makeIntent } from '../helpers';

/**
 * Review finding: when the payment behind a waiting approval could no longer be made (the vault was
 * paused, the mandate revoked, the vault short of funds), the gateway wrote APPROVAL_NOT_EXECUTED to
 * its hash-chained ledger before it had looked at the signature. Anybody who could reach the port
 * could add entries to the audit ledger with 65 bytes of nothing.
 */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

const BAD_SIGNATURE = `0x${'11'.repeat(64)}1b`;

describe('review: an approval nobody signed', () => {
  it('must not write to the ledger', async () => {
    // A real request that waits for the approver.
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.vendorB,
      amount: (6n * USDC).toString(),
    });
    const pending = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    expect(pending.status).toBe('pending_approval');

    // The principal pauses the vault. Now anybody posts 65 bytes of nothing as "the approval".
    h.world.paused = true;
    const before = h.ledger.entries.length;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        h.gateway.approve(pending.intentId, {
          signature: BAD_SIGNATURE,
          deadline: String(NOW + 600),
        }),
      ).rejects.toThrow();
    }

    // On main each of those calls appended an APPROVAL_NOT_EXECUTED entry to the hash-chained ledger,
    // before any signature was looked at.
    expect(h.ledger.entries.slice(before).map((entry) => entry.kind)).toEqual([]);
  });
});

describe('review: an approval the approver did sign', () => {
  it('is still written to the ledger when the payment can no longer be made (control)', async () => {
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.vendorB,
      amount: (6n * USDC).toString(),
    });
    const pending = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    const [waiting] = await h.gateway.pendingApprovals();
    if (waiting === undefined) throw new Error('nothing is waiting');
    const { message } = waiting.approval;
    const signature = await h.world.approverAccount.signTypedData({
      domain: waiting.approval.domain,
      types: {
        PaymentApproval: [
          { name: 'mandateId', type: 'uint256' },
          { name: 'payee', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'evidenceHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
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

    h.world.paused = true;
    const before = h.ledger.entries.length;
    await expect(
      h.gateway.approve(pending.intentId, { signature, deadline: message.deadline }),
    ).rejects.toThrow('The payment can no longer be made');
    expect(h.ledger.entries.slice(before).map((entry) => entry.kind)).toEqual([
      'APPROVAL_NOT_EXECUTED',
    ]);
    // The request still waits: the approver can sign again once the vault is open.
    expect((await h.gateway.evidenceFor(pending.intentId))?.result.status).toBe('pending_approval');
  });
});
