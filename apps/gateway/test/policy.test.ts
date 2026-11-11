import { describe, expect, it } from 'vitest';

import {
  MAX_REQUEST_LIFETIME_SECONDS,
  type MandateFacts,
  type PolicyInput,
  evaluate,
} from '../src/policy/evaluate';
import { decisionFromChecks } from '../src/protocol/evidence';
import { NOW, USDC, newAddress } from './helpers';

const executor = newAddress();
const agentWallet = newAddress();
const vendor = newAddress();

/** The demo mandate: 2 USDC per payment, 8 USDC per day, hard ceiling 20 USDC, valid for 30 days. */
function mandate(overrides: Partial<MandateFacts> = {}): MandateFacts {
  return {
    id: 1n,
    executor,
    approver: newAddress(),
    revoked: false,
    validUntil: NOW + 30 * 86_400,
    perPaymentCap: 2n * USDC,
    dailyCap: 8n * USDC,
    hardCeiling: 20n * USDC,
    payeeAllowed: true,
    spentToday: 0n,
    ...overrides,
  };
}

type Overrides = {
  now?: number;
  request?: Partial<PolicyInput['request']>;
  agent?: Partial<PolicyInput['agent']>;
  mandate?: MandateFacts | null;
  vault?: Partial<PolicyInput['vault']>;
  payee?: Partial<PolicyInput['payee']>;
};

/** A request that passes every check: 1.50 USDC to a listed vendor, signed by the agent's wallet. */
function input(overrides: Overrides = {}): PolicyInput {
  return {
    now: overrides.now ?? NOW,
    gatewayExecutor: executor,
    request: {
      payee: vendor,
      amount: 1_500_000n,
      expiresAt: NOW + 300,
      signer: agentWallet,
      payeeSource: null,
      ...overrides.request,
    },
    agent: { registered: true, wallet: agentWallet, active: true, ...overrides.agent },
    mandate: overrides.mandate === undefined ? mandate() : overrides.mandate,
    vault: { paused: false, balance: 10n * USDC, ...overrides.vault },
    payee: { vendor: { name: 'Tsukimi Data' }, denied: null, ...overrides.payee },
    token: { symbol: 'USDC', decimals: 6 },
  };
}

function failed(result: ReturnType<typeof evaluate>): string[] {
  return result.checks.filter((check) => check.result === 'fail').map((check) => check.key);
}

describe('policy: auto', () => {
  it('lets a payment through when every check passes', () => {
    const result = evaluate(input());
    expect(result.decision).toBe('auto');
    expect(result.reasons).toEqual(['All 14 checks passed']);
    expect(result.checks.every((check) => check.result === 'pass')).toBe(true);
  });

  it('lists every check once, in a fixed order', () => {
    expect(evaluate(input()).checks.map((check) => `${check.kind}:${check.key}`)).toEqual([
      'hard:request_current',
      'hard:agent_registered',
      'hard:agent_active',
      'hard:agent_signature',
      'hard:mandate_active',
      'hard:vault_open',
      'hard:payee_not_denied',
      'hard:payee_in_vendor_registry',
      'hard:amount_positive',
      'hard:within_hard_ceiling',
      'hard:vault_funded',
      'soft:payee_on_allowlist',
      'soft:within_per_payment_cap',
      'soft:within_daily_cap',
    ]);
  });

  it('treats the caps and the expiry as inclusive, like the vault does', () => {
    expect(evaluate(input({ request: { amount: 2n * USDC } })).decision).toBe('auto');
    expect(evaluate(input({ mandate: mandate({ spentToday: 6_500_000n }) })).decision).toBe('auto');
    expect(
      evaluate(input({ now: NOW + 30 * 86_400, request: { expiresAt: NOW + 30 * 86_400 + 60 } }))
        .decision,
    ).toBe('auto');
    expect(evaluate(input({ request: { expiresAt: NOW } })).decision).toBe('auto');
    expect(
      evaluate(input({ request: { expiresAt: NOW + MAX_REQUEST_LIFETIME_SECONDS } })).decision,
    ).toBe('auto');
  });

  it('accepts an agent whose registration says nothing about being active', () => {
    expect(evaluate(input({ agent: { active: null } })).decision).toBe('auto');
  });
});

