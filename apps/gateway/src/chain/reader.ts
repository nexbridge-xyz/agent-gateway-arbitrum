import {
  type Address,
  type Hex,
  type PublicClient,
  erc20Abi,
  isAddressEqual,
  parseAbi,
  zeroAddress,
} from 'viem';

import type { MandateFacts } from '../policy/evaluate';
import { identityRegistryAbi, mandateVaultAbi } from './abis';
import { chooseMandate, listsPayee } from './mandates';
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

/**
 * What an approver's address answers when it has code: `no-code` for a plain key, otherwise whether
 * the code confirmed the signature.
 */
export type ApproverCodeAnswer = 'no-code' | 'confirmed' | 'not-confirmed';

const erc1271Abi = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);
const ERC1271_CONFIRMED = '0x1626ba7e';

export interface ChainReader {
  info(): Promise<ChainInfo>;
  /**
   * `payee` is the address the vault would pay. It decides which of the agent's mandates applies,
   * unless `mandateId` names the mandate a waiting request was decided under.
   */
  snapshot(query: {
    agentId: bigint;
    payee: Address;
    executor: Address;
    mandateId?: bigint | undefined;
  }): Promise<Snapshot>;
  /** The nonce the next approval for this mandate must carry, and the current block time. */
  approvalState(mandateId: bigint): Promise<{ nonce: bigint; blockTimestamp: number }>;
  /**
   * Asks the approver's address about a signature the way the vault will. The vault's rule
   * (OpenZeppelin SignatureChecker): an address without code must have signed with its key. An
   * address with code, which is a smart account or a key with an EIP-7702 delegation, is asked
   * through ERC-1271 instead, and its key's signature alone does not count.
   */
  askApproverCode(approver: Address, digest: Hex, signature: Hex): Promise<ApproverCodeAnswer>;
}

/** How many of the newest mandates are searched for the agent's mandates. */
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

  const snapshot: ChainReader['snapshot'] = async ({ agentId, payee, executor, mandateId }) => {
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

    // Read the agent's mandates, newest first, and choose the one this request falls under.
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
      .map((mandate, index) => ({
        ...mandate,
        id: ids[index] as bigint,
        validUntil: Number(mandate.validUntil),
      }))
      .filter((candidate) => candidate.agentId === agentId);
    const chosen = chooseMandate(candidates, { payee, executor, now: timestamp, mandateId });

    let mandate: MandateFacts | null = null;
    if (chosen !== null) {
      const spentToday = await client.readContract({
        ...vaultContract,
        ...at,
        functionName: 'spentToday',
        args: [chosen.id],
      });
      mandate = {
        id: chosen.id,
        executor: chosen.executor,
        approver: chosen.approver,
        revoked: chosen.revoked,
        validUntil: chosen.validUntil,
        perPaymentCap: chosen.perPaymentCap,
        dailyCap: chosen.dailyCap,
        hardCeiling: chosen.hardCeiling,
        approvalNonce: chosen.approvalNonce,
        // The allowlist is fixed when the mandate is created, so the list is the whole truth.
        payeeAllowed: listsPayee(chosen, payee),
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

  const askApproverCode: ChainReader['askApproverCode'] = async (approver, digest, signature) => {
    const code = await client.getCode({ address: approver });
    if (code === undefined || code === '0x') return 'no-code';
    try {
      const answer = await client.readContract({
        address: approver,
        abi: erc1271Abi,
        functionName: 'isValidSignature',
        args: [digest, signature],
      });
      return answer === ERC1271_CONFIRMED ? 'confirmed' : 'not-confirmed';
    } catch {
      // The code does not speak ERC-1271, or it reverted. The vault takes both as a no.
      return 'not-confirmed';
    }
  };

  return { info, snapshot, approvalState, askApproverCode };
}
