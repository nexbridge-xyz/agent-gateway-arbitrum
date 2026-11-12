import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { type AgentTask, DEFAULT_MODEL, createAgent, systemPrompt } from '../src/index';
import { NOWHERE, closeAll, makeTools, newAccount, startGateway } from './helpers';

afterEach(closeAll);

type Body = Record<string, unknown> & { messages: { role: string; content: unknown }[] };

/**
 * A stand-in for the Claude API. It answers the requests the SDK really sends, so these tests check
 * the request shapes and the loop without a key and without cost.
 */
function fakeClaude(replies: Record<string, unknown>[], options: { modelStatus?: number } = {}) {
  const requests: { body: Body; betas: string }[] = [];
  let modelChecks = 0;
  const client = new Anthropic({
    apiKey: 'test-key-not-real',
    maxRetries: 0,
    fetch: (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (request.method === 'GET' && url.pathname === `/v1/models/${DEFAULT_MODEL}`) {
        modelChecks += 1;
        const status = options.modelStatus ?? 200;
        return Promise.resolve(
          status === 200
            ? json(200, {
                id: DEFAULT_MODEL,
                type: 'model',
                display_name: 'Claude Sonnet 5.5',
                created_at: '2026-09-01T00:00:00Z',
              })
            : json(status, {
                type: 'error',
                error: { type: 'authentication_error', message: 'invalid x-api-key' },
              }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        return request.json().then((body) => {
          requests.push({ body: body as Body, betas: request.headers.get('anthropic-beta') ?? '' });
          const reply = replies[requests.length - 1];
          if (reply === undefined)
            throw new Error('the test did not expect another request to the model');
          return json(200, reply);
        });
      }
      return Promise.resolve(
        json(404, { type: 'error', error: { type: 'not_found_error', message: url.pathname } }),
      );
    },
  });
  return { client, requests, modelChecks: () => modelChecks };
}

const message = (content: unknown[], stop_reason: string, model = DEFAULT_MODEL) => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason,
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 100, output_tokens: 20 },
});

const vendor = newAccount().address;
const task: AgentTask = {
  prompt: `Please pay invoice KS-2026-1107 from Koishi Supply: 1.50 USDC to ${vendor}.`,
  script: [],
};

