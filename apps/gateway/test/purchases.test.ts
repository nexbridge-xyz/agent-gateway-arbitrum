import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PurchaseError, challengeProblem, createPurchaseClient } from '../src/chain/purchases';
import { evidenceHash } from '../src/protocol/evidence';
import { signIntent } from '../src/protocol/intent';
import { type Harness, MERCHANT_ORIGIN, createHarness } from './fakes';
import { DOMAIN, USDC, makeIntent, newAddress } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

const RESOURCE = `${MERCHANT_ORIGIN}/v1/quotes/TSK-LOGI20`;

/** The agent asks the gateway to buy one API call from the merchant for 0.10 USDC. */
function purchase(overrides: Parameters<typeof makeIntent>[0] = {}) {
  return signIntent(
    h.world.agent,
    DOMAIN,
    makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.merchant,
      amount: '100000',
      purpose: 'Market data: TSK-LOGI20 quote',
      invoiceId: '',
      context: {
        mpp: { resource: RESOURCE },
        payeeSource: `payment challenge from ${MERCHANT_ORIGIN}`,
      },
      ...overrides,
    }),
  );
}

describe('purchases: buying one API call', () => {
  it('tops up the spend wallet from the vault, pays the merchant and returns the data', async () => {
    const outcome = await h.gateway.submit(await purchase());

    expect(outcome).toMatchObject({ decision: 'auto', status: 'paid', error: null });
    expect(outcome.data).toEqual({ symbol: 'TSK-LOGI20', price: 1234.5, vendor_note: null });
    expect(outcome.purchase).toMatchObject({ status: 'settled' });

    // The vault paid the spend wallet, not the merchant, and exactly the price.
    expect(h.world.payments).toEqual([
      {
        mandateId: 1n,
        payee: h.world.spendWallet,
        amount: 100_000n,
        evidenceHash: outcome.evidenceHash,
        event: 'MandatePayment',
      },
    ]);
    // The spend wallet was then told to pay exactly this merchant, token and amount.
    expect(h.purchases?.calls).toEqual([
      {
        resource: RESOURCE,
        merchant: h.world.merchant,
        amount: 100_000n,
        token: getAddress('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'),
        chainId: 421_614,
      },
    ]);
  });

  it('records the merchant, the spend wallet and the settlement in the evidence', async () => {
    const outcome = await h.gateway.submit(await purchase());
    const file = (await h.gateway.evidenceFor(outcome.intentId))!;

    expect(file.record.what).toMatchObject({
      payee: h.world.merchant,
      payeeName: 'Tsukimi Data',
      amount: '100000',
    });
    expect(file.record.purchase).toEqual({
      protocol: 'mpp',
      resource: RESOURCE,
      spendWallet: h.world.spendWallet,
    });
    expect(evidenceHash(file.record)).toBe(outcome.evidenceHash);
    expect(file.result).toMatchObject({
      status: 'paid',
      event: 'MandatePayment',
      purchase: {
        status: 'settled',
        settlementTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) as string,
      },
    });
    // The data itself is not kept, only its hash.
    expect(JSON.stringify(file)).not.toContain('1234.5');
    expect(h.ledger.entries.map((entry) => entry.kind)).toEqual([
      'INTENT_DECIDED',
      'PAYMENT_EXECUTED',
      'PURCHASE_SETTLED',
    ]);
    expect(file.record.why.checks.map((check) => check.key)).toEqual(
      expect.arrayContaining([
        'purchase_spend_wallet',
        'purchase_origin_registered',
        'purchase_within_call_cap',
      ]),
    );
    expect(file.record.why.checks.every((check) => check.kind === 'hard')).toBe(true);
  });

  it('counts purchases toward the daily cap like any other payment', async () => {
    await h.gateway.submit(await purchase());
    expect(h.world.spentToday).toBe(100_000n);
  });

  it('says so when the merchant fails after the top-up', async () => {
    h.purchases!.failWith = 'the merchant answered 503 to the signed payment';
    const outcome = await h.gateway.submit(await purchase());

    expect(outcome.status).toBe('paid');
    expect(outcome.purchase).toEqual({
      status: 'failed',
      error: 'the merchant answered 503 to the signed payment',
    });
    expect(outcome.data).toBeUndefined();
    expect(h.ledger.entries.map((entry) => entry.kind)).toEqual([
      'INTENT_DECIDED',
      'PAYMENT_EXECUTED',
      'PURCHASE_FAILED',
    ]);
  });
});

