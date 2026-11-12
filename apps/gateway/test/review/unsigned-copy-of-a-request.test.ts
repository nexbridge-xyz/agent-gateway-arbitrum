import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signIntent } from '../../src/protocol/intent';
import { type Harness, createHarness } from '../fakes';
import { DOMAIN, makeIntent, newAccount } from '../helpers';

/**
 * Review finding: an intent's id covers the intent and not its signature, and the gateway answers a
 * known id from its store. So a copy of an intent with any signature, sent first, was recorded as a
 * refusal under the id of the agent's own request, and the agent's valid request then got that refusal
 * for an answer, for good.
 */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

const BAD_SIGNATURE = `0x${'11'.repeat(64)}1b`;

describe('review: a copy of a request that the agent did not sign', () => {
  it('must not use up the agent’s own request', async () => {
    const intent = makeIntent({ agentId: h.world.agentId.toString(), payee: h.world.vendorA });
    const fromAgent = await signIntent(h.world.agent, DOMAIN, intent);
    // Somebody who saw the request, or guessed it, sends the same intent first with any signature.
    const fromStranger = await signIntent(newAccount(), DOMAIN, intent);

    const first = await h.gateway.submit(fromStranger);
    expect(first.decision).toBe('refused');

    // The intent id does not cover the signature, so both have the same id. On main the stored refusal
    // answers for the agent's request too, and the agent's valid request can never be paid.
    const second = await h.gateway.submit(fromAgent);
    expect(second.intentId).toBe(first.intentId);
    expect(second.decision).toBe('auto');
    expect(second.status).toBe('paid');
    expect(h.world.payments).toHaveLength(1);
  });

  it('must not win the race when both arrive at the same moment', async () => {
    const intent = makeIntent({ agentId: h.world.agentId.toString(), payee: h.world.vendorA });
    const fromAgent = await signIntent(h.world.agent, DOMAIN, intent);
    const unsigned = { intent, signature: BAD_SIGNATURE };

    const [stranger, agent] = await Promise.all([
      h.gateway.submit(unsigned),
      h.gateway.submit(fromAgent),
    ]);
    expect(stranger.decision).toBe('refused');
    expect(agent.status).toBe('paid');
  });

  it('still pays the agent’s request once, however often it is sent again (control)', async () => {
    const intent = makeIntent({ agentId: h.world.agentId.toString(), payee: h.world.vendorA });
    const fromAgent = await signIntent(h.world.agent, DOMAIN, intent);

    const first = await h.gateway.submit(fromAgent);
    const again = await h.gateway.submit(fromAgent);
    const copy = await h.gateway.submit({ intent, signature: BAD_SIGNATURE });
    expect([first.status, again.status, copy.status]).toEqual(['paid', 'paid', 'paid']);
    expect(h.world.payments).toHaveLength(1);
  });
});
