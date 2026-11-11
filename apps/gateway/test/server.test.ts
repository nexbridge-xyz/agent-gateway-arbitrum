import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signIntent } from '../src/protocol/intent';
import { createApp } from '../src/server';
import { type Harness, createHarness } from './fakes';
import { DOMAIN, makeIntent } from './helpers';

let h: Harness;
let baseUrl: string;
let close: () => Promise<void>;

beforeEach(async () => {
  h = await createHarness();
  const app = createApp({
    gateway: h.gateway,
    chain: h.world,
    ledger: h.ledger,
    explorerTx: (hash) => `https://explorer.example/tx/${hash}`,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  await h.cleanup();
});

function post(body: unknown, raw = false) {
  return fetch(`${baseUrl}/v1/payment-intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function signedRequest() {
  return signIntent(
    h.world.agent,
    DOMAIN,
    makeIntent({ agentId: h.world.agentId.toString(), payee: h.world.vendorA }),
  );
}

describe('HTTP API', () => {
  it('POST /v1/payment-intents answers with the decision and an explorer link', async () => {
    const response = await post(await signedRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ decision: 'auto', status: 'paid', error: null });
    expect(body.explorerUrl).toBe(`https://explorer.example/tx/${String(body.transactionHash)}`);
  });

  it('answers 400 with the problems when the body is not a signed intent', async () => {
    const response = await post({ intent: { agentId: 'abc' }, signature: '0x00' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toMatch(/well-formed/);
    expect(body.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['intent.agentId', 'signature']),
    );
  });

  it('answers 400 for a body that is not JSON', async () => {
    const response = await post('{not json', true);
    expect(response.status).toBe(400);
  });

  it('answers 400 for a body that is too large', async () => {
    const response = await post({ blob: 'x'.repeat(100_000) });
    expect(response.status).toBe(400);
  });

  it('GET /v1/payment-intents/:id returns the evidence file', async () => {
    const outcome = (await (await post(await signedRequest())).json()) as {
      intentId: string;
      evidenceHash: string;
    };
    const response = await fetch(`${baseUrl}/v1/payment-intents/${outcome.intentId}`);
    expect(response.status).toBe(200);
    const file = (await response.json()) as { evidenceHash: string; record: { intentId: string } };
    expect(file.evidenceHash).toBe(outcome.evidenceHash);
    expect(file.record.intentId).toBe(outcome.intentId);
  });

  it('answers 404 for an unknown intent and 400 for something that is not an id', async () => {
    expect((await fetch(`${baseUrl}/v1/payment-intents/0x${'00'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/payment-intents/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
  });

  it('GET /v1/ledger returns the chain and its check', async () => {
    await post(await signedRequest());
    const body = (await (await fetch(`${baseUrl}/v1/ledger`)).json()) as {
      check: { ok: boolean; count: number };
      entries: unknown[];
    };
    expect(body.check).toMatchObject({ ok: true, count: 2 });
    expect(body.entries).toHaveLength(2);
  });

  it('GET /healthz reports the vault and the executor, and nothing secret', async () => {
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      chainId: 421_614,
      vault: DOMAIN.vault,
      executor: h.world.address,
    });
    expect(Object.keys(body).sort()).toEqual([
      'chainId',
      'executor',
      'ledger',
      'ok',
      'token',
      'vault',
    ]);
  });

  it('answers 404 for any other path and does not say what it runs on', async () => {
    const response = await fetch(`${baseUrl}/admin`);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});