describe('purchases: refused', () => {
  it.each<[string, Parameters<typeof makeIntent>[0], RegExp]>([
    [
      'a resource on another host than the registered one',
      { context: { mpp: { resource: 'https://evil.example/v1/quotes/TSK-LOGI20' } } },
      /not on the API address the principal registered/,
    ],
    [
      'a resource on an internal address',
      { context: { mpp: { resource: 'http://169.254.169.254/latest/meta-data/' } } },
      /not on the API address the principal registered/,
    ],
    [
      'a resource that is not a web address',
      { context: { mpp: { resource: 'file:///etc/passwd' } } },
      /not on the API address the principal registered/,
    ],
    ['a price above the per-call cap', { amount: '500001' }, /above the per-call cap of 0.5 USDC/],
    [
      'a price above the per-payment cap',
      { amount: (2n * USDC + 1n).toString() },
      /per-call cap|per-payment cap/,
    ],
  ])('refuses %s and never contacts it', async (_name, overrides, reason) => {
    const outcome = await h.gateway.submit(await purchase(overrides));
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons.join(' | ')).toMatch(reason);
    expect(h.purchases?.calls).toHaveLength(0);
    expect(h.world.payments).toHaveLength(0);
  });

  it('refuses a merchant that is not in the vendor registry', async () => {
    const outcome = await h.gateway.submit(await purchase({ payee: newAddress() }));
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons.join(' | ')).toContain('vendor registry');
    expect(h.purchases?.calls).toHaveLength(0);
  });

  it('refuses a registered vendor that has no registered API', async () => {
    const outcome = await h.gateway.submit(await purchase({ payee: h.world.vendorA }));
    expect(outcome.decision).toBe('refused');
    expect(h.purchases?.calls).toHaveLength(0);
  });

  it('refuses instead of waiting for approval when the day is used up', async () => {
    h.world.spentToday = 8n * USDC;
    const outcome = await h.gateway.submit(await purchase());
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons[0]).toContain('daily cap');
    expect(await h.gateway.pendingApprovals()).toEqual([]);
  });

  it('refuses when the spend wallet is not on the mandate allowlist', async () => {
    h.world.mandate!.payees.delete(h.world.spendWallet);
    const outcome = await h.gateway.submit(await purchase());
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons[0]).toContain("spend wallet is not on this mandate's allowlist");
  });

  it('refuses every purchase when the gateway has no spend wallet', async () => {
    await h.cleanup();
    h = await createHarness({ spendWallet: false });
    const outcome = await h.gateway.submit(await purchase());
    expect(outcome.decision).toBe('refused');
    expect(outcome.reasons.join(' | ')).toContain('no spend wallet');
    expect(h.world.payments).toHaveLength(0);
  });
});

