import { randomBytes } from 'node:crypto';

import { Challenge } from 'mppx';
import {
  type Address,
  type LocalAccount,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  toHex,
} from 'viem';

import {
  type IntentDomain,
  type Json,
  type JsonObject,
  signIntent,
} from '@agent-gateway/gateway/protocol';

/**
 * The agent's two tools. Both end in the same place: a payment request signed with the agent's key
 * and sent to the gateway. The agent holds no key that can move money, so there is nothing else
 * these tools could do.
 *
 * The same tools serve the Claude agent and the scripted agent.
 */

export type ToolName = 'get_market_data' | 'request_payment';

/** What the gateway answered, as far as the agent needs it. */
export type GatewayAnswer = {
  intentId: string;
  decision: 'auto' | 'needs_approval' | 'refused';
  status: string;
  reasons: string[];
  evidenceHash: string;
  transactionHash: string | null;
  explorerUrl: string | null;
  settlementUrl: string | null;
  error: string | null;
  purchase:
    | { status: 'settled'; settlementTransactionHash: string }
    | { status: 'failed'; error: string }
    | null;
};

/** One tool call, as it happened. */
export type ToolCall = {
  tool: ToolName;
  input: JsonObject;
  /** The gateway's answer, or null if the call never reached the gateway. */
  answer: GatewayAnswer | null;
  /** What the agent got back. */
  result: JsonObject;
};

export type AgentToolsOptions = {
  /** The agent's request-signing key. It can ask; it cannot pay. */
  account: LocalAccount;
  /** The agent's id in the ERC-8004 Identity Registry. */
  agentId: bigint;
  /** The chain and the vault the gateway serves. Part of what the agent signs. */
  domain: IntentDomain;
  gatewayUrl: string;
  /** The market-data API the agent buys from. */
  merchantUrl: string;
  token: { symbol: string; decimals: number };
  /** Called after every tool call, for logs. */
  onCall?: (call: ToolCall) => void;
  fetch?: typeof fetch;
  /** Unix time in seconds. */
  now?: () => number;
};

export type MarketDataInput = { symbol: string };
export type PaymentInput = {
  payee: string;
  amount: string;
  purpose: string;
  invoice_id?: string | undefined;
};

export type AgentTools = ReturnType<typeof createAgentTools>;

const REQUEST_LIFETIME_SECONDS = 300;
const ADDRESS_IN_TEXT = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

