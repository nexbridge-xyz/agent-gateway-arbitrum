import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type MandateCandidate, chooseMandate } from '../src/chain/mandates';
import type { PendingApproval } from '../src/gateway';
import { PAYMENT_APPROVAL_TYPES } from '../src/protocol/approval';
import { signIntent } from '../src/protocol/intent';
import { type Harness, MERCHANT_ORIGIN, createHarness } from './fakes';
import { DOMAIN, NOW, USDC, makeIntent, newAddress } from './helpers';

describe('which mandate a request falls under', () => {
  const executor = newAddress();
  const spendWallet = newAddress();
  const vendor = newAddress();
  const stranger = newAddress();

  const mandate = (
    id: bigint,
    payees: Address[],
    changes: Partial<MandateCandidate> = {},
  ): MandateCandidate => ({
    id,
    executor,
    revoked: false,
    validUntil: NOW + 86_400,
    hardCeiling: 20n * USDC,
    payees,
    ...changes,
  });
  // Newest first, as the reader lists them.
  const vendors = mandate(3n, [vendor]);
  const spend = mandate(4n, [spendWallet], { hardCeiling: USDC });
  const choose = (candidates: MandateCandidate[], payee: Address, mandateId?: bigint) =>
    chooseMandate(candidates, { payee, executor, now: NOW, mandateId })?.id ?? null;

  it('uses the mandate that lists the payee', () => {
    expect(choose([spend, vendors], vendor)).toBe(3n);
    expect(choose([spend, vendors], spendWallet)).toBe(4n);
  });

  it('compares addresses, not their spelling', () => {
    expect(choose([spend, vendors], vendor.toLowerCase() as Address)).toBe(3n);
  });

  it('uses the mandate with the highest hard ceiling for a payee on no list', () => {
    // Whatever the order they were created in.
    expect(choose([spend, vendors], stranger)).toBe(3n);
    expect(
      choose([mandate(4n, [vendor]), mandate(3n, [spendWallet], { hardCeiling: USDC })], stranger),
    ).toBe(4n);
  });

  it('takes the newest when two mandates list the payee, or are equally wide', () => {
    expect(choose([mandate(5n, [vendor]), mandate(3n, [vendor])], vendor)).toBe(5n);
    expect(choose([mandate(5n, []), mandate(3n, [])], stranger)).toBe(5n);
  });

  it('never moves a spend wallet top-up onto the vendor mandate', () => {
    // The spend wallet is on no live list: the choice falls on the widest mandate, where the allowlist
    // check then fails. It must not be reported as allowed.
    const revokedSpend = { ...spend, revoked: true };
    const chosen = chooseMandate([revokedSpend, vendors], {
      payee: spendWallet,
      executor,
      now: NOW,
    });
    expect(chosen?.id).toBe(3n);
    expect(chosen?.payees).not.toContain(spendWallet);
  });

  it('prefers a live mandate to a revoked or expired one that lists the payee', () => {
    expect(choose([mandate(5n, [vendor], { revoked: true }), mandate(3n, [vendor])], vendor)).toBe(
      3n,
    );
    expect(
      choose([mandate(5n, [vendor], { validUntil: NOW - 1 }), mandate(3n, [vendor])], vendor),
    ).toBe(3n);
    // Valid through its last second.
    expect(
      choose([mandate(5n, [vendor], { validUntil: NOW }), mandate(3n, [vendor])], vendor),
    ).toBe(5n);
  });

  it('explains with the dead mandate that listed the payee when none is live', () => {
    const dead = [
      { ...spend, revoked: true },
      { ...vendors, revoked: true },
    ];
    expect(choose(dead, vendor)).toBe(3n);
    expect(choose(dead, spendWallet)).toBe(4n);
    expect(choose(dead, stranger)).toBe(3n);
  });

  it("ignores another gateway's mandates while it has its own", () => {
    const theirs = mandate(9n, [vendor], { executor: newAddress() });
    expect(choose([theirs, spend, vendors], vendor)).toBe(3n);
  });

  it('returns the newest mandate of another gateway if that is all the agent has, and null if it has none', () => {
    const theirs = mandate(9n, [vendor], { executor: newAddress() });
    expect(choose([theirs], vendor)).toBe(9n);
    expect(choose([], vendor)).toBeNull();
  });

  it('keeps to a named mandate when a waiting request is looked at again', () => {
    const newer = mandate(7n, [stranger]);
    expect(choose([newer, spend, vendors], stranger, 3n)).toBe(3n);
    expect(choose([newer, spend, vendors], stranger, 8n)).toBeNull();
  });
});

