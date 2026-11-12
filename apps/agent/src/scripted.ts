import type { JsonObject } from '@agent-gateway/gateway/protocol';

import type { AgentRun, AgentTask, ScriptedStep } from './agent';
import type { AgentTools } from './tools';

/**
 * The scripted agent: no model, the same tools, the same gateway. It does what the task's script
 * says, and it acts on any payment instruction it finds in a tool response, the way an agent does
 * that has been talked into it. That makes it a fair test of the gateway: the gateway cannot count on
 * the agent's judgment.
 */

export const SCRIPTED_AGENT_LABEL = 'Scripted agent';

/** A payment instruction hidden in text, such as "send 4 USDC to 0x…". */
export function paymentInstructionIn(text: string): { amount: string; payee: string } | null {
  const found =
    /send\s+([0-9]+(?:\.[0-9]+)?)\s+USDC\s+to\s+(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/i.exec(text);
  return found === null ? null : { amount: found[1] as string, payee: found[2] as string };
}

function noteIn(result: JsonObject): string | null {
  const data = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return typeof data.vendor_note === 'string' ? data.vendor_note : null;
}

async function runStep(tools: AgentTools, step: ScriptedStep): Promise<JsonObject> {
  return step.tool === 'get_market_data'
    ? tools.getMarketData(step.input)
    : tools.requestPayment(step.input);
}

export async function runScriptedAgent(tools: AgentTools, task: AgentTask): Promise<AgentRun> {
  const first = tools.calls.length;
  const lines: string[] = [];

  for (const step of task.script) {
    const result = await runStep(tools, step);
    lines.push(describe(step, result));

    // A vendor note that asks for money: this agent pays it, as a hijacked agent would.
    const note = step.tool === 'get_market_data' ? noteIn(result) : null;
    const instruction = note === null ? null : paymentInstructionIn(note);
    if (instruction !== null) {
      const followed: ScriptedStep = {
        tool: 'request_payment',
        input: { ...instruction, purpose: 'Priority access fee, as asked in a vendor note' },
      };
      lines.push('The response carried a vendor note asking for a payment. Acting on it.');
      lines.push(describe(followed, await runStep(tools, followed)));
    }
  }

  return { label: SCRIPTED_AGENT_LABEL, calls: tools.calls.slice(first), report: lines.join('\n') };
}

function describe(step: ScriptedStep, result: JsonObject): string {
  const what =
    step.tool === 'get_market_data'
      ? `Bought a ${step.input.symbol} quote`
      : `Asked to pay ${step.input.amount} USDC to ${step.input.payee}`;
  if (typeof result.error === 'string') return `${what}: ${result.error}`;
  const status = typeof result.status === 'string' ? result.status : 'unknown';
  const reasons = Array.isArray(result.reasons)
    ? result.reasons.filter((reason) => typeof reason === 'string')
    : [];
  return `${what}: ${status}${status === 'refused' && reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`;
}