export function createAgentTools(options: AgentToolsOptions) {
  const { account, agentId, domain, token } = options;
  const http = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
  const merchantUrl = options.merchantUrl.replace(/\/$/, '');
  const merchantOrigin = new URL(merchantUrl).origin;
  const calls: ToolCall[] = [];

  /**
   * Where the agent first saw an address, if it saw it in something a tool returned. Such text comes
   * from outside and can be written by anyone. This is kept by code, not by the model: a model that has
   * been talked into paying will not say where the address came from.
   */
  const seenInToolOutput = new Map<string, string>();

  const remember = (content: Json, source: string) => {
    for (const address of JSON.stringify(content).match(ADDRESS_IN_TEXT) ?? []) {
      const key = address.toLowerCase();
      if (!seenInToolOutput.has(key)) seenInToolOutput.set(key, source);
    }
  };

  const money = (amount: bigint) => `${formatUnits(amount, token.decimals)} ${token.symbol}`;

  const record = (
    tool: ToolName,
    input: JsonObject,
    answer: GatewayAnswer | null,
    result: JsonObject,
  ) => {
    const call: ToolCall = { tool, input, answer, result };
    calls.push(call);
    options.onCall?.(call);
    return result;
  };

  /** Signs one payment request and sends it to the gateway. */
  async function ask(request: {
    payee: Address;
    amount: bigint;
    purpose: string;
    invoiceId: string;
    context: JsonObject;
  }): Promise<{ answer: GatewayAnswer; data: Json | undefined } | { problem: string }> {
    const signed = await signIntent(account, domain, {
      agentId: agentId.toString(),
      payee: request.payee,
      amount: request.amount.toString(),
      purpose: request.purpose,
      invoiceId: request.invoiceId,
      context: request.context,
      nonce: toHex(randomBytes(32)),
      expiresAt: now() + REQUEST_LIFETIME_SECONDS,
    });

    let response: Response;
    try {
      response = await http(`${gatewayUrl}/v1/payment-intents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      });
    } catch {
      return { problem: 'The payment gateway cannot be reached' };
    }
    const body = (await response.json().catch(() => null)) as
      (GatewayAnswer & { data?: Json }) | { error?: string } | null;
    if (!response.ok || body === null || !('decision' in body)) {
      const said =
        body !== null && 'error' in body && typeof body.error === 'string' ? `: ${body.error}` : '';
      return { problem: `The payment gateway rejected the request (${response.status})${said}` };
    }
    const { data, ...answer } = body;
    return { answer, data };
  }

  /** The part of a gateway answer the agent reports on. */
  const summary = (answer: GatewayAnswer): JsonObject => ({
    decision: answer.decision,
    status: answer.status,
    reasons: answer.reasons,
    intent_id: answer.intentId,
    transaction: answer.explorerUrl,
    ...(answer.error === null ? {} : { error: answer.error }),
  });

  /**
   * Buys one index quote from the data vendor. The vendor asks for payment per call (HTTP 402); the
   * agent cannot pay it, so it asks the gateway to buy the quote and gets the data back from there.
   */
  async function getMarketData(input: MarketDataInput): Promise<JsonObject> {
    const symbol = input.symbol.trim().toUpperCase();
    const asked: JsonObject = { symbol };
    if (!/^[A-Z0-9-]{1,24}$/.test(symbol)) {
      return record('get_market_data', asked, null, {
        error: 'A symbol is letters, digits and dashes, such as TSK-LOGI20',
      });
    }
    const resource = `${merchantUrl}/v1/quotes/${symbol}`;

    // Ask without paying, to learn the price and who is to be paid.
    let probe: Response;
    try {
      probe = await http(resource, { headers: { accept: 'application/json' }, redirect: 'error' });
    } catch {
      return record('get_market_data', asked, null, { error: 'The data vendor cannot be reached' });
    }
    if (probe.status !== 402) {
      const body = (await probe.json().catch(() => null)) as Json;
      if (probe.ok) {
        remember(body, `market-data response for ${symbol} from ${merchantOrigin}`);
        return record('get_market_data', asked, null, { status: 'free', data: body });
      }
      return record('get_market_data', asked, null, {
        error:
          probe.status === 404
            ? `The data vendor does not sell ${symbol}`
            : `The data vendor answered ${probe.status}`,
        ...(typeof body === 'object' && body !== null && !Array.isArray(body)
          ? { details: body }
          : {}),
      });
    }

    let payee: Address;
    let amount: bigint;
    try {
      const { request } = Challenge.fromResponse(probe);
      if (typeof request.recipient !== 'string' || !isAddress(request.recipient, { strict: false }))
        throw new Error();
      if (typeof request.amount !== 'string' || !/^[1-9][0-9]{0,30}$/.test(request.amount))
        throw new Error();
      payee = getAddress(request.recipient);
      amount = BigInt(request.amount);
    } catch {
      return record('get_market_data', asked, null, {
        error: "The data vendor's payment request cannot be read",
      });
    }

    const outcome = await ask({
      payee,
      amount,
      purpose: `Market data: one ${symbol} quote`,
      invoiceId: '',
      // The payee address comes from the vendor's server. The gateway decides whether to believe it.
      context: { mpp: { resource }, payeeSource: `payment request from ${merchantOrigin}` },
    });
    if ('problem' in outcome)
      return record('get_market_data', asked, null, { error: outcome.problem });

    const { answer, data } = outcome;
    if (answer.status === 'paid' && answer.purchase?.status === 'settled' && data !== undefined) {
      remember(data, `market-data response for ${symbol} from ${merchantOrigin}`);
      return record('get_market_data', asked, answer, {
        status: 'paid',
        price: money(amount),
        data,
        payment: { funded_from_vault: answer.explorerUrl, paid_to_vendor: answer.settlementUrl },
        intent_id: answer.intentId,
      });
    }
    return record('get_market_data', asked, answer, {
      ...summary(answer),
      price: money(amount),
      ...(answer.purchase?.status === 'failed' ? { purchase_error: answer.purchase.error } : {}),
    });
  }

  /** Asks the gateway to pay a payee. The gateway decides: paid at once, waiting for approval, or refused. */
  async function requestPayment(input: PaymentInput): Promise<JsonObject> {
    const asked: JsonObject = {
      payee: input.payee,
      amount: input.amount,
      purpose: input.purpose,
      ...(input.invoice_id === undefined ? {} : { invoice_id: input.invoice_id }),
    };
    const payeeText = input.payee.trim();
    if (!isAddress(payeeText, { strict: false })) {
      return record('request_payment', asked, null, {
        error: 'The payee must be an address: 0x followed by 40 hex characters',
      });
    }
    const amountText = input.amount.trim();
    const decimals = new RegExp(`^[0-9]{1,12}(\\.[0-9]{1,${token.decimals}})?$`);
    if (!decimals.test(amountText) || parseUnits(amountText, token.decimals) === 0n) {
      return record('request_payment', asked, null, {
        error: `The amount must be a positive number of ${token.symbol} with at most ${token.decimals} decimals, such as 1.50`,
      });
    }
    const purpose = input.purpose.trim().slice(0, 280);
    if (purpose === '')
      return record('request_payment', asked, null, { error: 'Say what the payment is for' });

    const payee = getAddress(payeeText);
    const source = seenInToolOutput.get(payee.toLowerCase());
    const outcome = await ask({
      payee,
      amount: parseUnits(amountText, token.decimals),
      purpose,
      invoiceId: (input.invoice_id ?? '').trim().slice(0, 64),
      context: source === undefined ? {} : { payeeSource: source },
    });
    if ('problem' in outcome)
      return record('request_payment', asked, null, { error: outcome.problem });

    const { answer } = outcome;
    return record('request_payment', asked, answer, {
      ...summary(answer),
      ...(answer.status === 'pending_approval'
        ? { note: "The request waits for the firm's approver. Nothing more is needed from you." }
        : {}),
    });
  }

  return { getMarketData, requestPayment, calls };
}
