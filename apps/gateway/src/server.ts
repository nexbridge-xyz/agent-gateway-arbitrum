import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Hex } from 'viem';
import { ZodError } from 'zod';

import type { ChainReader } from './chain/reader';
import { RequestError } from './errors';
import type { Gateway, IntentOutcome } from './gateway';
import type { Ledger } from './store/ledger';

export type AppOptions = {
  gateway: Gateway;
  chain: ChainReader;
  ledger: Ledger;
  /** Turns a transaction hash into a block explorer link. */
  explorerTx?: (hash: Hex) => string;
};

const isIntentId = (value: string): value is Hex => /^0x[0-9a-f]{64}$/.test(value);

/** The gateway's HTTP API. */
export function createApp({ gateway, chain, ledger, explorerTx }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  const withLinks = (outcome: IntentOutcome) => ({
    ...outcome,
    explorerUrl:
      outcome.transactionHash !== null && explorerTx ? explorerTx(outcome.transactionHash) : null,
    settlementUrl:
      outcome.purchase?.status === 'settled' && explorerTx
        ? explorerTx(outcome.purchase.settlementTransactionHash)
        : null,
  });

  const intentIdOf = (value: string): Hex => {
    if (!isIntentId(value))
      throw new RequestError(400, 'The intent id must be 32 bytes in lowercase hex');
    return value;
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

  // An agent asks for a payment. The answer is always a decision: auto, needs_approval or refused.
  app.post('/v1/payment-intents', async (request, response) => {
    response.json(withLinks(await gateway.submit(request.body)));
  });

  // The full evidence file for one intent.
  app.get('/v1/payment-intents/:intentId', async (request, response) => {
    const file = await gateway.evidenceFor(intentIdOf(request.params.intentId));
    if (file === null) throw new RequestError(404, 'No such intent');
    response.json(file);
  });

  // Payments waiting for an approver, each with the EIP-712 message to sign.
  app.get('/v1/approvals', async (_request, response) => {
    response.json({ approvals: await gateway.pendingApprovals() });
  });

  // The approver's signature. The gateway checks it and pays through the vault.
  app.post('/v1/approvals/:intentId', async (request, response) => {
    response.json(
      withLinks(await gateway.approve(intentIdOf(request.params.intentId), request.body)),
    );
  });

  // The approver's signed refusal.
  app.post('/v1/approvals/:intentId/decline', async (request, response) => {
    response.json(
      withLinks(await gateway.decline(intentIdOf(request.params.intentId), request.body)),
    );
  });

  app.get('/v1/ledger', (_request, response) => {
    response.json({ check: ledger.verify(), head: ledger.head, entries: ledger.entries });
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
