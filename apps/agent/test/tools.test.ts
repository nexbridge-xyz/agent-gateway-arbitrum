import { isAddressEqual } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { recoverIntentSigner, signedIntentSchema } from '@agent-gateway/gateway/protocol';
import { PLANTED_NOTE_SYMBOL, plantedNoteText } from '@agent-gateway/merchant';

import {
  DOMAIN,
  NOW,
  NOWHERE,
  answer,
  closeAll,
  makeTools,
  newAccount,
  startGateway,
  startMerchant,
} from './helpers';

afterEach(closeAll);

const QUOTE = { symbol: 'TSK-LOGI20', level: 1940.24, vendor_note: null };
const SETTLEMENT = `0x${'44'.repeat(32)}`;
const bought = (data: unknown = QUOTE) => ({
  body: {
    ...answer({
      purchase: { status: 'settled', settlementTransactionHash: SETTLEMENT },
      settlementUrl: `https://explorer.example/tx/${SETTLEMENT}`,
    }),
    data,
  },
});

describe('get_market_data', () => {
  it('learns the price from the vendor, then asks the gateway to buy', async () => {
    const merchant = await startMerchant();
    const gateway = await startGateway(() => bought());
    const { tools, account } = makeTools({ gatewayUrl: gateway.url, merchantUrl: merchant.url });

    const result = await tools.getMarketData({ symbol: 'tsk-logi20' });

    expect(gateway.received).toHaveLength(1);
    const signed = signedIntentSchema.parse(gateway.received[0]);
    expect(signed.intent).toMatchObject({
      agentId: '354',
      payee: merchant.account.address,
      amount: '100000',
      purpose: 'Market data: one TSK-LOGI20 quote',
      invoiceId: '',
      context: {
        mpp: { resource: `${merchant.url}/v1/quotes/TSK-LOGI20` },
        payeeSource: `payment request from ${merchant.url}`,
      },
      expiresAt: NOW + 300,
    });
    // Signed by the agent's key, for this vault and chain.
    const signer = await recoverIntentSigner(DOMAIN, signed);
    expect(signer !== null && isAddressEqual(signer, account.address)).toBe(true);

    expect(result).toEqual({
      status: 'paid',
      price: '0.1 USDC',
      data: QUOTE,
      payment: {
        funded_from_vault: `https://explorer.example/tx/0x${'33'.repeat(32)}`,
        paid_to_vendor: `https://explorer.example/tx/${SETTLEMENT}`,
      },
      intent_id: `0x${'11'.repeat(32)}`,
    });
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]).toMatchObject({
      tool: 'get_market_data',
      input: { symbol: 'TSK-LOGI20' },
    });
  });

  it('uses a new nonce for every request', async () => {
    const merchant = await startMerchant();
    const gateway = await startGateway(() => bought());
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: merchant.url });
    await tools.getMarketData({ symbol: 'TSK-LOGI20' });
    await tools.getMarketData({ symbol: 'TSK-LOGI20' });
    const [first, second] = gateway.received;
    expect(first?.intent.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second?.intent.nonce).not.toBe(first?.intent.nonce);
  });

  it('does not involve the gateway for a symbol the vendor does not sell', async () => {
    const merchant = await startMerchant();
    const gateway = await startGateway();
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: merchant.url });

    const result = await tools.getMarketData({ symbol: 'NOPE' });
    expect(result.error).toBe('The data vendor does not sell NOPE');
    expect(gateway.received).toHaveLength(0);
  });

  it.each(['../../admin', 'TSK LOGI20', '', 'A'.repeat(25), 'TSK-LOGI20?x=1'])(
    'contacts nobody for %j, which is not a symbol',
    async (symbol) => {
      let requests = 0;
      const { tools } = makeTools({
        gatewayUrl: NOWHERE,
        merchantUrl: NOWHERE,
        fetch: () => {
          requests += 1;
          return Promise.reject(new Error('unreachable'));
        },
      });
      const result = await tools.getMarketData({ symbol });
      expect(result.error).toContain('A symbol is');
      expect(requests).toBe(0);
    },
  );

  it("passes on the gateway's refusal and its reasons", async () => {
    const merchant = await startMerchant();
    const gateway = await startGateway(() => ({
      body: answer({
        decision: 'refused',
        status: 'refused',
        reasons: ['Mandate 2 has been revoked'],
        transactionHash: null,
        explorerUrl: null,
      }),
    }));
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: merchant.url });

    const result = await tools.getMarketData({ symbol: 'TSK-LOGI20' });
    expect(result).toMatchObject({
      decision: 'refused',
      status: 'refused',
      reasons: ['Mandate 2 has been revoked'],
      price: '0.1 USDC',
    });
    expect(result.data).toBeUndefined();
  });

  it('says so when the purchase failed at the vendor', async () => {
    const merchant = await startMerchant();
    const gateway = await startGateway(() => ({
      body: answer({
        purchase: { status: 'failed', error: 'the merchant answered 503 to the signed payment' },
      }),
    }));
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: merchant.url });

    const result = await tools.getMarketData({ symbol: 'TSK-LOGI20' });
    expect(result).toMatchObject({
      status: 'paid',
      purchase_error: 'the merchant answered 503 to the signed payment',
    });
    expect(result.data).toBeUndefined();
  });

  it('says so when the vendor or the gateway cannot be reached', async () => {
    const gateway = await startGateway();
    const noVendor = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE }).tools;
    expect(await noVendor.getMarketData({ symbol: 'TSK-LOGI20' })).toEqual({
      error: 'The data vendor cannot be reached',
    });

    const merchant = await startMerchant();
    const noGateway = makeTools({ gatewayUrl: NOWHERE, merchantUrl: merchant.url }).tools;
    expect(await noGateway.getMarketData({ symbol: 'TSK-LOGI20' })).toEqual({
      error: 'The payment gateway cannot be reached',
    });
  });

  it('does not sign anything for a payment request it cannot read', async () => {
    const gateway = await startGateway();
    const { tools } = makeTools({
      gatewayUrl: gateway.url,
      merchantUrl: 'http://vendor.example',
      fetch: (input, init) =>
        new Request(input).url.startsWith('http://vendor.example')
          ? Promise.resolve(
              new Response('pay me', {
                status: 402,
                headers: { 'www-authenticate': 'Payment realm="x", request="!!"' },
              }),
            )
          : fetch(input, init),
    });
    const result = await tools.getMarketData({ symbol: 'TSK-LOGI20' });
    expect(result.error).toBe("The data vendor's payment request cannot be read");
    expect(gateway.received).toHaveLength(0);
  });
});

