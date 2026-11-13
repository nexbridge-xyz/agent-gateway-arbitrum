import type { Address, Hex, PublicClient } from 'viem';

import type { TermsInUse } from '../store/mandateTerms';
import { mandateVaultAbi } from './abis';

/** How many mandates are read in one call to the node. */
const BATCH = 200;

/**
 * Reads the terms hash of every mandate in the vault. A mandate keeps its terms hash and is never
 * removed, revoked or not. So each mandate is read once, and a later call reads only the mandates
 * created since.
 */
export function createTermsInUse(client: PublicClient, vault: Address): TermsInUse {
  const hashes = new Set<Hex>();
  /** The highest mandate id read so far. Ids start at 1. */
  let read = 0n;

  return async () => {
    const count = await client.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: 'mandateCount',
    });
    while (read < count) {
      const ids: bigint[] = [];
      for (let id = read + 1n; id <= count && ids.length < BATCH; id += 1n) ids.push(id);
      const mandates = await client.multicall({
        allowFailure: false,
        contracts: ids.map((id) => ({
          address: vault,
          abi: mandateVaultAbi,
          functionName: 'getMandate' as const,
          args: [id] as const,
        })),
      });
      for (const mandate of mandates) hashes.add(mandate.termsHash);
      // Two calls at once read the same ids. Neither may move the mark past what was read.
      const last = ids.at(-1) as bigint;
      if (last > read) read = last;
    }
    return hashes;
  };
}
