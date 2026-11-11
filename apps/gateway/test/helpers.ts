import { type Address, type Hex, getAddress, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { IntentDomain, PaymentIntent } from '../src/protocol/intent';

/** A fresh throwaway account. Tests never use a fixed private key. */
export function newAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

/** A fresh address that nobody holds a key for in the test. */
export function newAddress(): Address {
  return newAccount().address;
}

export const VAULT: Address = getAddress('0x7293763f6b73783834484cd976528d01cb6c8ccf');
export const DOMAIN: IntentDomain = { chainId: 421_614, vault: VAULT };

/** 2026-11-13 03:00:00 UTC, the same instant the Solidity tests start at. */
export const NOW = 1_794_538_800;

export const USDC = 1_000_000n;

let nonceCounter = 0;

export function nextNonce(): Hex {
  nonceCounter += 1;
  return toHex(nonceCounter, { size: 32 });
}

export function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    agentId: '354',
    payee: getAddress('0x00000000000000000000000000000000000a11ce'),
    amount: '1500000',
    purpose: 'Invoice INV-2026-1107: monthly market data feed',
    invoiceId: 'INV-2026-1107',
    context: {},
    nonce: nextNonce(),
    expiresAt: NOW + 300,
    ...overrides,
  };
}
