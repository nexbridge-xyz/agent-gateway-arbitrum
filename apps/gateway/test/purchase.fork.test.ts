import type { AddressInfo } from 'node:net';

import {
  type Address,
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  isAddressEqual,
  keccak256,
  parseEther,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { USDC_ARBITRUM_SEPOLIA, createMerchantApp } from '@agent-gateway/merchant';

import { PurchaseError, createPurchaseClient } from '../src/chain/purchases';

/**
 * A real purchase over MPP between the gateway's spend wallet and the demo merchant, on a local fork
 * of Arbitrum Sepolia. Runs only when a fork is given:
 *
 *   anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc --port 8546
 *   MPP_FORK_RPC_URL=http://127.0.0.1:8546 pnpm --filter @agent-gateway/gateway test
 *
 * Use a fresh fork. The public RPC keeps state for recent blocks only, so a fork that has been running
 * for an hour or so starts to fail with "historical state is not available".
 */
const fork = process.env.MPP_FORK_RPC_URL;
// The suite is collected even when it is skipped, and a client needs some address to be built.
const rpcUrl = fork ?? 'http://127.0.0.1:8546';

describe.skipIf(fork === undefined)('purchase over MPP on an Arbitrum Sepolia fork', () => {
  const merchant = privateKeyToAccount(generatePrivateKey());
  const spendWallet = privateKeyToAccount(generatePrivateKey());
  const chainId = 421_614;
  const token = USDC_ARBITRUM_SEPOLIA;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const anvil = createTestClient({ mode: 'anvil', transport: http(rpcUrl) });

  let origin = '';
  let close: () => Promise<void> = () => Promise.resolve();
  const sold: string[] = [];

  const balanceOf = (owner: Address) =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    });

  /** Gives `owner` test USDC by writing its balance into the token's storage (FiatToken keeps balances in slot 9). */
  async function setUsdc(owner: Address, amount: bigint) {
    const slot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, 9n]),
    );
    await anvil.setStorageAt({ address: token, index: slot, value: toHex(amount, { size: 32 }) });
  }

  beforeAll(async () => {
    expect(await client.getChainId()).toBe(chainId);
    await anvil.setBalance({ address: merchant.address, value: parseEther('0.01') });
    await setUsdc(spendWallet.address, 300_000n);

    const app = createMerchantApp({
      account: merchant,
      rpcUrl: rpcUrl,
      secretKey: 'fork-test-secret-'.repeat(3),
      log: (line) => sold.push(line),
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await close();
  });

  it('pays 0.10 USDC from the spend wallet to the merchant and gets the quote', async () => {
    const purchases = createPurchaseClient(spendWallet, { rpcUrl: rpcUrl });
    const purchase = await purchases.buy({
      resource: `${origin}/v1/quotes/TSK-LOGI20`,
      merchant: merchant.address,
      amount: 100_000n,
      token,
      chainId,
    });

    expect(purchase.body).toMatchObject({ symbol: 'TSK-LOGI20', vendor_note: null });
    expect(purchase.settlementTransactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await balanceOf(spendWallet.address)).toBe(200_000n);
    expect(await balanceOf(merchant.address)).toBe(100_000n);

    // The receipt names a real transaction: the merchant submitted the transfer and paid the gas.
    const receipt = await client.getTransactionReceipt({
      hash: purchase.settlementTransactionHash,
    });
    expect(receipt.status).toBe('success');
    expect(isAddressEqual(receipt.from, merchant.address)).toBe(true);
    // The spend wallet never sent a transaction.
    expect(await client.getTransactionCount({ address: spendWallet.address })).toBe(0);
    expect(sold).toEqual(['sold one TSK-LOGI20 quote']);
  }, 120_000);

  it.each<[string, { merchant?: Address; amount?: bigint; token?: Address }]>([
    ['a lower price than the merchant asks', { amount: 99_999n }],
    ['a higher price than the merchant asks', { amount: 100_001n }],
    [
      'another merchant than the one that answers',
      { merchant: privateKeyToAccount(generatePrivateKey()).address },
    ],
    ['another token', { token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' }],
  ])(
    'signs nothing when the gateway approved %s',
    async (_name, approved) => {
      const purchases = createPurchaseClient(spendWallet, { rpcUrl: rpcUrl });
      const before = await balanceOf(spendWallet.address);
      const soldBefore = sold.length;

      await expect(
        purchases.buy({
          resource: `${origin}/v1/quotes/TSK-LOGI20`,
          merchant: merchant.address,
          amount: 100_000n,
          token,
          chainId,
          ...approved,
        }),
      ).rejects.toThrow(PurchaseError);

      expect(await balanceOf(spendWallet.address)).toBe(before);
      expect(sold).toHaveLength(soldBefore);
    },
    120_000,
  );

  it('fails cleanly when the spend wallet is empty, and gets no data', async () => {
    const empty = privateKeyToAccount(generatePrivateKey());
    const purchases = createPurchaseClient(empty, { rpcUrl: rpcUrl });
    const soldBefore = sold.length;
    await expect(
      purchases.buy({
        resource: `${origin}/v1/quotes/TSK-LOGI20`,
        merchant: merchant.address,
        amount: 100_000n,
        token,
        chainId,
      }),
    ).rejects.toThrow(
      'the purchase request failed: Insufficient funds to submit credential. Funds: 0 Required funds: 100000',
    );
    expect(sold).toHaveLength(soldBefore);
  }, 120_000);

  it('reports what the merchant said when it sells no such thing', async () => {
    const purchases = createPurchaseClient(spendWallet, { rpcUrl: rpcUrl });
    await expect(
      purchases.buy({
        resource: `${origin}/v1/quotes/NOPE`,
        merchant: merchant.address,
        amount: 100_000n,
        token,
        chainId,
      }),
    ).rejects.toThrow('the merchant answered 404 and asked for no payment');
  }, 120_000);
});
