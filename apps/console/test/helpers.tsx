import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Address } from 'viem';
import { vi } from 'vitest';
import { type Config, WagmiProvider, createConfig, http } from 'wagmi';
import { arbitrumSepolia } from 'wagmi/chains';
import { mock } from 'wagmi/connectors';

import type { wagmiConfig } from '@/lib/wallet';

/** Where the test's stand-in for an RPC node is addressed. Nothing listens there: `bridge` answers. */
export const RPC_URL = 'http://rpc.test/';
const chain = { ...arbitrumSepolia, rpcUrls: { default: { http: [RPC_URL] } } } as const;

/**
 * A wallet setup for a test. Each address becomes a wallet the page can connect; the wallet passes
 * signing and sending on to the stand-in node, as a browser wallet passes them on to its own keys.
 */
export function testConfig(accounts: Address[] = []): Config {
  return createConfig({
    chains: [chain],
    connectors: accounts.map((account) => mock({ accounts: [account] })),
    transports: { [chain.id]: http() },
  });
}

/** Renders a piece of the console inside what the app wraps around it. */
export function show(ui: ReactElement, config: Config = testConfig()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    // The app registers its own wallet setup as the one type of setup. A test's setup differs only in
    // which wallets it offers.
    <WagmiProvider config={config as unknown as typeof wagmiConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </WagmiProvider>,
  );
  return { config, queryClient, ...view };
}

export type RpcCall = { method: string; params: unknown[] };
type RpcHandler = (params: unknown[]) => unknown;
type RpcBody = { id: number; method: string; params?: unknown[] };

/** A stand-in for an RPC node: answers the methods it is given, and keeps what it was asked. */
export function fakeNode(handlers: Record<string, RpcHandler>) {
  const calls: RpcCall[] = [];
  const answer = async (body: RpcBody) => {
    const params = body.params ?? [];
    calls.push({ method: body.method, params });
    const handler = handlers[body.method];
    if (handler === undefined) {
      const message = `the test node does not answer ${body.method}`;
      return { jsonrpc: '2.0', id: body.id, error: { code: -32_601, message } };
    }
    try {
      return { jsonrpc: '2.0', id: body.id, result: await handler(params) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed';
      return { jsonrpc: '2.0', id: body.id, error: { code: -32_000, message } };
    }
  };
  return {
    calls,
    sent: (method: string) => calls.filter((call) => call.method === method),
    async respond(text: string): Promise<Response> {
      const body = JSON.parse(text) as RpcBody | RpcBody[];
      const result = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

/**
 * Replaces `fetch` for a test. Requests to the gateway (paths starting with /) go to `gatewayUrl`, a
 * gateway running in this process, or fail as an unreachable gateway does. Requests to the RPC address
 * go to the stand-in node. Anything else is a mistake in the test.
 */
export function bridge(options: { gatewayUrl?: string; node?: ReturnType<typeof fakeNode> }) {
  const real = globalThis.fetch;
  const requests: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.startsWith(RPC_URL)) {
        if (options.node === undefined || typeof init?.body !== 'string')
          throw new TypeError('fetch failed');
        return options.node.respond(init.body);
      }
      if (url.startsWith('/')) {
        if (options.gatewayUrl === undefined) throw new TypeError('fetch failed');
        return real(`${options.gatewayUrl}${url}`, init);
      }
      throw new Error(`The test did not expect a request to ${url}`);
    },
  );
  return { requests };
}
