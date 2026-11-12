import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Address, Hex } from 'viem';
import { ZodError } from 'zod';

import type { ChainReader } from './chain/reader';
import { RequestError } from './errors';
import type { Gateway, IntentOutcome } from './gateway';
import type { EvidenceFile } from './protocol/evidence';
import type { Ledger, LedgerCheck, LedgerEntry } from './store/ledger';
import { MAX_TERMS_BYTES, type MandateTermsStore } from './store/mandateTerms';
import type { PayeesFile } from './store/payees';
import type { VerifyCheck, VerifyReport } from './verify';

export type AppOptions = {
  gateway: Gateway;
  chain: ChainReader;
  ledger: Ledger;
  /** Turns a transaction hash into a block explorer link. */
  explorerTx?: (hash: Hex) => string;
  /** The block explorer's address, for the console's links. */
  explorerUrl?: string;
  /** Checks an evidence file against the chain and the ledger. Without it the check is not offered. */
  verify?: (file: EvidenceFile) => Promise<VerifyReport>;
  /** The plain-text terms of mandates. Without it the texts are not offered. */
  mandateTerms?: MandateTermsStore;
};

/*
 * The JSON this API answers with. The console takes its types from here, so the two cannot drift
 * apart. Amounts and ids are decimal strings; nothing here is secret.
 */

/** GET /v1/config */
export type ConfigResponse = {
  chainId: number;
  vault: Address;
  principal: Address;
  identityRegistry: Address;
  token: { address: Address; symbol: string; decimals: number };
  executor: Address;
  /** Null when the gateway has no spend wallet and so cannot buy per call. */
  spendWallet: Address | null;
  explorerUrl: string | null;
};

/** POST /v1/payment-intents, POST /v1/approvals/:intentId and its /decline */
export type OutcomeResponse = IntentOutcome & {
  explorerUrl: string | null;
  settlementUrl: string | null;
};

/** GET /v1/payees */
export type PayeesResponse = PayeesFile;

/** GET /v1/payment-intents/:intentId/verification */
export type VerificationResponse = { verified: boolean; checks: VerifyCheck[] };

/** GET /v1/ledger */
export type LedgerResponse = { check: LedgerCheck; head: Hex; entries: readonly LedgerEntry[] };

/** One decision as the console lists it. The whole record is at /v1/payment-intents/:intentId. */
export type IntentSummary = {
  intentId: Hex;
  decidedAt: string;
  updatedAt: string;
  agentId: string;
  mandateId: string | null;
  payee: Address;
  payeeName: string | null;
  amount: string;
  tokenSymbol: string;
  tokenDecimals: number;
  purpose: string;
  invoiceId: string;
  decision: EvidenceFile['record']['why']['decision'];
  status: EvidenceFile['result']['status'];
  reasons: string[];
  /** Where the agent says the payee came from, if it said so. Recorded, never trusted. */
  payeeSource: string | null;
  evidenceHash: Hex;
  transactionHash: Hex | null;
  explorerUrl: string | null;
  /** Set for a per-call purchase. */
  purchase: {
    resource: string;
    status: 'settled' | 'failed' | null;
    settlementTransactionHash: Hex | null;
    settlementUrl: string | null;
  } | null;
  approvedBy: Address | null;
  error: string | null;
};