describe('policy: refused', () => {
  it.each<[string, Overrides, string, RegExp]>([
    ['an expired request', { request: { expiresAt: NOW - 1 } }, 'request_current', /expired/],
    [
      'a request that is valid for too long',
      { request: { expiresAt: NOW + MAX_REQUEST_LIFETIME_SECONDS + 1 } },
      'request_current',
      /too long/,
    ],
    ['an inactive agent', { agent: { active: false } }, 'agent_active', /Inactive agent/],
    [
      'a request signed by another key',
      { request: { signer: newAddress() } },
      'agent_signature',
      /not signed/,
    ],
    [
      'a signature that cannot be read',
      { request: { signer: null } },
      'agent_signature',
      /not signed/,
    ],
    ['an agent with no wallet set', { agent: { wallet: null } }, 'agent_signature', /not signed/],
    ['an agent without a mandate', { mandate: null }, 'mandate_active', /no mandate/],
    [
      'a mandate whose executor is another gateway',
      { mandate: mandate({ executor: newAddress() }) },
      'mandate_active',
      /not the mandate's executor/,
    ],
    ['a revoked mandate', { mandate: mandate({ revoked: true }) }, 'mandate_active', /revoked/],
    [
      'an expired mandate',
      { now: NOW + 30 * 86_400 + 1, request: { expiresAt: NOW + 30 * 86_400 + 60 } },
      'mandate_active',
      /expired/,
    ],
    ['a paused vault', { vault: { paused: true } }, 'vault_open', /paused/],
    [
      'a payee on the denylist',
      { payee: { denied: { reason: 'reported for invoice fraud' } } },
      'payee_not_denied',
      /denylist: reported for invoice fraud/,
    ],
    [
      'a payee outside the vendor registry',
      { payee: { vendor: null } },
      'payee_in_vendor_registry',
      /vendor registry/,
    ],
    ['a zero amount', { request: { amount: 0n } }, 'amount_positive', /zero/],
    [
      'an amount above the hard ceiling',
      { request: { amount: 20n * USDC + 1n }, vault: { balance: 100n * USDC } },
      'within_hard_ceiling',
      /amount is above the mandate's hard ceiling of 20 USDC/,
    ],
    [
      "a payment that would take today's total above the hard ceiling",
      {
        request: { amount: 6n * USDC },
        mandate: mandate({ spentToday: 15n * USDC }),
        vault: { balance: 100n * USDC },
      },
      'within_hard_ceiling',
      /today's total above the mandate's hard ceiling/,
    ],
    [
      'a vault without enough funds',
      { vault: { balance: 1_499_999n } },
      'vault_funded',
      /enough funds/,
    ],
  ])('refuses %s', (_name, overrides, key, reason) => {
    const result = evaluate(input(overrides));
    expect(result.decision).toBe('refused');
    expect(failed(result)).toContain(key);
    expect(result.reasons.join(' | ')).toMatch(reason);
  });

  it('refuses an unknown agent and does not pretend to have checked the rest of its identity', () => {
    const result = evaluate(
      input({ agent: { registered: false, wallet: null, active: null }, mandate: null }),
    );
    expect(result.decision).toBe('refused');
    expect(result.reasons[0]).toMatch(/Unknown agent/);
    const byKey = Object.fromEntries(result.checks.map((check) => [check.key, check.result]));
    expect(byKey.agent_registered).toBe('fail');
    expect(byKey.agent_active).toBe('skipped');
    expect(byKey.agent_signature).toBe('skipped');
    expect(byKey.within_hard_ceiling).toBe('skipped');
    expect(byKey.payee_on_allowlist).toBe('skipped');
  });

  it('says so when the payee address came only from content the agent read', () => {
    const result = evaluate(
      input({
        request: { amount: 4n * USDC, payeeSource: 'tool response: get_market_data (vendor note)' },
        payee: { vendor: null },
      }),
    );
    expect(result.decision).toBe('refused');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('not in the principal');
    expect(result.reasons[0]).toContain('tool response: get_market_data (vendor note)');
    expect(result.reasons[0]).toContain('not a trusted source');
  });

  it('does not let a claimed source make an unregistered payee acceptable', () => {
    const result = evaluate(
      input({
        request: { payeeSource: "the principal's own instructions" },
        payee: { vendor: null },
      }),
    );
    expect(result.decision).toBe('refused');
  });

  it('gives only the hard reasons when a request fails hard and soft checks together', () => {
    const result = evaluate(
      input({
        request: { amount: 25n * USDC },
        vault: { balance: 100n * USDC },
        mandate: mandate({ payeeAllowed: false }),
      }),
    );
    expect(result.decision).toBe('refused');
    expect(failed(result)).toEqual([
      'within_hard_ceiling',
      'payee_on_allowlist',
      'within_per_payment_cap',
      'within_daily_cap',
    ]);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/hard ceiling/);
  });

  it('lists every hard reason when several apply', () => {
    const result = evaluate(
      input({
        vault: { paused: true },
        payee: { vendor: null, denied: { reason: 'sanctions list' } },
      }),
    );
    expect(result.reasons).toHaveLength(3);
  });
});

