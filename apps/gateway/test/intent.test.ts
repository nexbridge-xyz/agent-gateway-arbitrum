import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  contextHash,
  intentId,
  paymentIntentSchema,
  recoverIntentSigner,
  signIntent,
  signedIntentSchema,
} from '../src/protocol/intent';
import { DOMAIN, makeIntent, newAccount, newAddress } from './helpers';

describe('payment intent schema', () => {
  it('accepts a well-formed intent and normalises the payee address', () => {
    const parsed = paymentIntentSchema.parse({
      ...makeIntent(),
      payee: '0x00000000000000000000000000000000000a11ce',
    });
    expect(parsed.payee).toBe(getAddress('0x00000000000000000000000000000000000a11ce'));
  });

  it('fills in an empty invoice id and context', () => {
    const { invoiceId: _invoiceId, context: _context, ...rest } = makeIntent();
    const parsed = paymentIntentSchema.parse(rest);
    expect(parsed.invoiceId).toBe('');
    expect(parsed.context).toEqual({});
  });

  it.each([
    ['a negative amount', { amount: '-1' }],
    ['an amount with decimals', { amount: '1.5' }],
    ['an amount with a leading zero', { amount: '01' }],
    ['an amount in hex', { amount: '0x10' }],
    ['an amount above 256 bits', { amount: (2n ** 256n).toString() }],
    ['an agent id that is not a number', { agentId: 'agent-1' }],
    ['a payee that is not an address', { payee: '0x1234' }],
    ['an empty purpose', { purpose: '' }],
    ['a purpose that is too long', { purpose: 'x'.repeat(281) }],
    ['a purpose with a broken character', { purpose: `pay ${String.fromCharCode(0xd800)}` }],
    ['a short nonce', { nonce: '0x01' }],
    ['an expiry that is not a whole number', { expiresAt: 1.5 }],
    ['a context that is not an object', { context: ['a'] }],
    ['a context that is too large', { context: { blob: 'x'.repeat(9000) } }],
    ['an unknown field', { tip: '1' }],
  ])('rejects %s', (_name, change) => {
    expect(paymentIntentSchema.safeParse({ ...makeIntent(), ...change }).success).toBe(false);
  });

  it('rejects a signature that is not 65 bytes', () => {
    expect(
      signedIntentSchema.safeParse({ intent: makeIntent(), signature: '0x1234' }).success,
    ).toBe(false);
  });
});

describe('intent id', () => {
  it('is the same for the same intent and different for any change', () => {
    const intent = makeIntent({ context: { b: 2, a: 1 } });
    const id = intentId(DOMAIN, intent);

    expect(intentId(DOMAIN, { ...intent, context: { a: 1, b: 2 } })).toBe(id);
    expect(intentId(DOMAIN, { ...intent, amount: '1500001' })).not.toBe(id);
    expect(intentId(DOMAIN, { ...intent, payee: newAddress() })).not.toBe(id);
    expect(intentId(DOMAIN, { ...intent, purpose: `${intent.purpose}.` })).not.toBe(id);
    expect(intentId(DOMAIN, { ...intent, invoiceId: 'INV-2' })).not.toBe(id);
    expect(intentId(DOMAIN, { ...intent, context: { a: 1, b: 3 } })).not.toBe(id);
    expect(intentId(DOMAIN, { ...intent, expiresAt: intent.expiresAt + 1 })).not.toBe(id);
    expect(intentId(DOMAIN, { ...intent, agentId: '355' })).not.toBe(id);
  });

  it('is bound to the vault and the chain', () => {
    const intent = makeIntent();
    const id = intentId(DOMAIN, intent);
    expect(intentId({ ...DOMAIN, chainId: 42_161 }, intent)).not.toBe(id);
    expect(intentId({ ...DOMAIN, vault: newAddress() }, intent)).not.toBe(id);
  });

  it('hashes the context by its canonical form', () => {
    expect(contextHash({ x: [1, 2], y: null })).toBe(contextHash({ y: null, x: [1, 2] }));
    expect(contextHash({ x: [1, 2] })).not.toBe(contextHash({ x: [2, 1] }));
  });
});

describe('intent signature', () => {
  it('recovers the signing account', async () => {
    const agent = newAccount();
    const signed = await signIntent(agent, DOMAIN, makeIntent());
    expect(signedIntentSchema.safeParse(signed).success).toBe(true);
    expect(await recoverIntentSigner(DOMAIN, signed)).toBe(agent.address);
  });

  it('recovers a different address when the intent was changed after signing', async () => {
    const agent = newAccount();
    const signed = await signIntent(agent, DOMAIN, makeIntent());
    const tampered = { ...signed, intent: { ...signed.intent, payee: newAddress() } };
    expect(await recoverIntentSigner(DOMAIN, tampered)).not.toBe(agent.address);
  });

  it('recovers a different address under another vault or chain', async () => {
    const agent = newAccount();
    const signed = await signIntent(agent, DOMAIN, makeIntent());
    expect(await recoverIntentSigner({ ...DOMAIN, vault: newAddress() }, signed)).not.toBe(
      agent.address,
    );
    expect(await recoverIntentSigner({ ...DOMAIN, chainId: 42_161 }, signed)).not.toBe(
      agent.address,
    );
  });

  it('returns null for a signature that cannot be read', async () => {
    const signature = `0x${'00'.repeat(65)}`;
    expect(await recoverIntentSigner(DOMAIN, { intent: makeIntent(), signature })).toBeNull();
  });
});
