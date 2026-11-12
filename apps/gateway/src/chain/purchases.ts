import { charge } from '@arbitrum/mpp/client';
import { Receipt } from 'mppx';
import { Mppx } from 'mppx/client';
import {
  type Address,
  type Hex,
  type LocalAccount,
  isAddressEqual,
  keccak256,
  stringToHex,
} from 'viem';

import type { Json } from '../protocol/json';

/**
 * Per-call purchases over the Machine Payments Protocol (MPP). The gateway's spend wallet answers a
 * merchant's "402 Payment Required" challenge with a signed USDC transfer authorization (EIP-3009);
 * the merchant submits it and pays the gas.
 *
 * The spend wallet is topped up from the vault for exactly one purchase at a time, so the vault's caps
 * bound everything it can ever pay. It still checks every challenge before signing.
 */

export type PurchaseRequest = {
  /** The paid resource. */
  resource: string;
  /** The merchant the principal registered, and the only address the spend wallet will pay. */
  merchant: Address;
  /** The exact price the gateway approved, in the token's smallest unit. */
  amount: bigint;
  token: Address;
  chainId: number;
};

export type Purchase = {
  /** The merchant's settlement transaction. */
  settlementTransactionHash: Hex;
  settledAt: string;
  /** What the merchant returned. */
  body: Json;
  /** keccak256 of the response text, kept as evidence of what was bought. */
  responseHash: Hex;
};

export interface PurchaseClient {
  readonly spendWallet: Address;
  buy(request: PurchaseRequest): Promise<Purchase>;
}

export class PurchaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurchaseError';
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;

/** What is wrong with a merchant's challenge, or null if it asks for exactly what was approved. */
export function challengeProblem(
  challenge: { method: string; intent: string; request: Record<string, unknown> },
  expected: Omit<PurchaseRequest, 'resource'>,
): string | null {
  const { request } = challenge;
  const details = (request.methodDetails ?? {}) as Record<string, unknown>;
  const types = details.credentialTypes;

  if (challenge.method !== 'arbitrum' || challenge.intent !== 'charge') {
    return `it uses ${challenge.method}/${challenge.intent}, not an Arbitrum charge`;
  }
  if (details.chainId !== expected.chainId) return `it is for chain ${String(details.chainId)}`;
  if (
    typeof request.currency !== 'string' ||
    !isAddressEqual(request.currency as Address, expected.token)
  ) {
    return 'it asks for a different token';
  }
  if (
    typeof request.recipient !== 'string' ||
    !isAddressEqual(request.recipient as Address, expected.merchant)
  ) {
    return `it pays ${String(request.recipient)}, not the registered merchant`;
  }
  if (request.amount !== expected.amount.toString()) {
    return `it asks for ${String(request.amount)}, not the approved ${expected.amount}`;
  }
  if (!Array.isArray(types) || types.length !== 1 || types[0] !== 'authorization') {
    return 'it does not ask for a plain EIP-3009 authorization';
  }
  if (details.splits !== undefined) return 'it splits the payment between several recipients';
  return null;
}

export function createPurchaseClient(
  account: LocalAccount,
  options: { rpcUrl: string },
): PurchaseClient {
  return {
    spendWallet: account.address,

    async buy({ resource, merchant, amount, token, chainId }) {
      const mppx = Mppx.create({
        // Never replace the global fetch: only this one request is allowed to pay.
        polyfill: false,
        methods: [charge({ account, chainId, rpcUrls: new Map([[chainId, options.rpcUrl]]) })],
        // The challenge comes from the merchant's server and is not trusted. Sign only if it asks for
        // exactly the token, amount and recipient the gateway approved.
        onChallenge: async (challenge, { createCredential }) => {
          const problem = challengeProblem(challenge, { merchant, amount, token, chainId });
          if (problem !== null)
            throw new PurchaseError(`the merchant's payment challenge was rejected: ${problem}`);
          return createCredential();
        },
      });

      let response: Response;
      try {
        response = await mppx.fetch(resource, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        if (error instanceof PurchaseError) throw error;
        throw new PurchaseError(
          `the purchase request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      if (!response.ok)
        throw new PurchaseError(`the merchant answered ${response.status} after payment`);

      const encoded = response.headers.get('payment-receipt');
      if (encoded === null) throw new PurchaseError('the merchant sent no payment receipt');
      let receipt: Receipt.Receipt;
      try {
        receipt = Receipt.deserialize(encoded);
      } catch {
        throw new PurchaseError("the merchant's payment receipt cannot be read");
      }
      if (!/^0x[0-9a-f]{64}$/.test(receipt.reference)) {
        throw new PurchaseError("the merchant's payment receipt names no transaction");
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES)
        throw new PurchaseError('the merchant returned too much data');
      let body: Json;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        throw new PurchaseError('the merchant did not return JSON');
      }

      return {
        settlementTransactionHash: receipt.reference as Hex,
        settledAt: receipt.timestamp,
        body,
        responseHash: keccak256(stringToHex(text)),
      };
    },
  };
}