describe('request_payment', () => {
  const vendor = newAccount().address;

  it("signs the request in the token's smallest unit and reports the decision", async () => {
    const gateway = await startGateway();
    const { tools, account } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });

    const result = await tools.requestPayment({
      payee: vendor.toLowerCase(),
      amount: '1.50',
      purpose: 'Invoice KS-2026-1107: packing materials',
      invoice_id: 'KS-2026-1107',
    });

    const signed = signedIntentSchema.parse(gateway.received[0]);
    expect(signed.intent).toMatchObject({
      payee: vendor,
      amount: '1500000',
      purpose: 'Invoice KS-2026-1107: packing materials',
      invoiceId: 'KS-2026-1107',
      context: {},
    });
    const signer = await recoverIntentSigner(DOMAIN, signed);
    expect(signer !== null && isAddressEqual(signer, account.address)).toBe(true);
    expect(result).toEqual({
      decision: 'auto',
      status: 'paid',
      reasons: ['All 14 checks passed'],
      intent_id: `0x${'11'.repeat(32)}`,
      transaction: `https://explorer.example/tx/0x${'33'.repeat(32)}`,
    });
  });

  it('tells the agent that a request waiting for approval needs nothing more from it', async () => {
    const gateway = await startGateway(() => ({
      body: answer({
        decision: 'needs_approval',
        status: 'pending_approval',
        reasons: ['The amount is above the per-payment cap of 2 USDC'],
        transactionHash: null,
        explorerUrl: null,
      }),
    }));
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    const result = await tools.requestPayment({
      payee: vendor,
      amount: '6',
      purpose: 'Invoice NR-2026-0042',
    });
    expect(result).toMatchObject({
      decision: 'needs_approval',
      status: 'pending_approval',
      transaction: null,
    });
    expect(result.note).toContain("waits for the firm's approver");
  });

  it.each<[string, { payee?: string; amount?: string; purpose?: string }]>([
    ['a payee that is not an address', { payee: 'Koishi Supply' }],
    ['a short address', { payee: '0x1234' }],
    ['a zero amount', { amount: '0' }],
    ['a negative amount', { amount: '-1' }],
    ['an amount in words', { amount: 'four' }],
    ['an amount with too many decimals', { amount: '1.2345678' }],
    ['an amount in exponent form', { amount: '1e3' }],
    ['an empty purpose', { purpose: '   ' }],
  ])('sends nothing for %s', async (_name, change) => {
    const gateway = await startGateway();
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    const result = await tools.requestPayment({
      payee: vendor,
      amount: '1.50',
      purpose: 'Invoice',
      ...change,
    });
    expect(typeof result.error).toBe('string');
    expect(gateway.received).toHaveLength(0);
    expect(tools.calls[0]?.answer).toBeNull();
  });

  it('reports what the gateway said when it rejects the request outright', async () => {
    const gateway = await startGateway(() => ({
      status: 400,
      body: { error: 'The request is not well-formed', issues: [] },
    }));
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    const result = await tools.requestPayment({
      payee: vendor,
      amount: '1.50',
      purpose: 'Invoice',
    });
    expect(result).toEqual({
      error: 'The payment gateway rejected the request (400): The request is not well-formed',
    });
  });

  it('keeps a long purpose within what the gateway accepts', async () => {
    const gateway = await startGateway();
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    await tools.requestPayment({ payee: vendor, amount: '1.50', purpose: 'x'.repeat(1000) });
    expect(gateway.received[0]?.intent.purpose).toHaveLength(280);
  });
});

