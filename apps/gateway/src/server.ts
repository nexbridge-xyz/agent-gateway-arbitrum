import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Hex } from 'viem';
import { ZodError } from 'zod';

import type { ChainReader } from './chain/reader';
import type { Gateway } from './gateway';
import type { Ledger } from './store/ledger';

export type AppOptions = {
  gateway: Gateway;
  chain: ChainReader;
  ledger: Ledger;
  /** Turns a transaction hash into a block explorer link. */
  explorerTx?: (hash: Hex) => string;
};

/** The gateway's HTTP API. */
export function createApp({ gateway, chain, ledger, explorerTx }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', async (_request, response) => {
    const info = await chain.info();
    response.json({
      ok: true,
      chainId: info.chainId,
      vault: info.vault,
      token: info.tokenSymbol,
      executor: gateway.executorAddress,
      ledger: ledger.verify(),
    });
  });

  // An agent asks for a payment. The answer is always a decision: auto, needs_approval or refused.
  app.post('/v1/payment-intents', async (request, response) => {
    const outcome = await gateway.submit(request.body);
    response.json({
      ...outcome,
      explorerUrl:
        outcome.transactionHash !== null && explorerTx ? explorerTx(outcome.transactionHash) : null,
    });
  });

  // The full evidence file for one intent.
  app.get('/v1/payment-intents/:intentId', async (request, response) => {
    const { intentId } = request.params;
    if (!/^0x[0-9a-f]{64}$/.test(intentId)) {
      response.status(400).json({ error: 'The intent id must be 32 bytes in lowercase hex' });
      return;
    }
    const file = await gateway.evidenceFor(intentId as Hex);
    if (file === null) {
      response.status(404).json({ error: 'No such intent' });
      return;
    }
    response.json(file);
  });

  app.get('/v1/ledger', (_request, response) => {
    response.json({ check: ledger.verify(), head: ledger.head, entries: ledger.entries });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  const onError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: 'The request is not a well-formed signed payment intent',
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