const isHash = (value: string): value is Hex => /^0x[0-9a-f]{64}$/.test(value);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The gateway's HTTP API. */
export function createApp(options: AppOptions): Express {
  const { gateway, chain, ledger, explorerTx } = options;
  const app = express();
  app.disable('x-powered-by');

  // The gateway serves this machine only. A request that names another host has been pointed here by
  // a web page elsewhere (DNS rebinding), so it gets nothing.
  app.use((request, response, next) => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host)) {
      response.status(403).json({ error: 'This gateway answers local requests only' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  const link = (hash: Hex | null) => (hash !== null && explorerTx ? explorerTx(hash) : null);

  const withLinks = (outcome: IntentOutcome): OutcomeResponse => ({
    ...outcome,
    explorerUrl: link(outcome.transactionHash),
    settlementUrl:
      outcome.purchase?.status === 'settled'
        ? link(outcome.purchase.settlementTransactionHash)
        : null,
  });

  const summaryOf = (file: EvidenceFile): IntentSummary => {
    const { record, result } = file;
    const paid = result.status === 'paid' ? result : null;
    const purchase = record.purchase ?? null;
    const settlement = paid?.purchase?.status === 'settled' ? paid.purchase : null;
    const source = record.request.intent.context.payeeSource;
    const transactionHash =
      result.status === 'paid' || result.status === 'failed' ? result.transactionHash : null;
    return {
      intentId: record.intentId,
      decidedAt: record.decidedAt,
      updatedAt: file.updatedAt,
      agentId: record.who.agentId,
      mandateId: record.who.mandateId,
      payee: record.what.payee,
      payeeName: record.what.payeeName,
      amount: record.what.amount,
      tokenSymbol: record.what.tokenSymbol,
      tokenDecimals: record.what.tokenDecimals,
      purpose: record.what.purpose,
      invoiceId: record.what.invoiceId,
      decision: record.why.decision,
      status: result.status,
      reasons: record.why.reasons,
      payeeSource: typeof source === 'string' ? source : null,
      evidenceHash: file.evidenceHash,
      transactionHash,
      explorerUrl: link(transactionHash),
      purchase:
        purchase === null
          ? null
          : {
              resource: purchase.resource,
              status: paid?.purchase?.status ?? null,
              settlementTransactionHash: settlement?.settlementTransactionHash ?? null,
              settlementUrl: link(settlement?.settlementTransactionHash ?? null),
            },
      approvedBy: file.approval?.approver ?? null,
      error: result.status === 'failed' ? result.error : null,
    };
  };

  const hashOf = (value: string | undefined, what: string): Hex => {
    if (value === undefined || !isHash(value)) {
      throw new RequestError(400, `The ${what} must be 32 bytes in lowercase hex`);
    }
    return value;
  };

  const evidenceOf = async (value: string | undefined): Promise<EvidenceFile> => {
    const file = await gateway.evidenceFor(hashOf(value, 'intent id'));
    if (file === null) throw new RequestError(404, 'No such intent');
    return file;
  };

  app.get('/healthz', async (_request, response) => {
    const info = await chain.info();
    response.json({
      ok: true,
      chainId: info.chainId,
      vault: info.vault,
      token: info.tokenSymbol,
      executor: gateway.executorAddress,
      spendWallet: gateway.spendWalletAddress,
      ledger: ledger.verify(),
    });
  });

  // What the console needs to know about this gateway. Nothing here is secret.
  app.get('/v1/config', async (_request, response) => {
    const info = await chain.info();
    response.json({
      chainId: info.chainId,
      vault: info.vault,
      principal: info.principal,
      identityRegistry: info.identityRegistry,
      token: { address: info.token, symbol: info.tokenSymbol, decimals: info.tokenDecimals },
      executor: gateway.executorAddress,
      spendWallet: gateway.spendWalletAddress,
      explorerUrl: options.explorerUrl ?? null,
    } satisfies ConfigResponse);
  });

  // The principal's vendor registry and denylist, for showing names next to addresses.
  app.get('/v1/payees', async (_request, response) => {
    response.json((await gateway.payees()) satisfies PayeesResponse);
  });

  // An agent asks for a payment. The answer is always a decision: auto, needs_approval or refused.
  app.post('/v1/payment-intents', async (request, response) => {
    response.json(withLinks(await gateway.submit(request.body)));
  });

  // The newest decisions first.
  app.get('/v1/payment-intents', async (request, response) => {
    const asked = Number(request.query.limit ?? 100);
    const limit = Number.isInteger(asked) && asked >= 1 && asked <= 500 ? asked : 100;
    response.json({ intents: (await gateway.recent(limit)).map(summaryOf) });
  });

  // The full evidence file for one intent.
  app.get('/v1/payment-intents/:intentId', async (request, response) => {
    response.json(await evidenceOf(request.params.intentId));
  });

  // The evidence file checked against the chain and the ledger. This is the gateway checking its own
  // file: `pnpm verify-evidence` runs the same checks without trusting the gateway.
  app.get('/v1/payment-intents/:intentId/verification', async (request, response) => {
    if (options.verify === undefined) throw new RequestError(404, 'Not found');
    const report = await options.verify(await evidenceOf(request.params.intentId));
    response.json({
      verified: report.verified,
      checks: report.checks,
    } satisfies VerificationResponse);
  });

  // Payments waiting for an approver, each with the EIP-712 message to sign.
  app.get('/v1/approvals', async (_request, response) => {
    response.json({ approvals: await gateway.pendingApprovals() });
  });

  // The approver's signature. The gateway checks it and pays through the vault.
  app.post('/v1/approvals/:intentId', async (request, response) => {
    const id = hashOf(request.params.intentId, 'intent id');
    response.json(withLinks(await gateway.approve(id, request.body)));
  });

  // The approver's signed refusal.
  app.post('/v1/approvals/:intentId/decline', async (request, response) => {
    const id = hashOf(request.params.intentId, 'intent id');
    response.json(withLinks(await gateway.decline(id, request.body)));
  });

  // The plain text of a mandate, by the hash the vault stores for it.
  app.get('/v1/mandate-terms/:termsHash', async (request, response) => {
    if (options.mandateTerms === undefined) throw new RequestError(404, 'Not found');
    const text = await options.mandateTerms.get(hashOf(request.params.termsHash, 'terms hash'));
    if (text === null) throw new RequestError(404, 'No text is stored for this terms hash');
    response.type('text/plain').send(text);
  });

  // Stores a mandate's text. It is accepted only under its own hash.
  app.put(
    '/v1/mandate-terms/:termsHash',
    express.text({ limit: MAX_TERMS_BYTES, type: 'text/plain' }),
    async (request, response) => {
      if (options.mandateTerms === undefined) throw new RequestError(404, 'Not found');
      const termsHash = hashOf(request.params.termsHash, 'terms hash');
      if (typeof request.body !== 'string' || request.body === '') {
        throw new RequestError(400, 'Send the mandate text as text/plain');
      }
      if (!(await options.mandateTerms.put(termsHash, request.body))) {
        throw new RequestError(400, 'The text does not hash to this terms hash');
      }
      response.status(201).json({ termsHash });
    },
  );

  app.get('/v1/ledger', (_request, response) => {
    response.json({
      check: ledger.verify(),
      head: ledger.head,
      entries: ledger.entries,
    } satisfies LedgerResponse);
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  const onError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof RequestError) {
      response.status(error.status).json({ error: error.message, reasons: error.reasons });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: 'The request is not well-formed',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof SyntaxError || (error as { type?: string }).type === 'entity.too.large') {
      response.status(400).json({ error: 'The request body is not valid JSON or is too large' });
      return;
    }
    console.error('Unexpected error:', error instanceof Error ? error.message : error);
    response.status(500).json({ error: 'Internal error' });
  };
  app.use(onError);

  return app;
}
