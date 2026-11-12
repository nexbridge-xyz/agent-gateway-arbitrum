import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '../src/gateway';
import { APPROVAL_DECLINE_TYPES, PAYMENT_APPROVAL_TYPES } from '../src/protocol/approval';
import { signIntent } from '../src/protocol/intent';
import { createApp } from '../src/server';
import { type Harness, MERCHANT_ORIGIN, createHarness } from './fakes';
import { DOMAIN, USDC, makeIntent, newAccount } from './helpers';

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
      'spendWallet',
      'token',
      'vault',
    ]);
    expect(body.spendWallet).toBe(h.world.spendWallet);
  });

  it('answers 404 for any other path and does not say what it runs on', async () => {
    const response = await fetch(`${baseUrl}/admin`);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});

describe('HTTP API: approvals', () => {
  const json = { 'content-type': 'application/json' };

  async function waiting(): Promise<PendingApproval> {
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.vendorB,
      amount: (6n * USDC).toString(),
      purpose: 'Invoice NR-2026-0042: quarterly research report',
      invoiceId: 'NR-2026-0042',
    });
    const response = await post(await signIntent(h.world.agent, DOMAIN, intent));
    expect(await response.json()).toMatchObject({
      decision: 'needs_approval',
      status: 'pending_approval',
    });
    const list = (await (await fetch(`${baseUrl}/v1/approvals`)).json()) as {
      approvals: PendingApproval[];
    };
    expect(list.approvals).toHaveLength(1);
    return list.approvals[0] as PendingApproval;
  }

  /** What an approver's wallet does with the JSON the gateway serves. */
  function signApproval(pending: PendingApproval, account = h.world.approverAccount) {
    const { message } = pending.approval;
    return account.signTypedData({
      domain: pending.approval.domain,
      types: PAYMENT_APPROVAL_TYPES,
      primaryType: 'PaymentApproval',
      message: {
        mandateId: BigInt(message.mandateId),
        payee: message.payee,
        amount: BigInt(message.amount),
        evidenceHash: message.evidenceHash,
        nonce: BigInt(message.nonce),
        deadline: BigInt(message.deadline),
      },
    });
  }

  const approve = (intentId: string, body: unknown) =>
    fetch(`${baseUrl}/v1/approvals/${intentId}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify(body),
    });

  it('GET /v1/approvals is empty when nothing waits', async () => {
    expect(await (await fetch(`${baseUrl}/v1/approvals`)).json()).toEqual({ approvals: [] });
  });

  it('GET /v1/approvals serves typed data that survives JSON', async () => {
    const pending = await waiting();
    expect(pending.approval.primaryType).toBe('PaymentApproval');
    expect(pending.approval.message).toMatchObject({
      mandateId: '1',
      amount: '6000000',
      nonce: '0',
    });
    expect(pending.payeeName).toBe('Nagikumo Research');
  });

  it('POST /v1/approvals/:id pays with the approver signature and links the transaction', async () => {
    const pending = await waiting();
    const response = await approve(pending.intentId, {
      signature: await signApproval(pending),
      deadline: pending.approval.message.deadline,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ decision: 'needs_approval', status: 'paid', error: null });
    expect(body.explorerUrl).toBe(`https://explorer.example/tx/${String(body.transactionHash)}`);
    expect(h.world.payments.map((payment) => payment.event)).toEqual(['ApprovedPayment']);
  });

  it('answers 400 for a signature that is not the approver, and pays nothing', async () => {
    const pending = await waiting();
    const response = await approve(pending.intentId, {
      signature: await signApproval(pending, h.world.executorAccount),
      deadline: pending.approval.message.deadline,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "not the approver's signature",
    );
    expect(h.world.payments).toHaveLength(0);
  });

  it('answers 400 for a malformed approval, 404 for an unknown intent, 409 once it is paid', async () => {
    const pending = await waiting();
    expect((await approve(pending.intentId, { signature: '0x12' })).status).toBe(400);
    expect(
      (
        await approve(pending.intentId, {
          signature: await signApproval(pending),
          deadline: '1',
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect((await approve('not-an-id', {})).status).toBe(400);

    const body = {
      signature: await signApproval(pending),
      deadline: pending.approval.message.deadline,
    };
    expect((await approve(`0x${'00'.repeat(32)}`, body)).status).toBe(404);
    expect((await approve(pending.intentId, body)).status).toBe(200);
    expect((await approve(pending.intentId, body)).status).toBe(409);
    expect(h.world.payments).toHaveLength(1);
  });

  it('answers 409 with the reasons when the payment can no longer be made', async () => {
    const pending = await waiting();
    h.world.mandate!.revoked = true;
    const response = await approve(pending.intentId, {
      signature: await signApproval(pending),
      deadline: pending.approval.message.deadline,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The payment can no longer be made',
      reasons: ['Mandate 1 has been revoked'],
    });
  });

  it('POST /v1/approvals/:id/decline records a signed decline', async () => {
    const pending = await waiting();
    const decline = (signature: string) =>
      fetch(`${baseUrl}/v1/approvals/${pending.intentId}/decline`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ signature }),
      });
    const sign = (account: ReturnType<typeof newAccount>) =>
      account.signTypedData({
        domain: pending.decline.domain,
        types: APPROVAL_DECLINE_TYPES,
        primaryType: 'ApprovalDecline',
        message: pending.decline.message,
      });

    expect((await decline(await sign(newAccount()))).status).toBe(400);
    const response = await decline(await sign(h.world.approverAccount));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'declined',
      transactionHash: null,
      explorerUrl: null,
    });
    expect(await (await fetch(`${baseUrl}/v1/approvals`)).json()).toEqual({ approvals: [] });
  });
});

describe('HTTP API: per-call purchases', () => {
  it('returns the data with links to the top-up and to the settlement', async () => {
    const intent = makeIntent({
      agentId: h.world.agentId.toString(),
      payee: h.world.merchant,
      amount: '100000',
      purpose: 'Market data: TSK-LOGI20 quote',
      invoiceId: '',
      context: { mpp: { resource: `${MERCHANT_ORIGIN}/v1/quotes/TSK-LOGI20` } },
    });
    const response = await post(await signIntent(h.world.agent, DOMAIN, intent));
    const body = (await response.json()) as Record<string, unknown> & {
      purchase: { settlementTransactionHash: string };
    };

    expect(body).toMatchObject({
      decision: 'auto',
      status: 'paid',
      data: { symbol: 'TSK-LOGI20' },
    });
    expect(body.explorerUrl).toBe(`https://explorer.example/tx/${String(body.transactionHash)}`);
    expect(body.settlementUrl).toBe(
      `https://explorer.example/tx/${body.purchase.settlementTransactionHash}`,
    );
  });
});
