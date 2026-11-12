import Anthropic from '@anthropic-ai/sdk';

import { DEFAULT_MODEL, runClaudeAgent } from './claude';
import { SCRIPTED_AGENT_LABEL, runScriptedAgent } from './scripted';
import type { AgentTools, MarketDataInput, PaymentInput, ToolCall } from './tools';

/** One call the scripted agent makes. */
export type ScriptedStep =
  | { tool: 'get_market_data'; input: MarketDataInput }
  | { tool: 'request_payment'; input: PaymentInput };

/** One piece of work for the agent. */
export type AgentTask = {
  /** What the firm asks, in words. This is what the Claude agent reads. */
  prompt: string;
  /** The same work as tool calls. This is what the scripted agent does. */
  script: ScriptedStep[];
};

export type AgentRun = {
  /** Who did the work: "Scripted agent", or the Claude model that answered. */
  label: string;
  /** The tool calls of this task, in order. */
  calls: ToolCall[];
  /** The agent's closing report. */
  report: string;
};

export type Agent = {
  label: string;
  /** Why the scripted agent is running although a Claude API key was given, if that is the case. */
  note: string | null;
  run(task: AgentTask): Promise<AgentRun>;
};

export type AgentOptions = {
  tools: AgentTools;
  /** The fictional firm the agent works for. */
  firm: string;
  /** With a key the agent is Claude; without one it is the scripted agent. */
  anthropicApiKey?: string | undefined;
  model?: string | undefined;
  /** An existing client, for tests. */
  client?: Anthropic | undefined;
};

/**
 * The demo agent. With an Anthropic API key it is Claude with tool use; without one it is the scripted
 * agent, which runs the same tools through the same gateway.
 */
export async function createAgent(options: AgentOptions): Promise<Agent> {
  const { tools, firm } = options;
  const scripted = (note: string | null): Agent => ({
    label: SCRIPTED_AGENT_LABEL,
    note,
    run: (task) => runScriptedAgent(tools, task),
  });

  const key = options.anthropicApiKey?.trim() ?? '';
  if (key === '' && options.client === undefined) return scripted(null);

  const client = options.client ?? new Anthropic({ apiKey: key });
  const model = options.model?.trim() || DEFAULT_MODEL;

  // Check the key and the model before any work starts, so the agent never changes halfway. This call
  // costs nothing.
  try {
    await client.models.retrieve(model);
  } catch (error) {
    const why =
      error instanceof Anthropic.AuthenticationError
        ? 'the Claude API key was not accepted'
        : error instanceof Anthropic.NotFoundError ||
            error instanceof Anthropic.PermissionDeniedError
          ? `this API key cannot use ${model}`
          : error instanceof Anthropic.APIError
            ? `the Claude API answered ${error.status ?? 'with a connection error'}`
            : 'the Claude API could not be reached';
    return scripted(`${why}, so the scripted agent runs instead`);
  }

  return {
    label: `Claude agent (${model})`,
    note: null,
    run: (task) => runClaudeAgent({ client, model, tools, firm, task }),
  };
}