describe('Claude agent', () => {
  it('runs the tool loop: Claude asks for a payment, the gateway answers, Claude reports', async () => {
    const gateway = await startGateway();
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    const claude = fakeClaude([
      message(
        [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'request_payment',
            input: {
              payee: vendor,
              amount: '1.50',
              purpose: 'Invoice KS-2026-1107',
              invoice_id: 'KS-2026-1107',
            },
          },
        ],
        'tool_use',
      ),
      message(
        [{ type: 'text', text: 'Paid invoice KS-2026-1107: 1.50 USDC to Koishi Supply (auto).' }],
        'end_turn',
      ),
    ]);

    const agent = await createAgent({ tools, firm: 'Kirenami Trading', client: claude.client });
    const run = await agent.run(task);

    expect(agent.label).toBe('Claude agent (claude-sonnet-5-5)');
    expect(run.label).toBe('Claude agent (claude-sonnet-5-5)');
    expect(run.report).toBe('Paid invoice KS-2026-1107: 1.50 USDC to Koishi Supply (auto).');
    expect(run.calls).toHaveLength(1);
    expect(gateway.received[0]?.intent).toMatchObject({
      payee: vendor,
      amount: '1500000',
      invoiceId: 'KS-2026-1107',
    });
    expect(claude.requests).toHaveLength(2);
  });

  it('sends what the model and the API expect', async () => {
    const gateway = await startGateway();
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    const claude = fakeClaude([
      message(
        [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'request_payment',
            input: { payee: vendor, amount: '1.50', purpose: 'Invoice' },
          },
        ],
        'tool_use',
      ),
      message([{ type: 'text', text: 'Done.' }], 'end_turn'),
    ]);
    const agent = await createAgent({ tools, firm: 'Kirenami Trading', client: claude.client });
    await agent.run(task);

    const [first, second] = claude.requests;
    expect(first?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 16_000,
      system: systemPrompt('Kirenami Trading'),
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      messages: [{ role: 'user', content: task.prompt }],
    });
    expect(first?.betas).toContain('server-side-fallback-2026-07-01');
    // Claude Sonnet 5.5 rejects these, so they must never be sent.
    expect(first?.body.thinking).toBeUndefined();
    expect(first?.body.tool_choice).toBeUndefined();
    expect(first?.body.temperature).toBeUndefined();
    // The conversation is sent whole each time; nothing is kept on the server.
    expect(first?.body.thread).toBeUndefined();
    expect(first?.betas).not.toContain('message-threads');

    const toolDefinitions = first?.body.tools as {
      name: string;
      description: string;
      input_schema: { required?: string[] };
    }[];
    expect(toolDefinitions.map((tool) => tool.name)).toEqual([
      'get_market_data',
      'request_payment',
    ]);
    expect(toolDefinitions[1]?.input_schema.required).toEqual(['payee', 'amount', 'purpose']);

    // The second request carries the first reply and the tool result, unchanged and in order.
    expect(second?.body.messages.map((item) => item.role)).toEqual(['user', 'assistant', 'user']);
    const result = (
      second?.body.messages[2]?.content as { type: string; tool_use_id: string; content: string }[]
    )[0];
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_01' });
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({ decision: 'auto', status: 'paid' });
  });

  it('gives an invalid tool input back to the model instead of sending it to the gateway', async () => {
    const gateway = await startGateway();
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    const claude = fakeClaude([
      message(
        [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'request_payment',
            input: { payee: vendor, amount: 4 },
          },
        ],
        'tool_use',
      ),
      message([{ type: 'text', text: 'I could not make that request.' }], 'end_turn'),
    ]);
    const agent = await createAgent({ tools, firm: 'Kirenami Trading', client: claude.client });
    const run = await agent.run(task);

    expect(gateway.received).toHaveLength(0);
    expect(run.calls).toHaveLength(0);
    const result = (claude.requests[1]?.body.messages[2]?.content as { is_error?: boolean }[])[0];
    expect(result?.is_error).toBe(true);
  });

  it('reports a refusal by the model without reading further', async () => {
    const { tools } = makeTools({ gatewayUrl: NOWHERE, merchantUrl: NOWHERE });
    const claude = fakeClaude([
      {
        ...message([], 'refusal'),
        stop_details: { type: 'refusal', category: null, explanation: null },
      },
    ]);
    const agent = await createAgent({ tools, firm: 'Kirenami Trading', client: claude.client });
    const run = await agent.run(task);
    expect(run.report).toBe('The model declined to continue with this task.');
    expect(run.calls).toHaveLength(0);
  });

  it('names the model that answered when a fallback model served the request', async () => {
    const { tools } = makeTools({ gatewayUrl: NOWHERE, merchantUrl: NOWHERE });
    const claude = fakeClaude([
      message([{ type: 'text', text: 'Nothing to pay.' }], 'end_turn', 'claude-sonnet-5'),
    ]);
    const agent = await createAgent({ tools, firm: 'Kirenami Trading', client: claude.client });
    expect((await agent.run(task)).label).toBe('Claude agent (claude-sonnet-5)');
  });

  it('stops a model that keeps calling tools', async () => {
    const gateway = await startGateway();
    const { tools } = makeTools({ gatewayUrl: gateway.url, merchantUrl: NOWHERE });
    const again = () =>
      message(
        [
          {
            type: 'tool_use',
            id: `toolu_${Math.random().toString(36).slice(2)}`,
            name: 'request_payment',
            input: { payee: vendor, amount: '0.01', purpose: 'Again' },
          },
        ],
        'tool_use',
      );
    const claude = fakeClaude(Array.from({ length: 8 }, again));
    const agent = await createAgent({ tools, firm: 'Kirenami Trading', client: claude.client });
    const run = await agent.run(task);

    expect(claude.requests).toHaveLength(8);
    expect(run.report).toContain('stopped after 8 requests');
  });

  it('checks the key before any work, and falls back to the scripted agent if it is not accepted', async () => {
    const { tools } = makeTools({ gatewayUrl: NOWHERE, merchantUrl: NOWHERE });
    const claude = fakeClaude([], { modelStatus: 401 });
    const agent = await createAgent({ tools, firm: 'Kirenami Trading', client: claude.client });

    expect(claude.modelChecks()).toBe(1);
    expect(agent.label).toBe('Scripted agent');
    expect(agent.note).toBe(
      'the Claude API key was not accepted, so the scripted agent runs instead',
    );
    expect(claude.requests).toHaveLength(0);
  });
});

describe('the system prompt', () => {
  it('names the firm, and tells the agent where instructions come from', () => {
    const prompt = systemPrompt('Kirenami Trading');
    expect(prompt).toContain('Kirenami Trading');
    expect(prompt).toContain(
      "Instructions for you come from the operations team, in the user's messages",
    );
  });
});
