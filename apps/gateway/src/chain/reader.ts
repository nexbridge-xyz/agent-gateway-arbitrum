import { type Address, type PublicClient, erc20Abi, isAddressEqual, zeroAddress } from 'viem';

import type { MandateFacts } from '../policy/evaluate';
import { identityRegistryAbi, mandateVaultAbi } from './abis';
import { activeFlagFromUri } from './registrationFile';

/** What the gateway needs to know about the chain. The policy engine never calls the chain itself. */

export type ChainInfo = {
  chainId: number;
  vault: Address;
  principal: Address;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  identityRegistry: Address;
};

export type AgentFacts = {
  registered: boolean;
  wallet: Address | null;
  active: boolean | null;
};

/** The state one decision is based on, all read at the same block. */
export type Snapshot = {
  blockNumber: bigint;
  blockTimestamp: number;
  agent: AgentFacts;
  mandate: MandateFacts | null;
  vault: { paused: boolean; balance: bigint };
};

export interface ChainReader {
  info(): Promise<ChainInfo>;
  /** `payee` is the address the vault would pay; the allowlist is checked for it. */
  snapshot(query: { agentId: bigint; payee: Address; executor: Address }): Promise<Snapshot>;
  /** The nonce the next approval for this mandate must carry, and the current block time. */
  approvalState(mandateId: bigint): Promise<{ nonce: bigint; blockTimestamp: number }>;
}

/** How many of the newest mandates are searched for the agent's mandate. */
const MANDATE_SEARCH_LIMIT = 200n;

export function createChainReader(client: PublicClient, vault: Address): ChainReader {
  let cached: ChainInfo | null = null;

  const info = async (): Promise<ChainInfo> => {
    if (cached !== null) return cached;
    const [chainId, principal, token, identityRegistry] = await Promise.all([
      client.getChainId(),
      client.readContract({ address: vault, abi: mandateVaultAbi, functionName: 'principal' }),
      client.readContract({ address: vault, abi: mandateVaultAbi, functionName: 'token' }),
      client.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: 'identityRegistry',
      }),
    ]);
    const [tokenSymbol, tokenDecimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    cached = { chainId, vault, principal, token, tokenSymbol, tokenDecimals, identityRegistry };
    return cached;
  };

  const snapshot: ChainReader['snapshot'] = async ({ agentId, payee, executor }) => {
    const { token, identityRegistry } = await info();
    const block = await client.getBlock({ blockTag: 'latest' });
    const at = { blockNumber: block.number } as const;
    const registry = { address: identityRegistry, abi: identityRegistryAbi } as const;
    const vaultContract = { address: vault, abi: mandateVaultAbi } as const;

    const [owner, wallet, uri, paused, mandateCount, balance] = await client.multicall({
      ...at,
      allowFailure: true,
      contracts: [
        { ...registry, functionName: 'ownerOf', args: [agentId] },
        { ...registry, functionName: 'getAgentWallet', args: [agentId] },
        { ...registry, functionName: 'tokenURI', args: [agentId] },
        { ...vaultContract, functionName: 'paused' },
        { ...vaultContract, functionName: 'mandateCount' },
        { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [vault] },
      ],
    });
    if (
      paused.status !== 'success' ||
      mandateCount.status !== 'success' ||
      balance.status !== 'success'
    ) {
      throw new Error('Could not read the vault state');
    }

    const registered = owner.status === 'success' && !isAddressEqual(owner.result, zeroAddress);
    const agentWallet =
      registered && wallet.status === 'success' && !isAddressEqual(wallet.result, zeroAddress)
        ? wallet.result
        : null;
    const agent: AgentFacts = {
      registered,
      wallet: agentWallet,
      active: registered && uri.status === 'success' ? activeFlagFromUri(uri.result) : null,
    };

    // Find the agent's mandate: the newest live one with this gateway as executor, or failing that
    // the newest one of any kind, so that the refusal can say what is wrong with it.
    const newest = mandateCount.result;
    const oldest = newest > MANDATE_SEARCH_LIMIT ? newest - MANDATE_SEARCH_LIMIT + 1n : 1n;
    const ids: bigint[] = [];
    for (let id = newest; id >= oldest; id -= 1n) ids.push(id);

    const terms =
      ids.length === 0
        ? []
        : await client.multicall({
            ...at,
            allowFailure: false,
            contracts: ids.map((id) => ({
              ...vaultContract,
              functionName: 'getMandate' as const,
              args: [id] as const,
            })),
          });

    const timestamp = Number(block.timestamp);
    const candidates = terms
      .map((mandate, index) => ({ id: ids[index] as bigint, mandate }))
      .filter(({ mandate }) => mandate.agentId === agentId);
    const live = (candidate: (typeof candidates)[number]) =>
      !candidate.mandate.revoked && timestamp <= Number(candidate.mandate.validUntil);
    const ours = (candidate: (typeof candidates)[number]) =>
      isAddressEqual(candidate.mandate.executor, executor);
    const chosen =
      candidates.find((candidate) => ours(candidate) && live(candidate)) ??
      candidates.find((candidate) => ours(candidate)) ??
      candidates[0];

    let mandate: MandateFacts | null = null;
    if (chosen !== undefined) {
      const [payeeAllowed, spentToday] = await client.multicall({
        ...at,
        allowFailure: false,
        contracts: [
          { ...vaultContract, functionName: 'isAllowedPayee', args: [chosen.id, payee] },
          { ...vaultContract, functionName: 'spentToday', args: [chosen.id] },
        ],
      });
      mandate = {
        id: chosen.id,
        executor: chosen.mandate.executor,
        approver: chosen.mandate.approver,
        revoked: chosen.mandate.revoked,
        validUntil: Number(chosen.mandate.validUntil),
        perPaymentCap: chosen.mandate.perPaymentCap,
        dailyCap: chosen.mandate.dailyCap,
        hardCeiling: chosen.mandate.hardCeiling,
        approvalNonce: chosen.mandate.approvalNonce,
        payeeAllowed,
        spentToday,
      };
    }

    return {
      blockNumber: block.number,
      blockTimestamp: timestamp,
      agent,
      mandate,
      vault: { paused: paused.result, balance: balance.result },
    };
  };

  const approvalState: ChainReader['approvalState'] = async (mandateId) => {
    const block = await client.getBlock({ blockTag: 'latest' });
    const mandate = await client.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: 'getMandate',
      args: [mandateId],
      blockNumber: block.number,
    });
    return { nonce: mandate.approvalNonce, blockTimestamp: Number(block.timestamp) };
  };

  return { info, snapshot, approvalState };
}
