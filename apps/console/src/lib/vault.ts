import type { Address, Hex, PublicClient } from 'viem';

import { mandateVaultAbi } from '@agent-gateway/contracts/abi';

/** Reads mandates straight from the vault. The console does not ask the gateway what the chain says. */

export type Mandate = {
  id: bigint;
  agentId: bigint;
  executor: Address;
  approver: Address;
  /** Last second (Unix time) at which the mandate can pay. */
  validUntil: number;
  revoked: boolean;
  perPaymentCap: bigint;
  dailyCap: bigint;
  hardCeiling: bigint;
  approvalNonce: bigint;
  termsHash: Hex;
  payees: readonly Address[];
  /** Total paid out in the current UTC day, approved payments included. */
  spentToday: bigint;
  /** Not revoked and not expired, at the block the data was read at. */
  active: boolean;
};

export type MandateState = 'active' | 'revoked' | 'expired';

export const stateOf = (mandate: Mandate): MandateState =>
  mandate.revoked ? 'revoked' : mandate.active ? 'active' : 'expired';

/** The newest mandates first. */
export async function readMandates(
  client: PublicClient,
  vault: Address,
  limit = 12,
): Promise<Mandate[]> {
  const contract = { address: vault, abi: mandateVaultAbi } as const;
  const blockNumber = await client.getBlockNumber();
  const count = await client.readContract({
    ...contract,
    functionName: 'mandateCount',
    blockNumber,
  });
  const ids: bigint[] = [];
  for (let id = count; id >= 1n && ids.length < limit; id -= 1n) ids.push(id);
  if (ids.length === 0) return [];

  const results = await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: ids.flatMap((id) => [
      { ...contract, functionName: 'getMandate', args: [id] } as const,
      { ...contract, functionName: 'spentToday', args: [id] } as const,
      { ...contract, functionName: 'isActive', args: [id] } as const,
    ]),
  });

  return ids.map((id, index) => {
    const terms = results[index * 3] as {
      agentId: bigint;
      executor: Address;
      validUntil: bigint;
      revoked: boolean;
      approver: Address;
      perPaymentCap: bigint;
      dailyCap: bigint;
      hardCeiling: bigint;
      approvalNonce: bigint;
      termsHash: Hex;
      payees: readonly Address[];
    };
    return {
      id,
      agentId: terms.agentId,
      executor: terms.executor,
      approver: terms.approver,
      validUntil: Number(terms.validUntil),
      revoked: terms.revoked,
      perPaymentCap: terms.perPaymentCap,
      dailyCap: terms.dailyCap,
      hardCeiling: terms.hardCeiling,
      approvalNonce: terms.approvalNonce,
      termsHash: terms.termsHash,
      payees: terms.payees,
      spentToday: results[index * 3 + 1] as bigint,
      active: results[index * 3 + 2] as boolean,
    };
  });
}