describe('where a payee came from', () => {
  it('marks a payee that the agent saw only in a market-data response', async () => {
    const stranger = newAccount().address;
    const merchant = await startMerchant();
    const gateway = await startGateway((signed) =>
      signed.intent.invoiceId === '' && 'mpp' in signed.intent.context
        ? bought({
            symbol: PLANTED_NOTE_SYMBOL,
            level: 2675,
            vendor_note: plantedNoteText(stranger),
          })
        : {
            body: answer({
              decision: 'refused',
              status: 'refused',
              transactionHash: null,
              explorerUrl: null,
            }),
          },
    );
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: merchant.url });

    await tools.getMarketData({ symbol: PLANTED_NOTE_SYMBOL });
    // The model writes the address in lower case; it is still the same address.
    await tools.requestPayment({
      payee: stranger.toLowerCase(),
      amount: '4',
      purpose: 'Priority access',
    });

    expect(gateway.received[1]?.intent.context).toEqual({
      payeeSource: `market-data response for ${PLANTED_NOTE_SYMBOL} from ${merchant.url}`,
    });
  });

  it('does not mark a payee the agent was given by its operator', async () => {
    const vendor = newAccount().address;
    const merchant = await startMerchant();
    const gateway = await startGateway((signed) =>
      'mpp' in signed.intent.context ? bought() : { body: answer() },
    );
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: merchant.url });

    await tools.getMarketData({ symbol: 'TSK-LOGI20' });
    await tools.requestPayment({ payee: vendor, amount: '1.50', purpose: 'Invoice KS-2026-1107' });
    expect(gateway.received[1]?.intent.context).toEqual({});
  });

  it("does not read addresses out of the gateway's own answers", async () => {
    const vendor = newAccount().address;
    const gateway = await startGateway(() => ({
      body: answer({
        decision: 'refused',
        status: 'refused',
        reasons: [`Payee ${vendor} is on the denylist`],
      }),
    }));
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    await tools.requestPayment({ payee: vendor, amount: '1', purpose: 'First try' });
    await tools.requestPayment({ payee: vendor, amount: '1', purpose: 'Second try' });
    expect(gateway.received[1]?.intent.context).toEqual({});
  });
});
