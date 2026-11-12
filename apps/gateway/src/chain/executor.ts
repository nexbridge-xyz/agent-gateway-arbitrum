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

export type ApprovedPaymentRequest = MandatePaymentRequest & {
  /** Last second (Unix time) at which the approval can be used. */
  deadline: bigint;
  /** The approver's EIP-712 signature. */
  signature: Hex;
};

export interface PaymentExecutor {
  readonly address: Address;
  /** A payment inside the mandate. The vault checks the allowlist and the caps. */
  payWithinMandate(request: MandatePaymentRequest): Promise<PaymentReceipt>;
  /** A payment outside the mandate. The vault checks the approver's signature and the hard ceiling. */
  payWithApproval(request: ApprovedPaymentRequest): Promise<PaymentReceipt>;
  /**
   * Looks again at a transaction that was sent and could not be confirmed. Returns its receipt if it
   * paid, null if its outcome is still unknown, and throws a PaymentError if it is known to have failed.
   */
  lookAgain(
    transactionHash: Hex,
    event: PaymentReceipt['event'],
    evidenceHash: Hex,
  ): Promise<PaymentReceipt | null>;
}

/**
 * A payment that did not go through, or whose outcome is not known. `transactionHash` is set when a
 * transaction was sent. `unconfirmed` is true when it was sent and its receipt could not be read: the
 * vault may have paid, or may still pay, and nobody here knows.
 */
export class PaymentError extends Error {
  constructor(
    message: string,
    readonly transactionHash: Hex | null,
    readonly unconfirmed = false,
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

  /** What a mined transaction did: its receipt as a payment, or a PaymentError that says why not. */
  const read = (
    receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>,
    event: PaymentReceipt['event'],
    evidenceHash: Hex,
  ): PaymentReceipt => {
    const transactionHash = receipt.transactionHash;
    if (receipt.status !== 'success') {
      throw new PaymentError('the transaction was mined but reverted', transactionHash);
    }
    const paid = parseEventLogs({
      abi: mandateVaultAbi,
      logs: receipt.logs,
      eventName: event,
    }).some((log) => log.args.evidenceHash === evidenceHash);
    if (!paid) {
      throw new PaymentError(
        `the transaction has no ${event} event for this evidence hash`,
        transactionHash,
      );
    }
    return { transactionHash, blockNumber: receipt.blockNumber, event };
  };

  /**
   * Runs `send`, which simulates and submits, and waits for the receipt. A failure before the
   * transaction left is a payment that was not made. A failure after it left is something else: the
   * transaction may be mined all the same, so it is reported as unconfirmed, never as failed.
   */
  const pay = async (
    event: PaymentReceipt['event'],
    evidenceHash: Hex,
    send: () => Promise<Hex>,
  ): Promise<PaymentReceipt> => {
    let transactionHash: Hex;
    try {
      transactionHash = await send();
    } catch (error) {
      throw new PaymentError(describeContractError(error), null);
    }
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash,
        timeout: 120_000,
      });
    } catch (error) {
      throw new PaymentError(
        `the transaction was sent, but its outcome could not be read (${describeContractError(error)}). The vault may have paid`,
        transactionHash,
        true,
      );
    }
    return read(receipt, event, evidenceHash);
  };

  return {
    address: account.address,

    async lookAgain(transactionHash, event, evidenceHash) {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
      } catch {
        // Not mined, or the endpoint cannot say. Still unknown.
        return null;
      }
      return read(receipt, event, evidenceHash);
    },

    payWithinMandate: ({ mandateId, payee, amount, evidenceHash }) =>
      pay('MandatePayment', evidenceHash, async () => {
        // Run the call first, so a payment the vault would refuse costs nothing and sends nothing.
        const { request } = await publicClient.simulateContract({
          account,
          address: vault,
          abi: mandateVaultAbi,
          functionName: 'payWithinMandate',
          args: [mandateId, payee, amount, evidenceHash],
        });
        return walletClient.writeContract(request);
      }),

    payWithApproval: ({ mandateId, payee, amount, evidenceHash, deadline, signature }) =>
      pay('ApprovedPayment', evidenceHash, async () => {
        const { request } = await publicClient.simulateContract({
          account,
          address: vault,
          abi: mandateVaultAbi,
          functionName: 'payWithApproval',
          args: [mandateId, payee, amount, evidenceHash, deadline, signature],
        });
        return walletClient.writeContract(request);
      }),
  };
}