describe('policy: needs approval', () => {
  it.each<[string, Overrides, string, RegExp]>([
    [
      'an amount above the per-payment cap',
      { request: { amount: 2n * USDC + 1n } },
      'within_per_payment_cap',
      /above the per-payment cap of 2 USDC/,
    ],
    [
      "a payment that would take today's total above the daily cap",
      { mandate: mandate({ spentToday: 6_500_001n }) },
      'within_daily_cap',
      /above the daily cap of 8 USDC/,
    ],
    [
      'a registered vendor that is not on the allowlist',
      { mandate: mandate({ payeeAllowed: false }) },
      'payee_on_allowlist',
      /not yet on this mandate's allowlist/,
    ],
  ])('asks for approval for %s', (_name, overrides, key, reason) => {
    const result = evaluate(input(overrides));
    expect(result.decision).toBe('needs_approval');
    expect(failed(result)).toEqual([key]);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(reason);
  });

  it('gives every reason when several soft checks fail', () => {
    const result = evaluate(
      input({ request: { amount: 9n * USDC }, mandate: mandate({ payeeAllowed: false }) }),
    );
    expect(result.decision).toBe('needs_approval');
    expect(result.reasons).toHaveLength(3);
  });

  it('allows an approval up to the hard ceiling for the day, and no further', () => {
    const atCeiling = evaluate(
      input({
        request: { amount: 5n * USDC },
        mandate: mandate({ spentToday: 15n * USDC }),
        vault: { balance: 100n * USDC },
      }),
    );
    expect(atCeiling.decision).toBe('needs_approval');

    const overCeiling = evaluate(
      input({
        request: { amount: 5n * USDC + 1n },
        mandate: mandate({ spentToday: 15n * USDC }),
        vault: { balance: 100n * USDC },
      }),
    );
    expect(overCeiling.decision).toBe('refused');
  });
});

describe('policy: the demo path', () => {
  it('step 2: tops up the spend wallet with 0.10 USDC on its own', () => {
    expect(evaluate(input({ request: { amount: 100_000n } })).decision).toBe('auto');
  });

  it('step 3: pays a known vendor 1.50 USDC on its own', () => {
    expect(evaluate(input({ mandate: mandate({ spentToday: 100_000n }) })).decision).toBe('auto');
  });

  it('step 4: sends a 6 USDC invoice to the approver', () => {
    const result = evaluate(
      input({ request: { amount: 6n * USDC }, mandate: mandate({ spentToday: 1_600_000n }) }),
    );
    expect(result.decision).toBe('needs_approval');
    expect(result.reasons).toEqual(['The amount is above the per-payment cap of 2 USDC']);
  });

  it('step 5: refuses 4 USDC to an address planted in a tool response', () => {
    const result = evaluate(
      input({
        request: {
          payee: newAddress(),
          amount: 4n * USDC,
          payeeSource: 'tool response: get_market_data',
        },
        payee: { vendor: null },
        mandate: mandate({ payeeAllowed: false, spentToday: 7_600_000n }),
      }),
    );
    expect(result.decision).toBe('refused');
  });

  it('step 7: refuses everything once the mandate is revoked', () => {
    expect(evaluate(input({ mandate: mandate({ revoked: true }) })).decision).toBe('refused');
  });
});

describe('policy: consistency', () => {
  it('always returns the decision that follows from its own checks', () => {
    const amounts = [
      0n,
      1n,
      2n * USDC,
      2n * USDC + 1n,
      8n * USDC,
      8n * USDC + 1n,
      20n * USDC,
      20n * USDC + 1n,
    ];
    const spent = [0n, 7n * USDC, 8n * USDC, 19n * USDC, 20n * USDC];
    const mandates = [
      null,
      mandate(),
      mandate({ revoked: true }),
      mandate({ payeeAllowed: false }),
    ];
    let cases = 0;
    for (const amount of amounts) {
      for (const spentToday of spent) {
        for (const base of mandates) {
          for (const vendorKnown of [true, false]) {
            const result = evaluate(
              input({
                request: { amount },
                mandate: base === null ? null : { ...base, spentToday },
                payee: { vendor: vendorKnown ? { name: 'Tsukimi Data' } : null },
                vault: { balance: 100n * USDC },
              }),
            );
            expect(result.decision).toBe(decisionFromChecks(result.checks));
            expect(result.reasons.length).toBeGreaterThan(0);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(320);
  });

  it('never lets a payment through on its own that the vault would refuse', () => {
    // The vault's own rules for payWithinMandate, restated.
    const vaultAccepts = (m: MandateFacts, amount: bigint) =>
      !m.revoked &&
      m.payeeAllowed &&
      amount > 0n &&
      amount <= m.perPaymentCap &&
      m.spentToday + amount <= m.dailyCap;

    for (const amount of [1n, 2n * USDC, 2n * USDC + 1n, 9n * USDC]) {
      for (const spentToday of [0n, 6n * USDC, 6n * USDC + 1n, 8n * USDC]) {
        for (const payeeAllowed of [true, false]) {
          const m = mandate({ spentToday, payeeAllowed });
          const result = evaluate(
            input({ request: { amount }, mandate: m, vault: { balance: 100n * USDC } }),
          );
          if (result.decision === 'auto') expect(vaultAccepts(m, amount)).toBe(true);
        }
      }
    }
  });
});
