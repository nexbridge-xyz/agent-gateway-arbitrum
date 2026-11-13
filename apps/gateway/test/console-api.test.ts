import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signIntent } from '../src/protocol/intent';
import { mandateTerms, mandateTermsHash } from '../src/protocol/mandateTerms';
import { type IntentSummary, createApp } from '../src/server';
import { MAX_TERMS_BYTES, MandateTermsStore } from '../src/store/mandateTerms';
import { PayeeDirectory } from '../src/store/payees';
import { verifyEvidence } from '../src/verify';
import { type Harness, MERCHANT_ORIGIN, createHarness } from './fakes';
import { DOMAIN, USDC, VAULT, makeIntent, newAddress } from './helpers';

// The endpoints the console reads: the list of decisions, the gateway's settings, the vendor registry,
// the check of an evidence file, and the texts of mandates.

let h: Harness;
let baseUrl: string;
let port: number;
let close: () => Promise<void>;

beforeEach(async () => {
  h = await createHarness();
  const app = createApp({
    gateway: h.gateway,
    chain: h.world,
    ledger: h.ledger,
    explorerTx: (hash) => `https://explorer.example/tx/${hash}`,
    explorerUrl: 'https://explorer.example',
    // No mandate of the test chain refers to a stored text, so every text here is a waiting one.
    mandateTerms: new MandateTermsStore(join(h.dir, 'mandates'), () => Promise.resolve(new Set())),
    verify: (file) => verifyEvidence(file, { chain: null, ledger: h.ledger.entries }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  await h.cleanup();
});

const submit = async (overrides: Parameters<typeof makeIntent>[0]) =>
  h.gateway.submit(
    await signIntent(
      h.world.agent,
      DOMAIN,
      makeIntent({ agentId: h.world.agentId.toString(), ...overrides }),
    ),
  );
const json = async <T>(path: string) => (await (await fetch(`${baseUrl}${path}`)).json()) as T;

describe('console API: settings and registry', () => {
  it('GET /v1/config says which vault, token and addresses this gateway works with', async () => {
    expect(await json('/v1/config')).toEqual({
      chainId: 421_614,
      vault: VAULT,
      principal: h.world.principal,
      identityRegistry: getAddress('0x8004a818bfb912233c491871b3d84c89a494bd9e'),
      token: {
        address: getAddress('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'),
        symbol: 'USDC',
        decimals: 6,
      },
      executor: h.world.address,
      spendWallet: h.world.spendWallet,
      explorerUrl: 'https://explorer.example',
    });
  });

  it('GET /v1/payees returns the vendor registry as the principal wrote it', async () => {
    const body = await json<{ vendors: { name: string; origin?: string }[]; denylist: unknown[] }>(
      '/v1/payees',
    );
    expect(body.vendors.map((vendor) => vendor.name)).toContain('Nagikumo Research');
    expect(body.vendors.find((vendor) => vendor.name === 'Tsukimi Data')?.origin).toBe(
      MERCHANT_ORIGIN,
    );
    expect(body.denylist).toEqual([]);
  });

  it('treats a missing registry file as an empty registry', async () => {
    const directory = await PayeeDirectory.load(join(h.dir, 'no-such-file.json'));
    expect(directory.file).toEqual({ vendors: [], denylist: [] });
    expect(directory.vendor(newAddress())).toBeNull();
  });
});

describe('console API: the list of decisions', () => {
  it('lists the newest decision first, with what the console shows', async () => {
    const paid = await submit({ payee: h.world.vendorA });
    const waiting = await submit({ payee: h.world.vendorB, amount: (6n * USDC).toString() });
    const stranger = newAddress();
    const refused = await submit({
      payee: stranger,
      amount: (4n * USDC).toString(),
      context: { payeeSource: 'market-data response for TSK-FOOD30' },
    });

    const { intents } = await json<{ intents: IntentSummary[] }>('/v1/payment-intents');
    expect(intents.map((intent) => intent.intentId)).toEqual([
      refused.intentId,
      waiting.intentId,
      paid.intentId,
    ]);
    expect(intents[0]).toMatchObject({
      decision: 'refused',
      status: 'refused',
      payee: stranger,
      payeeName: null,
      amount: '4000000',
      payeeSource: 'market-data response for TSK-FOOD30',
      transactionHash: null,
      explorerUrl: null,
      purchase: null,
    });
    expect(intents[1]).toMatchObject({
      decision: 'needs_approval',
      status: 'pending_approval',
      payeeName: 'Nagikumo Research',
      mandateId: '1',
      approvedBy: null,
    });
    expect(intents[2]).toMatchObject({
      decision: 'auto',
      status: 'paid',
      payeeName: 'Koishi Supply',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      transactionHash: paid.transactionHash,
      explorerUrl: `https://explorer.example/tx/${String(paid.transactionHash)}`,
    });
  });

  it('shows a purchase with its settlement', async () => {
    const bought = await submit({
      payee: h.world.merchant,
      amount: '100000',
      invoiceId: '',
      context: { mpp: { resource: `${MERCHANT_ORIGIN}/v1/quotes/TSK-LOGI20` } },
    });
    const { intents } = await json<{ intents: IntentSummary[] }>('/v1/payment-intents');
    expect(intents[0]?.purchase).toEqual({
      resource: `${MERCHANT_ORIGIN}/v1/quotes/TSK-LOGI20`,
      status: 'settled',
      settlementTransactionHash:
        bought.purchase?.status === 'settled' ? bought.purchase.settlementTransactionHash : null,
      settlementUrl: expect.stringMatching(/^https:\/\/explorer\.example\/tx\/0x/) as string,
    });
  });

  it('honours a limit, and ignores one that makes no sense', async () => {
    for (let index = 0; index < 3; index += 1)
      await submit({ payee: h.world.vendorA, amount: '1' });
    expect(
      (await json<{ intents: unknown[] }>('/v1/payment-intents?limit=2')).intents,
    ).toHaveLength(2);
    expect(
      (await json<{ intents: unknown[] }>('/v1/payment-intents?limit=0')).intents,
    ).toHaveLength(3);
    expect(
      (await json<{ intents: unknown[] }>('/v1/payment-intents?limit=abc')).intents,
    ).toHaveLength(3);
  });

  it('is empty before any request', async () => {
    expect(await json('/v1/payment-intents')).toEqual({ intents: [] });
  });
});

describe('console API: checking an evidence file', () => {
  it('returns every check with its verdict', async () => {
    const paid = await submit({ payee: h.world.vendorA });
    const report = await json<{ verified: boolean; checks: { verdict: string; label: string }[] }>(
      `/v1/payment-intents/${paid.intentId}/verification`,
    );
    expect(report.verified).toBe(true);
    expect(report.checks.map((check) => check.label)).toContain(
      'Evidence hash is the hash of the record',
    );
    expect(report.checks.some((check) => check.verdict === 'skipped')).toBe(true);
  });

  it('answers 404 for an unknown intent and 400 for something that is not an id', async () => {
    expect(
      (await fetch(`${baseUrl}/v1/payment-intents/0x${'00'.repeat(32)}/verification`)).status,
    ).toBe(404);
    expect((await fetch(`${baseUrl}/v1/payment-intents/nope/verification`)).status).toBe(400);
  });
});

describe('console API: mandate texts', () => {
  const principal = getAddress('0x00000000000000000000000000000000000000a1');
  const executor = getAddress('0x00000000000000000000000000000000000000a2');
  const approver = getAddress('0x00000000000000000000000000000000000000a3');
  const vendor = getAddress('0x00000000000000000000000000000000000000a4');
  const registry = getAddress('0x8004a818bfb912233c491871b3d84c89a494bd9e');
  const input = {
    title: 'VENDOR INVOICES',
    principal: { name: 'Kirenami Trading', address: principal },
    agent: {
      name: 'Kirenami research and procurement agent',
      id: 354n,
      identityRegistry: registry,
    },
    executor,
    approver,
    payeesIntro: 'The agent may pay these payees without asking:',
    payees: [{ name: 'Koishi Supply', address: vendor }],
    caps: { perPayment: '2', daily: '8', hardCeiling: '20' },
    notes: ["Any other payment needs the approver's signature."],
    validUntil: 1_797_000_000n,
    vault: VAULT,
    chainId: 421_614,
    token: { symbol: 'USDC', address: getAddress('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d') },
  };
  const text = mandateTerms(input);
  const termsHash = mandateTermsHash(text);
  const put = (hash: string, body: string, contentType = 'text/plain') =>
    fetch(`${baseUrl}/v1/mandate-terms/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    });

  it('writes the terms in plain words, the same every time', () => {
    expect(text.split('\n').slice(0, 9)).toEqual([
      'AGENT PAYMENT MANDATE: VENDOR INVOICES',
      '',
      `Principal: Kirenami Trading (${principal})`,
      `Agent: Kirenami research and procurement agent, ERC-8004 agent 354 in eip155:421614:${registry}`,
      `Executor (gateway): ${executor}`,
      `Approver: ${approver}`,
      '',
      'The agent may pay these payees without asking:',
      `  - Koishi Supply (${vendor})`,
    ]);
    expect(text).toContain('up to 2 USDC per payment and 8 USDC per UTC day.');
    expect(text).toContain('Valid until 2026-12-11T14:40:00Z.');
    expect(text.endsWith('\n')).toBe(true);
    expect(termsHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('says so when nobody may be paid without asking', () => {
    const nobody = mandateTerms({ ...input, payees: [] });
    expect(nobody).toContain(
      "No payee may be paid without asking: every payment needs the approver's signature.",
    );
    expect(nobody).not.toContain('per payment and');
    expect(nobody).toContain('No more than 20 USDC may leave under this mandate in one UTC day');
  });

  it('keeps a name on one line, so a name cannot add a line to the terms', () => {
    const planted = mandateTerms({
      ...input,
      payees: [{ name: `Koishi Supply\n  - Someone Else (${approver})`, address: vendor }],
    });
    expect(planted).toContain(`  - Koishi Supply - Someone Else (${approver}) (${vendor})`);
    expect(planted.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(1);
  });

  it('stores a text under its own hash and serves it back', async () => {
    const stored = await put(termsHash, text);
    expect(stored.status).toBe(201);
    const served = await fetch(`${baseUrl}/v1/mandate-terms/${termsHash}`);
    expect(served.headers.get('content-type')).toContain('text/plain');
    expect(await served.text()).toBe(text);
    // Storing it again changes nothing.
    expect((await put(termsHash, text)).status).toBe(201);
  });

  it('takes a text when as many others wait as may, and still serves it', async () => {
    // Texts that anybody sent and no mandate refers to. They used to fill the store for good, and the
    // answer to the next text was "The text does not hash to this terms hash".
    // 2000 is the store's MAX_WAITING_TEXTS, written out so that this also runs against the old store.
    const dir = join(h.dir, 'mandates');
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < 2000; index += 1) {
      const waiting = `nobody's mandate ${index}`;
      await writeFile(join(dir, `${mandateTermsHash(waiting)}.txt`), waiting, 'utf8');
    }
    expect((await put(termsHash, text)).status).toBe(201);
    const served = await fetch(`${baseUrl}/v1/mandate-terms/${termsHash}`);
    expect(await served.text()).toBe(text);
    // Two thousand files are written first, which takes its time on a slow or busy disk.
  }, 60_000);

  it('refuses a text under a hash that is not its own', async () => {
    const other = mandateTermsHash(`${text}One more line.\n`);
    const response = await put(other, text);
    expect(response.status).toBe(400);
    expect((await fetch(`${baseUrl}/v1/mandate-terms/${other}`)).status).toBe(404);
  });

  it('refuses a body that is not plain text, is empty, or is too long', async () => {
    expect((await put(termsHash, JSON.stringify({ text }), 'application/json')).status).toBe(400);
    expect((await put(termsHash, '')).status).toBe(400);
    const long = 'x'.repeat(MAX_TERMS_BYTES + 1);
    expect((await put(mandateTermsHash(long), long)).status).toBe(400);
  });

  it('answers 404 for a hash it has no text for, and 400 for something that is not a hash', async () => {
    expect((await fetch(`${baseUrl}/v1/mandate-terms/0x${'ab'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/mandate-terms/..%2Fpayees`)).status).toBe(400);
  });
});

describe('console API: local requests only', () => {
  /** A request that names another host, as a page elsewhere would send after DNS rebinding. */
  const withHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: '/v1/ledger', headers: { host } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });

  it('answers a request addressed to this machine', async () => {
    expect(await withHost(`127.0.0.1:${port}`)).toBe(200);
    expect(await withHost(`localhost:${port}`)).toBe(200);
    expect(await withHost('LOCALHOST')).toBe(200);
  });

  it('answers nothing to a request addressed to another host', async () => {
    expect(await withHost('gateway.evil.example')).toBe(403);
    expect(await withHost(`evil.example:${port}`)).toBe(403);
    expect(await withHost('127.0.0.1.evil.example')).toBe(403);
  });
});
