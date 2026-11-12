import type { Hex } from 'viem';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RequestError } from '../src/errors';
import type { PendingApproval } from '../src/gateway';
import { PAYMENT_APPROVAL_TYPES, APPROVAL_DECLINE_TYPES } from '../src/protocol/approval';
import { signIntent } from '../src/protocol/intent';
import { type Harness, createHarness } from './fakes';
import { DOMAIN, USDC, VAULT, makeIntent, newAccount } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

/** A 6 USDC invoice: above the 2 USDC per-payment cap, so it waits for the approver. */
async function waitingRequest(amount = 6n * USDC) {
  const intent = makeIntent({
    agentId: h.world.agentId.toString(),
    payee: h.world.vendorB,
    amount: amount.toString(),
    purpose: 'Invoice NR-2026-0042: quarterly research report',
    invoiceId: 'NR-2026-0042',
  });
  const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
  expect(outcome.status).toBe('pending_approval');
  return outcome;
}

/** Signs exactly what the gateway asks the approver to sign, as a wallet would. */
function sign(pending: PendingApproval, account = h.world.approverAccount) {
  return account.signTypedData({
    domain: pending.approval.domain,
    types: PAYMENT_APPROVAL_TYPES,
    primaryType: 'PaymentApproval',
    message: {
      mandateId: BigInt(pending.approval.message.mandateId),
      payee: pending.approval.message.payee,
      amount: BigInt(pending.approval.message.amount),
      evidenceHash: pending.approval.message.evidenceHash,
      nonce: BigInt(pending.approval.message.nonce),
      deadline: BigInt(pending.approval.message.deadline),
    },
  });
}

async function onlyPending(): Promise<PendingApproval> {
  const pending = await h.gateway.pendingApprovals();
  expect(pending).toHaveLength(1);
  return pending[0] as PendingApproval;
}

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RequestError) return error;
    throw error;
  }
  throw new Error('expected the gateway to refuse');
}

describe('approvals: what the approver is asked to sign', () => {
  it('lists the waiting payment with the vault, the amount and the evidence hash', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();

    expect(pending).toMatchObject({
      intentId: outcome.intentId,
      evidenceHash: outcome.evidenceHash,
      approver: h.world.approver,
      payee: h.world.vendorB,
      payeeName: 'Nagikumo Research',
      amount: '6000000',
      tokenSymbol: 'USDC',
      purpose: 'Invoice NR-2026-0042: quarterly research report',
      reasons: ['The amount is above the per-payment cap of 2 USDC'],
    });
    expect(pending.approval.domain).toEqual({
      name: 'MandateVault',
      version: '1',
      chainId: 421_614,
      verifyingContract: VAULT,
    });
    expect(pending.approval.message).toMatchObject({
      mandateId: '1',
      payee: h.world.vendorB,
      amount: '6000000',
      evidenceHash: outcome.evidenceHash,
      nonce: '0',
    });
    expect(BigInt(pending.approval.message.deadline)).toBeGreaterThan(BigInt(h.world.time));
  });

  it('lists nothing once a payment is paid, and nothing for paid or refused requests', async () => {
    await h.gateway.submit(
      await signIntent(
        h.world.agent,
        DOMAIN,
        makeIntent({ agentId: '354', payee: h.world.vendorA }),
      ),
    );
    expect(await h.gateway.pendingApprovals()).toEqual([]);

    const outcome = await waitingRequest();
    const pending = await onlyPending();
    await h.gateway.approve(outcome.intentId, {
      signature: await sign(pending),
      deadline: pending.approval.message.deadline,
    });
    expect(await h.gateway.pendingApprovals()).toEqual([]);
  });
});

