import { type Chain, isAddress } from 'viem';
import { type CreateConnectorFn, createConfig, http } from 'wagmi';
import { arbitrumSepolia } from 'wagmi/chains';
import { injected, mock } from 'wagmi/connectors';

/**
 * Wallet and chain settings.
 *
 * The console reads the vault from Arbitrum Sepolia and asks a browser wallet for signatures: the
 * principal's for creating and revoking mandates, the approver's for approvals. It never holds a key.
 */

const rpcUrl = (import.meta.env.VITE_RPC_URL as string | undefined) || undefined;
const localNode = rpcUrl !== undefined && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rpcUrl);

/**
 * Arbitrum Sepolia, read through VITE_RPC_URL if that is set. A local fork of the network keeps its
 * chain id, so the same definition serves both.
 */
export const chain: Chain =
  rpcUrl === undefined
    ? arbitrumSepolia
    : { ...arbitrumSepolia, rpcUrls: { default: { http: [rpcUrl] } } };

/**
 * Test wallets, for rehearsing on a local Anvil node without a browser wallet. Each entry names a
 * role and an address the node can sign for, as "principal:0x…,approver:0x…". They exist only in a
 * development build that points at a local node; a production build ignores the setting.
 */
function testWallets(): CreateConnectorFn[] {
  const setting = (import.meta.env.VITE_TEST_WALLETS as string | undefined) ?? '';
  if (!import.meta.env.DEV || !localNode || setting === '') return [];

  return setting.split(',').flatMap((entry) => {
    const [role = '', address = ''] = entry.trim().split(':');
    if (!/^[a-z]{1,20}$/.test(role) || !isAddress(address)) {
      // A mistyped address fails its checksum. Say so, or the wallet is silently missing.
      console.warn(
        `VITE_TEST_WALLETS: "${entry.trim()}" is not a role and a valid address. Left out.`,
      );
      return [];
    }
    const base = mock({ accounts: [address], features: { reconnect: true } });
    // The node signs: the connector passes signing requests on to the chain's RPC address, which is the
    // local node here.
    const connector: CreateConnectorFn = (config) => ({
      ...base(config),
      id: `test-${role}`,
      name: `Test wallet: ${role}`,
    });
    return [connector];
  });
}

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected(), ...testWallets()],
  transports: { [chain.id]: http() },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
