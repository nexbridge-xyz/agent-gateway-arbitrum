import {
  type Address,
  type Hex,
  type LocalAccount,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  maxUint256,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem';
import { z } from 'zod';

import { type JsonObject, canonicalize, isJson } from './json';

/**
 * A payment intent is what an agent sends to the gateway: "pay this payee this amount, for this
 * reason". The agent signs it with its request-signing key (EIP-712). That key can ask; it cannot pay.
 */

const MAX_CONTEXT_BYTES = 8 * 1024;

const uintString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'must be a whole number written in decimal digits')
  .max(78)
  .refine(
    (value) => /^[0-9]+$/.test(value) && BigInt(value) <= maxUint256,
    'does not fit in 256 bits',
  );

const addressString = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), 'must be an address')
  .transform((value) => getAddress(value));

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.isWellFormed(), 'must be well-formed text');

const contextObject = z
  .custom<JsonObject>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      isJson(value) &&
      canonicalize(value).length <= MAX_CONTEXT_BYTES,
    'must be a JSON object of at most 8 KB',
  )
  .default({});

export const paymentIntentSchema = z.strictObject({
  /** The agent's id in the ERC-8004 Identity Registry. */
  agentId: uintString,
  payee: addressString,
  /** In the token's smallest unit: 1500000 is 1.50 USDC. */
  amount: uintString,
  purpose: text(280).min(1),
  invoiceId: text(64).default(''),
  /** Anything the agent wants on record about where this request came from. Never trusted. */
  context: contextObject,
  /** 32 random bytes. Makes every intent unique, so a copy of an old request is recognised. */
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 32 bytes in hex'),
  /** Unix time in seconds after which the gateway ignores the request. */
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

export const signedIntentSchema = z.strictObject({
  intent: paymentIntentSchema,
  /** 65-byte ECDSA signature of the EIP-712 message, by the agent's registered wallet. */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'must be a 65-byte signature in hex'),
});

export type SignedIntent = z.infer<typeof signedIntentSchema>;

/** The EIP-712 domain ties an intent to one vault on one chain. */
export type IntentDomain = { chainId: number; vault: Address };

export const PAYMENT_INTENT_TYPES = {
  PaymentIntent: [
    { name: 'agentId', type: 'uint256' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'purpose', type: 'string' },
    { name: 'invoiceId', type: 'string' },
    { name: 'contextHash', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function contextHash(context: JsonObject): Hex {
  return keccak256(stringToHex(canonicalize(context)));
}

/** The exact typed data an agent signs and the gateway checks. */
export function intentTypedData(domain: IntentDomain, intent: PaymentIntent) {
  return {
    domain: {
      name: 'AgentGateway',
      version: '1',
      chainId: domain.chainId,
      verifyingContract: domain.vault,
    },
    types: PAYMENT_INTENT_TYPES,
    primaryType: 'PaymentIntent',
    message: {
      agentId: BigInt(intent.agentId),
      payee: intent.payee,
      amount: BigInt(intent.amount),
      purpose: intent.purpose,
      invoiceId: intent.invoiceId,
      contextHash: contextHash(intent.context),
      nonce: intent.nonce as Hex,
      expiresAt: BigInt(intent.expiresAt),
    },
  } as const;
}

/** The intent's id: its EIP-712 hash. The same intent always has the same id. */
export function intentId(domain: IntentDomain, intent: PaymentIntent): Hex {
  return hashTypedData(intentTypedData(domain, intent));
}

export async function signIntent(
  account: LocalAccount,
  domain: IntentDomain,
  intent: PaymentIntent,
): Promise<SignedIntent> {
  const signature = await account.signTypedData(intentTypedData(domain, intent));
  return { intent, signature };
}

/** The address that signed the intent, or null if the signature cannot be read. */
export async function recoverIntentSigner(
  domain: IntentDomain,
  signed: SignedIntent,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      ...intentTypedData(domain, signed.intent),
      signature: signed.signature as Hex,
    });
  } catch {
    return null;
  }
}
