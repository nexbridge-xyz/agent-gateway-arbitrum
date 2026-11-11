import {
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  parseEventLogs,
} from 'viem';

import { mandateVaultAbi } from './abis';

/**
 * The executor is the only money-moving key the gateway holds, and the vault limits what it can do.
 * This module is the only place that key is used.
 */

export type PaymentReceipt = {
  transactionHash: Hex;
  blockNumber: bigint;
  event: 'MandatePayment' | 'ApprovedPayment';
};

export type MandatePaymentRequest = {
  mandateId: bigint;
  payee: Address;
  amount: bigint;
  evidenceHash: Hex;
};

export interface PaymentExecutor {
  readonly address: Address;
  payWithinMandate(request: MandatePaymentRequest): Promise<PaymentReceipt>;
}

/** A payment that did not go through. `transactionHash` is set when a transaction was sent. */
export class PaymentError extends Error {
  constructor(
    message: string,
    readonly transactionHash: Hex | null,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** Turns a failed contract call into one line, naming the vault's custom error when there is one. */
export function describeContractError(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? 'unknown reason';
      const args = (revert.data?.args ?? []).map((arg) => String(arg)).join(', ');
      return `the vault refused: ${name}(${args})`;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

export function createPaymentExecutor(
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account>,
  vault: Address,
): PaymentExecutor {
  const account = walletClient.account;

  return {
    address: account.address,

    async payWithinMandate({ mandateId, payee, amount, evidenceHash }) {
      let transactionHash: Hex | null = null;
      try {
        // Run the call first, so a payment the vault would refuse costs nothing and sends nothing.
        const { request } = await publicClient.simulateContract({
          account,
          address: vault,
          abi: mandateVaultAbi,
          functionName: 'payWithinMandate',
          args: [mandateId, payee, amount, evidenceHash],
        });
        transactionHash = await walletClient.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: transactionHash,
          timeout: 120_000,
        });
        if (receipt.status !== 'success') {
          throw new PaymentError('the transaction was mined but reverted', transactionHash);
        }

        const paid = parseEventLogs({
          abi: mandateVaultAbi,
          logs: receipt.logs,
          eventName: 'MandatePayment',
        }).some((log) => log.args.evidenceHash === evidenceHash);
        if (!paid) {
          throw new PaymentError(
            'the transaction has no MandatePayment event for this evidence hash',
            transactionHash,
          );
        }
        return { transactionHash, blockNumber: receipt.blockNumber, event: 'MandatePayment' };
      } catch (error) {
        if (error instanceof PaymentError) throw error;
        throw new PaymentError(describeContractError(error), transactionHash);
      }
    },
  };
}