describe('approvals: paying with the approver signature', () => {
  it('pays through payWithApproval and records the approval', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    const signature = await sign(pending);

    const paid = await h.gateway.approve(outcome.intentId, {
      signature,
      deadline: pending.approval.message.deadline,
    });

    expect(paid).toMatchObject({ decision: 'needs_approval', status: 'paid', error: null });
    expect(h.world.payments).toEqual([
      {
        mandateId: 1n,
        payee: h.world.vendorB,
        amount: 6n * USDC,
        evidenceHash: outcome.evidenceHash,
        deadline: BigInt(pending.approval.message.deadline),
        signature,
        event: 'ApprovedPayment',
      },
    ]);
    expect(h.world.approvalNonce).toBe(1n);

    const file = await h.gateway.evidenceFor(outcome.intentId);
    expect(file?.approval).toMatchObject({ approver: h.world.approver, nonce: '0', signature });
    expect(file?.result).toMatchObject({ status: 'paid', event: 'ApprovedPayment' });
    expect(file?.evidenceHash).toBe(outcome.evidenceHash);
    expect(h.ledger.entries.map((entry) => entry.kind)).toEqual([
      'INTENT_DECIDED',
      'APPROVAL_RECEIVED',
      'PAYMENT_EXECUTED',
    ]);
    expect(h.ledger.verify().ok).toBe(true);
  });

  it('counts the approved payment toward the day, so later requests see it', async () => {
    const outcome = await waitingRequest(7n * USDC);
    const pending = await onlyPending();
    await h.gateway.approve(outcome.intentId, {
      signature: await sign(pending),
      deadline: pending.approval.message.deadline,
    });

    // 7 approved + 2 would pass the 8 USDC daily cap.
    const next = await h.gateway.submit(
      await signIntent(
        h.world.agent,
        DOMAIN,
        makeIntent({ agentId: '354', payee: h.world.vendorA, amount: (2n * USDC).toString() }),
      ),
    );
    expect(next.decision).toBe('needs_approval');
    expect(next.reasons[0]).toContain('daily cap');
  });

  it('refuses a signature from anyone but the approver', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    const forged = await sign(pending, newAccount());

    const error = await failure(
      h.gateway.approve(outcome.intentId, {
        signature: forged,
        deadline: pending.approval.message.deadline,
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain("not the approver's signature");
    expect(h.world.payments).toHaveLength(0);
    expect((await h.gateway.evidenceFor(outcome.intentId))?.result.status).toBe('pending_approval');
  });

  it('refuses the executor approving its own payment', async () => {
    // The gateway holds the executor key. It must not be able to wave its own payments through.
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    const error = await failure(
      h.gateway.approve(outcome.intentId, {
        signature: await sign(pending, h.world.executorAccount),
        deadline: pending.approval.message.deadline,
      }),
    );
    expect(error.status).toBe(400);
    expect(h.world.payments).toHaveLength(0);
  });

  it('refuses a signature for a different amount, payee or deadline', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();

    for (const change of [
      { amount: '5000000' },
      { payee: h.world.vendorA },
      { deadline: '1' },
      { nonce: '7' },
    ]) {
      const altered = {
        ...pending,
        approval: { ...pending.approval, message: { ...pending.approval.message, ...change } },
      };
      const error = await failure(
        h.gateway.approve(outcome.intentId, {
          signature: await sign(altered),
          deadline: pending.approval.message.deadline,
        }),
      );
      expect(error.status).toBe(400);
    }
    expect(h.world.payments).toHaveLength(0);
  });

  it('refuses an approval whose deadline has passed', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    const signature = await sign(pending);
    h.world.time = Number(pending.approval.message.deadline) + 1;

    const error = await failure(
      h.gateway.approve(outcome.intentId, {
        signature,
        deadline: pending.approval.message.deadline,
      }),
    );
    expect(error).toMatchObject({ status: 400, message: 'The approval has expired' });
    expect(h.world.payments).toHaveLength(0);
  });

  it('cannot be used twice', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    const body = { signature: await sign(pending), deadline: pending.approval.message.deadline };
    await h.gateway.approve(outcome.intentId, body);

    const error = await failure(h.gateway.approve(outcome.intentId, body));
    expect(error).toMatchObject({ status: 409 });
    expect(error.message).toContain('it is paid');
    expect(h.world.payments).toHaveLength(1);
  });

  it('asks for a fresh signature after another approval used the nonce', async () => {
    const first = await waitingRequest(5n * USDC);
    const second = await waitingRequest(6n * USDC);
    const [a, b] = (await h.gateway.pendingApprovals()) as [PendingApproval, PendingApproval];
    const staleSignatureForSecond = await sign(b);

    await h.gateway.approve(first.intentId, {
      signature: await sign(a),
      deadline: a.approval.message.deadline,
    });
    const error = await failure(
      h.gateway.approve(second.intentId, {
        signature: staleSignatureForSecond,
        deadline: b.approval.message.deadline,
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('approval number 1');

    const refreshed = (await h.gateway.pendingApprovals())[0] as PendingApproval;
    expect(refreshed.approval.message.nonce).toBe('1');
    const paid = await h.gateway.approve(second.intentId, {
      signature: await sign(refreshed),
      deadline: refreshed.approval.message.deadline,
    });
    expect(paid.status).toBe('paid');
  });

  it('does not pay if the mandate was revoked while the request waited', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    h.world.mandate!.revoked = true;

    const error = await failure(
      h.gateway.approve(outcome.intentId, {
        signature: await sign(pending),
        deadline: pending.approval.message.deadline,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.reasons).toEqual(['Mandate 1 has been revoked']);
    expect(h.world.payments).toHaveLength(0);
    expect(h.ledger.entries.at(-1)?.kind).toBe('APPROVAL_NOT_EXECUTED');
  });

  it('does not pay a payee that was put on the denylist while the request waited', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    h.payees.denylist.push({
      address: h.world.vendorB,
      reason: 'bank details changed, under review',
    });

    const error = await failure(
      h.gateway.approve(outcome.intentId, {
        signature: await sign(pending),
        deadline: pending.approval.message.deadline,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.reasons[0]).toContain('bank details changed');
    expect(h.world.payments).toHaveLength(0);
  });

  it('does not pay past the hard ceiling for the day', async () => {
    const outcome = await waitingRequest(6n * USDC);
    const pending = await onlyPending();
    h.world.spentToday = 15n * USDC; // other payments happened while this one waited

    const error = await failure(
      h.gateway.approve(outcome.intentId, {
        signature: await sign(pending),
        deadline: pending.approval.message.deadline,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.reasons[0]).toContain('hard ceiling');
  });

  it('records a failed payment when the vault refuses after all', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    h.world.beforePayment = () => {
      h.world.paused = true;
    };

    const result = await h.gateway.approve(outcome.intentId, {
      signature: await sign(pending),
      deadline: pending.approval.message.deadline,
    });
    expect(result).toMatchObject({ status: 'failed', error: 'the vault refused: EnforcedPause()' });
    expect(h.ledger.entries.map((entry) => entry.kind)).toEqual([
      'INTENT_DECIDED',
      'APPROVAL_RECEIVED',
      'PAYMENT_FAILED',
    ]);
  });

  it('answers 404 for an unknown intent and rejects a malformed body', async () => {
    const unknown: Hex = `0x${'00'.repeat(32)}`;
    const error = await failure(
      h.gateway.approve(unknown, { signature: `0x${'11'.repeat(65)}`, deadline: '1900000000' }),
    );
    expect(error.status).toBe(404);

    const outcome = await waitingRequest();
    await expect(
      h.gateway.approve(outcome.intentId, { signature: '0x12', deadline: 'soon' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      h.gateway.approve(outcome.intentId, { signature: `0x${'11'.repeat(65)}` }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe('approvals: declining', () => {
  function signDecline(pending: PendingApproval, account = h.world.approverAccount) {
    return account.signTypedData({
      domain: pending.decline.domain,
      types: APPROVAL_DECLINE_TYPES,
      primaryType: 'ApprovalDecline',
      message: pending.decline.message,
    });
  }

  it('records the approver saying no, and nothing is paid', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();

    const declined = await h.gateway.decline(outcome.intentId, {
      signature: await signDecline(pending),
    });
    expect(declined).toMatchObject({ status: 'declined', transactionHash: null });
    expect(h.world.payments).toHaveLength(0);
    expect(await h.gateway.pendingApprovals()).toEqual([]);
    expect((await h.gateway.evidenceFor(outcome.intentId))?.result).toMatchObject({
      status: 'declined',
      approver: h.world.approver,
    });
    expect(h.ledger.entries.at(-1)?.kind).toBe('APPROVAL_DECLINED');
  });

  it('cannot be approved after it was declined', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    await h.gateway.decline(outcome.intentId, { signature: await signDecline(pending) });

    const error = await failure(
      h.gateway.approve(outcome.intentId, {
        signature: await sign(pending),
        deadline: pending.approval.message.deadline,
      }),
    );
    expect(error.status).toBe(409);
    expect(h.world.payments).toHaveLength(0);
  });

  it('refuses a decline that is not signed by the approver', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    const error = await failure(
      h.gateway.decline(outcome.intentId, { signature: await signDecline(pending, newAccount()) }),
    );
    expect(error.status).toBe(400);
    expect((await h.gateway.evidenceFor(outcome.intentId))?.result.status).toBe('pending_approval');
  });

  it('does not accept an approval signature as a decline', async () => {
    const outcome = await waitingRequest();
    const pending = await onlyPending();
    const error = await failure(
      h.gateway.decline(outcome.intentId, { signature: await sign(pending) }),
    );
    expect(error.status).toBe(400);
  });
});
