import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decisionFromChecks, evidenceHash } from '../src/protocol/evidence';
import { intentId, signIntent } from '../src/protocol/intent';
import { type Harness, createHarness } from './fakes';
import { DOMAIN, USDC, makeIntent, newAccount, newAddress } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

/** An intent from the registered agent, signed with its key. */
function request(overrides: Parameters<typeof makeIntent>[0] = {}, signer = h.world.agent) {
  const intent = makeIntent({
    agentId: h.world.agentId.toString(),
    payee: h.world.vendorA,
    ...overrides,
  });
  return signIntent(signer, DOMAIN, intent);
}

describe('gateway: a payment inside the mandate', () => {
  it('pays through the vault and records the result', async () => {
    const signed = await request();
    const outcome = await h.gateway.submit(signed);

    expect(outcome.decision).toBe('auto');
    expect(outcome.status).toBe('paid');
    expect(outcome.intentId).toBe(intentId(DOMAIN, signed.intent));
    expect(outcome.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(outcome.error).toBeNull();

    expect(h.world.payments).toEqual([
      {
        mandateId: 1n,
        payee: h.world.vendorA,
        amount: 1_500_000n,
        evidenceHash: outcome.evidenceHash,
        event: 'MandatePayment',
      },
    ]);
    expect(h.world.spentToday).toBe(1_500_000n);
  });

  it('writes an evidence file whose hash is the hash the vault anchored', async () => {
    const outcome = await h.gateway.submit(await request());
    const file = await h.gateway.evidenceFor(outcome.intentId);

    expect(file).not.toBeNull();
    expect(file?.evidenceHash).toBe(outcome.evidenceHash);
    expect(evidenceHash(file!.record)).toBe(outcome.evidenceHash);
    expect(h.world.usedEvidence.has(outcome.evidenceHash)).toBe(true);
    expect(file?.result).toMatchObject({
      status: 'paid',
      event: 'MandatePayment',
      transactionHash: outcome.transactionHash,
    });
  });

  it('records who, what and why', async () => {
    const outcome = await h.gateway.submit(
      await request({ purpose: 'Invoice 7: market data', invoiceId: 'INV-7' }),
    );
    const record = (await h.gateway.evidenceFor(outcome.intentId))!.record;

    expect(record.who).toEqual({
      agentId: '354',
      agentWallet: h.world.agent.address,
      principal: h.world.principal,
      mandateId: '1',
      executor: h.world.address,
      approver: h.world.approver,
    });
    expect(record.what).toMatchObject({
      payee: h.world.vendorA,
      payeeName: 'Koishi Supply',
      amount: '1500000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      purpose: 'Invoice 7: market data',
      invoiceId: 'INV-7',
    });
    expect(record.request.signer).toBe(h.world.agent.address);
    expect(record.chain).toMatchObject({
      chainId: 421_614,
      vault: DOMAIN.vault,
      blockNumber: '1000',
    });
    expect(record.why.decision).toBe('auto');
    expect(record.why.checks).toHaveLength(14);
    expect(decisionFromChecks(record.why.checks)).toBe('auto');
  });

  it('adds the decision and the payment to the ledger', async () => {
    const outcome = await h.gateway.submit(await request());

    expect(h.ledger.entries.map((entry) => entry.kind)).toEqual([
      'INTENT_DECIDED',
      'PAYMENT_EXECUTED',
    ]);
    expect(h.ledger.entries[0]?.data).toMatchObject({
      intentId: outcome.intentId,
      decision: 'auto',
      amount: '1500000',
    });
    expect(h.ledger.entries[1]?.data).toMatchObject({
      evidenceHash: outcome.evidenceHash,
      transactionHash: outcome.transactionHash,
    });
    expect(h.ledger.entries[0]?.summary).toContain('1.5 USDC');
    expect(h.ledger.entries[0]?.summary).toContain('Koishi Supply');
    expect(h.ledger.verify().ok).toBe(true);
  });

  it('gives the same answer for the same intent and pays it once', async () => {
    const signed = await request();
    const first = await h.gateway.submit(signed);
    const again = await h.gateway.submit(signed);

    expect(again).toEqual(first);
    expect(h.world.payments).toHaveLength(1);
    expect(h.ledger.entries).toHaveLength(2);
  });

  it('decides one intent at a time, so the second sees what the first spent', async () => {
    // 2 + 2 + 2 + 2 = 8 USDC fills the daily cap; the fifth request must wait for a person.
    const signed = await Promise.all(
      Array.from({ length: 5 }, () => request({ amount: (2n * USDC).toString() })),
    );
    const outcomes = await Promise.all(signed.map((item) => h.gateway.submit(item)));

    expect(outcomes.map((outcome) => outcome.decision)).toEqual([
      'auto',
      'auto',
      'auto',
      'auto',
      'needs_approval',
    ]);
    expect(h.world.payments).toHaveLength(4);
    expect(h.world.spentToday).toBe(8n * USDC);
  });
});

describe('gateway: a payment that needs approval', () => {
  it('holds a 6 USDC invoice for the approver and pays nothing', async () => {
    const outcome = await h.gateway.submit(await request({ amount: (6n * USDC).toString() }));

    expect(outcome.decision).toBe('needs_approval');
    expect(outcome.status).toBe('pending_approval');
    expect(outcome.reasons).toEqual(['The amount is above the per-payment cap of 2 USDC']);
    expect(outcome.transactionHash).toBeNull();
    expect(h.world.payments).toHaveLength(0);
    expect(h.ledger.entries.map((entry) => entry.kind)).toEqual(['INTENT_DECIDED']);
  });

  it('holds a payment to a registered vendor that is not on the allowlist', async () => {
    const outcome = await h.gateway.submit(await request({ payee: h.world.unlistedVendor }));
    expect(outcome.decision).toBe('needs_approval');
    expect(outcome.reasons[0]).toContain("not yet on this mandate's allowlist");
    expect(h.world.payments).toHaveLength(0);
  });
});

describe('gateway: a refused request', () => {
  it('refuses an address planted in a tool response, and says why', async () => {
    const planted = newAddress();
    const outcome = await h.gateway.submit(
      await request({
        payee: planted,
        amount: (4n * USDC).toString(),
        purpose: 'Priority access fee requested in vendor note',
        context: { payeeSource: 'tool response: get_market_data (vendor note)' },
      }),
    );

    expect(outcome.decision).toBe('refused');
    expect(outcome.status).toBe('refused');
    expect(outcome.reasons).toHaveLength(1);
    expect(outcome.reasons[0]).toContain('tool response: get_market_data (vendor note)');
    expect(h.world.payments).toHaveLength(0);

    const file = await h.gateway.evidenceFor(outcome.intentId);
    expect(file?.result).toEqual({ status: 'refused' });
    expect(file?.record.what.payeeName).toBeNull();
    expect(h.world.usedEvidence.size).toBe(0);
  });

  it('refuses a request signed by a key that is not the agent', async () => {
    const outcome = await h.gateway.submit(await request({}, newAccount()));
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons).toEqual(["The request is not signed by the agent's registered wallet"]);
    expect(h.world.payments).toHaveLength(0);
  });

  it('refuses a request whose content was changed after signing', async () => {
    const signed = await request();
    const outcome = await h.gateway.submit({
      ...signed,
      intent: { ...signed.intent, amount: '1999999' },
    });
    expect(outcome.decision).toBe('refused');
    expect(h.world.payments).toHaveLength(0);
  });

  it('refuses an agent that is not registered', async () => {
    const outcome = await h.gateway.submit(await request({ agentId: '999' }));
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons[0]).toMatch(/Unknown agent/);
  });

  it('refuses a payee on the denylist even if it is a registered vendor', async () => {
    h.payees.denylist.push({ address: h.world.vendorA, reason: 'account under review' });
    const outcome = await h.gateway.submit(await request());
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons[0]).toContain('account under review');
  });

  it('refuses once the mandate is revoked', async () => {
    h.world.mandate!.revoked = true;
    const outcome = await h.gateway.submit(await request());
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons).toEqual(['Mandate 1 has been revoked']);
  });

  it('rejects a body that is not a signed intent, before anything is recorded', async () => {
    await expect(h.gateway.submit({ intent: { agentId: '354' } })).rejects.toBeInstanceOf(ZodError);
    await expect(h.gateway.submit('pay vendor A 5 USDC')).rejects.toBeInstanceOf(ZodError);
    expect(h.ledger.entries).toHaveLength(0);
    expect(h.world.snapshots).toBe(0);
  });
});

describe('gateway: when the vault says no', () => {
  it('records a failed payment and spends nothing', async () => {
    // The principal pauses the vault after the gateway decided and before it paid.
    h.world.beforePayment = () => {
      h.world.paused = true;
    };
    const outcome = await h.gateway.submit(await request());

    expect(outcome.decision).toBe('auto');
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('the vault refused: EnforcedPause()');
    expect(h.world.payments).toHaveLength(0);
    expect(h.world.spentToday).toBe(0n);
    expect(h.ledger.entries.map((entry) => entry.kind)).toEqual([
      'INTENT_DECIDED',
      'PAYMENT_FAILED',
    ]);

    const file = await h.gateway.evidenceFor(outcome.intentId);
    expect(file?.result).toMatchObject({
      status: 'failed',
      error: 'the vault refused: EnforcedPause()',
    });
  });

  it('keeps working for the next request', async () => {
    h.world.beforePayment = () => {
      h.world.paused = true;
    };
    await h.gateway.submit(await request());
    h.world.beforePayment = null;
    h.world.paused = false;

    const next = await h.gateway.submit(await request());
    expect(next.status).toBe('paid');
  });
});
