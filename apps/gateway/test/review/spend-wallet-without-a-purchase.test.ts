import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signIntent } from '../../src/protocol/intent';
import { type Harness, MERCHANT_ORIGIN, createHarness } from '../fakes';
import { DOMAIN, makeIntent } from '../helpers';

/**
 * Review finding: the documents say the spend wallet "is funded for one call at a time, with exactly
 * the price of that call", and that it therefore "holds no balance to lose between calls".
 *
 * The spend wallet is in the principal's vendor registry (the console needs it there to offer it for
 * a mandate) and on its own mandate's allowlist. So a plain payment request that names the spend
 * wallet as payee passes every check: the vault funds the spend wallet, and no call is made. An agent
 * that has been talked into it can move the spend mandate's whole daily cap out of the vault and into
 * a wallet whose key the gateway holds, where it waits for whoever takes the gateway.
 */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  // The demo's shape: the spend wallet has a small mandate of its own.
  h.world.splitMandates();
});

afterEach(async () => {
  await h.cleanup();
});

describe('review: funding the spend wallet without buying anything', () => {
  it('a plain payment to the spend wallet must be refused', async () => {
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.spendWallet,
      amount: '500000',
      purpose: 'Top up for later',
      invoiceId: '',
    });
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));

    // On main: auto, paid. 0.50 USDC left the vault for the spend wallet and nothing was bought.
    expect(outcome.decision).toBe('refused');
    expect(h.world.payments).toEqual([]);
    expect(h.purchases?.calls).toEqual([]);
  });

  it('a payment to the spend wallet above its cap must not be put to the approver either', async () => {
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.spendWallet,
      amount: '900000',
      purpose: 'Top up for later',
      invoiceId: '',
    });
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    expect(outcome.decision).toBe('refused');
    expect(await h.gateway.pendingApprovals()).toEqual([]);
  });

  it('a purchase still funds it with the price of the call (control)', async () => {
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.merchant,
      amount: '100000',
      purpose: 'Market data: one TSK-LOGI20 quote',
      invoiceId: '',
      context: { mpp: { resource: `${MERCHANT_ORIGIN}/v1/quotes/TSK-LOGI20` } },
    });
    const outcome = await h.gateway.submit(await signIntent(h.world.agent, DOMAIN, intent));
    expect(outcome.status).toBe('paid');
    expect(h.world.payments).toHaveLength(1);
    expect(h.world.payments[0]).toMatchObject({ payee: h.world.spendWallet, amount: 100_000n });
    expect(h.purchases?.calls).toHaveLength(1);
  });
});