describe('gateway: an agent with a vendor mandate and a spend wallet mandate', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.world.splitMandates();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  const submit = async (overrides: Parameters<typeof makeIntent>[0]) =>
    h.gateway.submit(
      await signIntent(
        h.world.agent,
        DOMAIN,
        makeIntent({ agentId: h.world.agentId.toString(), ...overrides }),
      ),
    );
  const purchase = (amount = '100000') =>
    submit({
      payee: h.world.merchant,
      amount,
      purpose: 'Market data: one TSK-LOGI20 quote',
      invoiceId: '',
      context: { mpp: { resource: `${MERCHANT_ORIGIN}/v1/quotes/TSK-LOGI20` } },
    });
  const mandateOf = async (intentId: `0x${string}`) =>
    (await h.gateway.evidenceFor(intentId))?.record.who.mandateId;

  it('funds a purchase from the spend wallet mandate, and pays a vendor from the vendor mandate', async () => {
    const bought = await purchase();
    const paid = await submit({ payee: h.world.vendorA, amount: (2n * USDC).toString() });

    expect(bought).toMatchObject({ decision: 'auto', status: 'paid' });
    expect(paid).toMatchObject({ decision: 'auto', status: 'paid' });
    expect(
      h.world.payments.map((payment) => [payment.mandateId, payment.payee, payment.amount]),
    ).toEqual([
      [2n, h.world.spendWallet, 100_000n],
      [1n, h.world.vendorA, 2n * USDC],
    ]);
    expect(await mandateOf(bought.intentId)).toBe('2');
    expect(await mandateOf(paid.intentId)).toBe('1');
    // Each mandate counts its own day.
    expect(h.world.spendMandate?.spentToday).toBe(100_000n);
    expect(h.world.mandate?.spentToday).toBe(2n * USDC);
  });

  it('holds purchases to the spend wallet mandate: 1 USDC a day, whatever the vendor mandate has left', async () => {
    h.world.spendMandate!.spentToday = 950_000n;
    const first = await purchase('50000');
    const second = await purchase('50000');

    expect(first.status).toBe('paid');
    expect(second.decision).toBe('refused');
    // The small mandate's daily cap and its ceiling are the same 1 USDC, so both say no.
    expect(second.reasons).toEqual([
      "The payment would take today's total above the mandate's hard ceiling of 1 USDC",
      "The payment would take today's total above the daily cap of 1 USDC",
    ]);
    expect(h.world.mandate?.spentToday).toBe(0n);
    expect(h.world.payments).toHaveLength(1);
  });

  it('refuses a purchase when no live mandate lists the spend wallet', async () => {
    h.world.spendMandate!.revoked = true;
    const outcome = await purchase();
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons).toEqual([
      "The gateway's spend wallet is not on this mandate's allowlist",
    ]);
    expect(h.purchases?.calls).toHaveLength(0);
    expect(h.world.payments).toHaveLength(0);
  });

  it('cannot fund the spend wallet as if it were a vendor', async () => {
    // A direct payment to the spend wallet. It is on the small mandate only, so the small caps would
    // apply; and the gateway refuses to fund its own wallet without a purchase, whatever the amount.
    const outcome = await submit({ payee: h.world.spendWallet, amount: (2n * USDC).toString() });
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons.join(' ')).toContain("one of this gateway's own wallets");
    expect(outcome.reasons.join(' ')).toContain('hard ceiling of 1 USDC');
    expect(h.world.payments).toHaveLength(0);
  });

  it('decides a payee on no list under the vendor mandate, where an approval has room', async () => {
    const waiting = await submit({ payee: h.world.unlistedVendor, amount: (6n * USDC).toString() });
    expect(waiting).toMatchObject({ decision: 'needs_approval', status: 'pending_approval' });
    expect(await mandateOf(waiting.intentId)).toBe('1');

    const unknown = await submit({ payee: newAddress(), amount: (4n * USDC).toString() });
    expect(unknown.decision).toBe('refused');
    expect(unknown.reasons).toEqual(["The payee is not in the principal's vendor registry"]);
    expect(await mandateOf(unknown.intentId)).toBe('1');
  });

  it('pays an approved request under the mandate it was decided under, even if a newer mandate lists the payee', async () => {
    const waiting = await submit({ payee: h.world.unlistedVendor, amount: (6n * USDC).toString() });
    const pending = (await h.gateway.pendingApprovals())[0] as PendingApproval;
    expect(pending.approval.message.mandateId).toBe('1');

    // The principal adds the vendor to the small mandate's successor in the meantime.
    h.world.spendMandate!.payees.add(h.world.unlistedVendor);

    const { message } = pending.approval;
    const signature = await h.world.approverAccount.signTypedData({
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
    const paid = await h.gateway.approve(waiting.intentId, {
      signature,
      deadline: message.deadline,
    });

    expect(paid.status).toBe('paid');
    expect(h.world.payments.at(-1)).toMatchObject({ mandateId: 1n, event: 'ApprovedPayment' });
    expect(h.world.mandate?.approvalNonce).toBe(1n);
    expect(h.world.spendMandate?.approvalNonce).toBe(0n);
  });

  it('refuses everything once both mandates are revoked, naming the mandate that covered the payee', async () => {
    h.world.mandate!.revoked = true;
    h.world.spendMandate!.revoked = true;

    expect((await submit({ payee: h.world.vendorA })).reasons).toEqual([
      'Mandate 1 has been revoked',
    ]);
    expect((await purchase()).reasons).toEqual(['Mandate 2 has been revoked']);
    expect(h.world.payments).toHaveLength(0);
  });
});
