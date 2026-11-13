import { readdir } from 'node:fs/promises';

import { type Hex, createPublicClient, getAddress, http } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import deployment from '@agent-gateway/contracts/deployments/arbitrum-sepolia.json' with { type: 'json' };

import { mandateVaultAbi } from '../../src/chain/abis';
import { createTermsInUse } from '../../src/chain/termsInUse';

/**
 * Review, on a local fork of Arbitrum Sepolia: the gateway keeps the text of every mandate in the vault.
 * This reads the terms hashes from the deployed vault as the gateway does, and checks that the texts of
 * the recorded run are among them.
 *
 *   anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc --port 8546
 *   REVIEW_FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @agent-gateway/gateway exec vitest run test/review/mandate-texts-in-the-vault.fork.test.ts
 *
 * Nothing is sent to a live network: the test only reads, and only from the local fork.
 */
const fork = process.env.REVIEW_FORK_RPC_URL;
const recorded = new URL('../../../../docs/sepolia-run/mandates/', import.meta.url);

describe.skipIf(fork === undefined)(
  'review, on a fork: mandate texts and the deployed vault',
  () => {
    it('finds the terms hash of every mandate, the recorded run’s among them', async () => {
      const client = createPublicClient({ chain: arbitrumSepolia, transport: http(fork) });
      const vault = getAddress(deployment.contracts.MandateVault.address);
      const inUse = await createTermsInUse(client, vault)();

      const count = await client.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: 'mandateCount',
      });
      expect(count).toBeGreaterThanOrEqual(4n);
      // Read once more, one mandate at a time, as somebody checking by hand would.
      const hashes = new Set<Hex>();
      for (let id = 1n; id <= count; id += 1n) {
        const mandate = await client.readContract({
          address: vault,
          abi: mandateVaultAbi,
          functionName: 'getMandate',
          args: [id],
        });
        hashes.add(mandate.termsHash);
      }
      expect(inUse).toEqual(hashes);

      // docs/sepolia-run/mandates holds one file per mandate of the recorded run, named after its hash.
      const texts = (await readdir(recorded)).map((name) => name.replace(/\.txt$/, '') as Hex);
      expect(texts.length).toBeGreaterThan(0);
      for (const termsHash of texts) expect(inUse.has(termsHash)).toBe(true);
      // A fork fetches each piece of state from the public endpoint the first time it is read.
    }, 120_000);
  },
);
