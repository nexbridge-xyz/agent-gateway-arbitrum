import { type IncomingMessage, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { IntentDomain, SignedIntent } from '@agent-gateway/gateway/protocol';
import { createMerchantApp } from '@agent-gateway/merchant';

import { type AgentToolsOptions, type GatewayAnswer, createAgentTools } from '../src/index';

export const newAccount = () => privateKeyToAccount(generatePrivateKey());

export const DOMAIN: IntentDomain = {
  chainId: 421_614,
  vault: getAddress('0x7293763f6b73783834484cd976528d01cb6c8ccf'),
};

/** 2026-11-17 03:00:00 UTC. */
export const NOW = 1_794_884_400;

const closers: (() => Promise<void>)[] = [];

/** Closes every server a test started. */
export async function closeAll(): Promise<void> {
  await Promise.all(closers.splice(0).map((close) => close()));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function answer(overrides: Partial<GatewayAnswer> = {}): GatewayAnswer {
  return {
    intentId: `0x${'11'.repeat(32)}`,
    decision: 'auto',
    status: 'paid',
    reasons: ['All 14 checks passed'],
    evidenceHash: `0x${'22'.repeat(32)}`,
    transactionHash: `0x${'33'.repeat(32)}`,
    explorerUrl: `https://explorer.example/tx/0x${'33'.repeat(32)}`,
    settlementUrl: null,
    error: null,
    purchase: null,
    ...overrides,
  };
}

/** A stand-in for the gateway: records what it is asked and answers what the test tells it to. */
export async function startGateway(
  reply: (signed: SignedIntent) => { status?: number; body: unknown } = () => ({ body: answer() }),
) {
  const received: SignedIntent[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const signed = (await body(request)) as SignedIntent;
      received.push(signed);
      const { status = 200, body: payload } = reply(signed);
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(payload));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/** The demo merchant, up to the point where it asks for payment. It never reaches a chain here. */
export async function startMerchant() {
  const account = newAccount();
  const app = createMerchantApp({
    account,
    rpcUrl: 'http://127.0.0.1:9',
    secretKey: 'agent-test-secret-'.repeat(2),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, account };
}

/** An address nothing listens on. */
export const NOWHERE = 'http://127.0.0.1:9';

export function makeTools(
  options: Partial<AgentToolsOptions> & Pick<AgentToolsOptions, 'gatewayUrl' | 'merchantUrl'>,
) {
  const account = options.account ?? newAccount();
  const tools = createAgentTools({
    account,
    agentId: 354n,
    domain: DOMAIN,
    token: { symbol: 'USDC', decimals: 6 },
    now: () => NOW,
    ...options,
  });
  return { tools, account };
}