describe('purchases: the merchant challenge is checked before the spend wallet signs', () => {
  const token = getAddress('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d');
  const merchant = newAddress();
  const expected = { merchant, amount: 100_000n, token, chainId: 421_614 };
  const honest = () => ({
    method: 'arbitrum',
    intent: 'charge',
    request: {
      amount: '100000',
      currency: token.toLowerCase(),
      recipient: merchant,
      methodDetails: { chainId: 421_614, decimals: 6, credentialTypes: ['authorization'] },
    } as Record<string, unknown>,
  });

  it('accepts a challenge for exactly the approved token, amount and merchant', () => {
    expect(challengeProblem(honest(), expected)).toBeNull();
  });

  it.each<[string, (challenge: ReturnType<typeof honest>) => void, RegExp]>([
    ['a higher amount', (c) => (c.request.amount = '100001'), /not the approved/],
    ['a lower amount', (c) => (c.request.amount = '99999'), /not the approved/],
    [
      'another recipient',
      (c) => (c.request.recipient = newAddress()),
      /not the registered merchant/,
    ],
    ['another token', (c) => (c.request.currency = newAddress()), /different token/],
    [
      'another chain',
      (c) => (c.request.methodDetails = { chainId: 42_161, credentialTypes: ['authorization'] }),
      /chain 42161/,
    ],
    [
      'Permit2 instead of an authorization',
      (c) => (c.request.methodDetails = { chainId: 421_614, credentialTypes: ['permit2'] }),
      /EIP-3009/,
    ],
    [
      'no credential type at all',
      (c) => (c.request.methodDetails = { chainId: 421_614 }),
      /EIP-3009/,
    ],
    [
      'a split to a second recipient',
      (c) =>
        (c.request.methodDetails = {
          chainId: 421_614,
          credentialTypes: ['authorization'],
          splits: [{ recipient: newAddress(), amount: '50000' }],
        }),
      /splits/,
    ],
    ['another payment method', (c) => (c.method = 'tempo'), /not an Arbitrum charge/],
  ])('rejects %s', (_name, change, reason) => {
    const challenge = honest();
    change(challenge);
    expect(challengeProblem(challenge, expected)).toMatch(reason);
  });
});

describe('purchases: the spend wallet client against a server that misbehaves', () => {
  const token = getAddress('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d');
  const spendWallet = privateKeyToAccount(generatePrivateKey());
  // An RPC address nothing listens on: none of these cases may get as far as the chain.
  const purchases = createPurchaseClient(spendWallet, { rpcUrl: 'http://127.0.0.1:9' });

  async function serve(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const request = (resource: string) => ({
    resource,
    merchant: newAddress(),
    amount: 100_000n,
    token,
    chainId: 421_614,
  });

  it('does not follow a redirect', async () => {
    let visited = false;
    const target = await serve((_request, response) => {
      visited = true;
      response.end('{}');
    });
    const merchant = await serve((_request, response) => {
      response.writeHead(302, { location: `${target.url}/elsewhere` }).end();
    });
    try {
      await expect(purchases.buy(request(`${merchant.url}/v1/quotes/TSK-LOGI20`))).rejects.toThrow(
        PurchaseError,
      );
      expect(visited).toBe(false);
    } finally {
      await merchant.close();
      await target.close();
    }
  });

  it('treats data handed over without a payment as a failed purchase', async () => {
    const merchant = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"level":1}');
    });
    try {
      await expect(purchases.buy(request(`${merchant.url}/v1/quotes/TSK-LOGI20`))).rejects.toThrow(
        'the merchant asked for no payment',
      );
    } finally {
      await merchant.close();
    }
  });

  it('reports an error status without signing anything', async () => {
    const merchant = await serve((_request, response) => {
      response.writeHead(503).end();
    });
    try {
      await expect(purchases.buy(request(`${merchant.url}/v1/quotes/TSK-LOGI20`))).rejects.toThrow(
        'the merchant answered 503 and asked for no payment',
      );
    } finally {
      await merchant.close();
    }
  });

  it('rejects a payment challenge it cannot read', async () => {
    const merchant = await serve((_request, response) => {
      response
        .writeHead(402, {
          'www-authenticate': 'Payment id="x", method="arbitrum", intent="charge", request="!!"',
        })
        .end();
    });
    try {
      await expect(purchases.buy(request(`${merchant.url}/v1/quotes/TSK-LOGI20`))).rejects.toThrow(
        PurchaseError,
      );
    } finally {
      await merchant.close();
    }
  });
});
