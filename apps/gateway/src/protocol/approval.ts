import { type Address, type Hex, recoverTypedDataAddress } from 'viem';

/**
 * A payment approval is the EIP-712 message an approver signs to let one exact payment outside the
 * mandate go through. MandateVault checks this signature onchain; the same typed data is used here
 * to ask a wallet for it and to check it offline.
 */

export const PAYMENT_APPROVAL_TYPES = {
  PaymentApproval: [
    { name: 'mandateId', type: 'uint256' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type PaymentApproval = {
  mandateId: bigint;
  payee: Address;
  amount: bigint;
  evidenceHash: Hex;
  nonce: bigint;
  deadline: bigint;
};

export function approvalTypedData(
  vault: { chainId: number; address: Address },
  approval: PaymentApproval,
) {
  return {
    domain: {
      name: 'MandateVault',
      version: '1',
      chainId: vault.chainId,
      verifyingContract: vault.address,
    },
    types: PAYMENT_APPROVAL_TYPES,
    primaryType: 'PaymentApproval',
    message: approval,
  } as const;
}

/** The address that signed the approval, or null if the signature cannot be read. */
export async function recoverApprovalSigner(
  vault: { chainId: number; address: Address },
  approval: PaymentApproval,
  signature: Hex,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({ ...approvalTypedData(vault, approval), signature });
  } catch {
    return null;
  }
}

/**
 * A decline is the approver saying no. The vault never sees it, so it is signed for the gateway's
 * domain, the same one agents sign their intents for, and names the intent and its evidence hash.
 */
export const APPROVAL_DECLINE_TYPES = {
  ApprovalDecline: [
    { name: 'intentId', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
} as const;

export function declineTypedData(
  vault: { chainId: number; address: Address },
  intentId: Hex,
  evidenceHash: Hex,
) {
  return {
    domain: {
      name: 'AgentGateway',
      version: '1',
      chainId: vault.chainId,
      verifyingContract: vault.address,
    },
    types: APPROVAL_DECLINE_TYPES,
    primaryType: 'ApprovalDecline',
    message: { intentId, evidenceHash },
  } as const;
}

/** The address that signed the decline, or null if the signature cannot be read. */
export async function recoverDeclineSigner(
  vault: { chainId: number; address: Address },
  intentId: Hex,
  evidenceHash: Hex,
  signature: Hex,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      ...declineTypedData(vault, intentId, evidenceHash),
      signature,
    });
  } catch {
    return null;
  }
}
