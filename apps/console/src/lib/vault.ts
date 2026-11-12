import { type Address, type Hex, type PublicClient, erc20Abi, getAddress, isAddress } from 'viem';

import { mandateVaultAbi } from '@agent-gateway/contracts/abi';
import deployment from '@agent-gateway/contracts/deployments/arbitrum-sepolia.json';

/** Reads mandates straight from the vault. The console does not ask the gateway what the chain says. */

const configured = (import.meta.env.VITE_VAULT_ADDRESS as string | undefined) ?? '';

/**
 * The vault this console is for: MANDATE_VAULT_ADDRESS in the shell that started it, or else the vault
 * this repository records as deployed.
 *
 * It is not taken from the gateway. The principal's transactions and the approver's signatures go to
 * this address and no other, so a gateway that somebody else controls cannot point them at a contract
 * of its own choosing.
 */
export const VAULT: Address = getAddress(
  isAddress(configured, { strict: false }) ? configured : deployment.contracts.MandateVault.address,
);

/** What the vault says of itself, and what its token says of itself. */
export type VaultFacts = {
  principal: Address;
  identityRegistry: Address;
  token: { address: Address; symbol: string; decimals: number };
};

export async function readVaultFacts(client: PublicClient, vault: Address): Promise<VaultFacts> {
  const contract = { address: vault, abi: mandateVaultAbi } as const;
  const [principal, token, identityRegistry] = await Promise.all([
    client.readContract({ ...contract, functionName: 'principal' }),
    client.readContract({ ...contract, functionName: 'token' }),
    client.readContract({ ...contract, functionName: 'identityRegistry' }),
  ]);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { principal, identityRegistry, token: { address: token, symbol, decimals } };
}

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
