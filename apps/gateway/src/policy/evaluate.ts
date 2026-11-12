import { type Address, formatUnits, isAddressEqual } from 'viem';

import {
  type CheckKind,
  type CheckResult,
  type Decision,
  type EvidenceCheck,
  decisionFromChecks,
} from '../protocol/evidence';

/**
 * The gateway's policy: check one payment request against the agent's identity, its mandate and the
 * principal's vendor registry. Plain code, no model. A model can be talked into things by text it
 * reads; these functions only look at the signed request, the chain and the principal's own lists.
 *
 * Everything here is pure: the caller reads the facts, this module decides.
 */

/** The mandate as the vault holds it, at the block the decision is based on. */
export type MandateFacts = {
  id: bigint;
  executor: Address;
  approver: Address;
  revoked: boolean;
  /** Last second (Unix time) at which the mandate can pay. */
  validUntil: number;
  perPaymentCap: bigint;
  dailyCap: bigint;
  hardCeiling: bigint;
  /** The nonce the approver's next signature must carry. */
  approvalNonce: bigint;
  /** Whether the address the vault would pay is on this mandate's allowlist. */
  payeeAllowed: boolean;
  /** Total the mandate has paid out in the current UTC day, approved payments included. */
  spentToday: bigint;
};

export type PolicyInput = {
  /** Time of the block the facts were read at, Unix seconds. */
  now: number;
  /** The executor key this gateway pays with. */
  gatewayExecutor: Address;
  request: {
    payee: Address;
    amount: bigint;
    expiresAt: number;
    /** The address recovered from the request signature, or null if it could not be read. */
    signer: Address | null;
    /** Where the agent says the payee came from. Recorded, never trusted. */
    payeeSource: string | null;
  };
  agent: {
    /** Whether the agent id exists in the ERC-8004 Identity Registry. */
    registered: boolean;
    /** The wallet registered for the agent, if any. */
    wallet: Address | null;
    /** The `active` flag of an onchain registration file, or null if there is no such flag to read. */
    active: boolean | null;
  };
  /** The agent's newest mandate with this gateway as executor, or null if there is none. */
  mandate: MandateFacts | null;
  vault: { paused: boolean; balance: bigint };
  payee: {
    /** The payee's entry in the principal's vendor registry, or null. */
    vendor: { name: string } | null;
    /** The payee's entry in the gateway's denylist, or null. */
    denied: { reason: string } | null;
  };
  token: { symbol: string; decimals: number };
  /**
   * Set when the request is a per-call purchase from a merchant's API. The vault then pays the
   * gateway's spend wallet, and the spend wallet pays the merchant.
   */
  purchase?: {
    /** Whether this gateway has a spend wallet to buy with. */
    spendWalletReady: boolean;
    /** Origin of the resource the agent asked for, or null if it is not a valid http(s) URL. */
    resourceOrigin: string | null;
    /** The API origin the principal registered for this merchant, if any. */
    merchantOrigin: string | null;
    /** The most the gateway pays for one call. */
    callCap: bigint;
  } | null;
  /**
   * True when a waiting request is checked again at approval time. It was current when it arrived;
   * the approval carries its own deadline.
   */
  requestAlreadyAccepted?: boolean;
};

export type PolicyResult = {
  decision: Decision;
  reasons: string[];
  checks: EvidenceCheck[];
};

/** Longest validity the gateway accepts for a request, so that old signed requests die quickly. */
export const MAX_REQUEST_LIFETIME_SECONDS = 15 * 60;

const SECONDS_PER_DAY = 86_400;

export function evaluate(input: PolicyInput): PolicyResult {
  const { request, agent, mandate, vault, payee, token } = input;
  const money = (amount: bigint) => `${formatUnits(amount, token.decimals)} ${token.symbol}`;
  const checks: EvidenceCheck[] = [];
  const failures = new Map<string, string>();

  const add = (
    key: string,
    kind: CheckKind,
    outcome: boolean | 'skipped',
    label: string,
    detail: string,
    failure: string,
  ) => {
    const result: CheckResult = outcome === 'skipped' ? 'skipped' : outcome ? 'pass' : 'fail';
    checks.push({ key, kind, result, label, detail });
    if (result !== 'pass')
      failures.set(key, result === 'skipped' ? `${failure} (not checked)` : failure);
  };

  // --- Who is asking -------------------------------------------------------------------------------

  const secondsLeft = request.expiresAt - input.now;
  const accepted = input.requestAlreadyAccepted === true;
  add(
    'request_current',
    'hard',
    accepted || (secondsLeft >= 0 && secondsLeft <= MAX_REQUEST_LIFETIME_SECONDS),
    'Request is current',
    accepted
      ? 'was current when it arrived'
      : secondsLeft < 0
        ? `expired ${-secondsLeft} seconds ago`
        : `expires in ${secondsLeft} seconds; at most ${MAX_REQUEST_LIFETIME_SECONDS} are accepted`,
    secondsLeft < 0 ? 'The request has expired' : 'The request is valid for too long',
  );

  add(
    'agent_registered',
    'hard',
    agent.registered,
    'Agent is registered in the ERC-8004 Identity Registry',
    agent.registered ? 'agent id found' : 'agent id not found',
    'Unknown agent: the agent id is not in the ERC-8004 Identity Registry',
  );

  add(
    'agent_active',
    'hard',
    !agent.registered ? 'skipped' : agent.active !== false,
    'Agent is not marked inactive',
    !agent.registered
      ? 'no agent to check'
      : agent.active === null
        ? 'no onchain registration file states otherwise'
        : `registration file says active: ${agent.active}`,
    'Inactive agent: its registration file says it is not active',
  );

  const signedByAgent =
    request.signer !== null &&
    agent.wallet !== null &&
    isAddressEqual(request.signer, agent.wallet);
  add(
    'agent_signature',
    'hard',
    !agent.registered ? 'skipped' : signedByAgent,
    "Request is signed by the agent's registered wallet",
    !agent.registered
      ? 'no agent to check'
      : `signed by ${request.signer ?? 'an unreadable signature'}; registered wallet is ${agent.wallet ?? 'not set'}`,
    "The request is not signed by the agent's registered wallet",
  );

  // --- Under which mandate -------------------------------------------------------------------------

  const mandateProblem = describeMandateProblem(mandate, input);
  add(
    'mandate_active',
    'hard',
    mandateProblem === null,
    'Agent has an active mandate with this gateway as executor',
    mandate === null
      ? 'no mandate found'
      : `mandate ${mandate.id}, valid until ${isoTime(mandate.validUntil)}${mandate.revoked ? ', revoked' : ''}`,
    mandateProblem ?? '',
  );

  add(
    'vault_open',
    'hard',
    !vault.paused,
    'Vault is not paused',
    vault.paused ? 'the principal has paused all payments' : 'not paused',
    'The principal has paused the vault',
  );

  // --- To whom -------------------------------------------------------------------------------------

  add(
    'payee_not_denied',
    'hard',
    payee.denied === null,
    'Payee is not on the denylist',
    payee.denied === null ? 'not listed' : `listed: ${payee.denied.reason}`,
    `The payee is on the denylist${payee.denied === null ? '' : `: ${payee.denied.reason}`}`,
  );

  const fromUntrustedText = request.payeeSource !== null && payee.vendor === null;
  add(
    'payee_in_vendor_registry',
    'hard',
    payee.vendor !== null,
    "Payee is in the principal's vendor registry",
    payee.vendor !== null
      ? `registered as ${payee.vendor.name}`
      : fromUntrustedText
        ? `not registered; the agent says the address came from: ${request.payeeSource}`
        : 'not registered',
    fromUntrustedText
      ? `The payee is not in the principal's vendor registry. The address appears only in content the agent read (${request.payeeSource}), which is not a trusted source`
      : "The payee is not in the principal's vendor registry",
  );

  // --- How much ------------------------------------------------------------------------------------

  add(
    'amount_positive',
    'hard',
    request.amount > 0n,
    'Amount is more than zero',
    money(request.amount),
    'The amount is zero',
  );

  const mandateUsable = mandate !== null && mandateProblem === null;
  const dayTotal = mandate === null ? 0n : mandate.spentToday + request.amount;

  add(
    'within_hard_ceiling',
    'hard',
    !mandateUsable ? 'skipped' : dayTotal <= mandate.hardCeiling,
    "Day total stays within the mandate's hard ceiling",
    !mandateUsable
      ? 'no usable mandate'
      : `${money(mandate.spentToday)} paid today + ${money(request.amount)} vs ceiling ${money(mandate.hardCeiling)}`,
    mandate !== null && request.amount > mandate.hardCeiling
      ? `The amount is above the mandate's hard ceiling of ${money(mandate.hardCeiling)}`
      : `The payment would take today's total above the mandate's hard ceiling${mandate === null ? '' : ` of ${money(mandate.hardCeiling)}`}`,
  );

  add(
    'vault_funded',
    'hard',
    vault.balance >= request.amount,
    'Vault holds enough funds',
    `vault holds ${money(vault.balance)}`,
    'The vault does not hold enough funds for this payment',
  );

  const purchase = input.purchase ?? null;
  if (purchase !== null) {
    add(
      'purchase_spend_wallet',
      'hard',
      purchase.spendWalletReady,
      'Gateway has a spend wallet for per-call purchases',
      purchase.spendWalletReady ? 'configured' : 'not configured',
      'This gateway has no spend wallet, so it cannot buy per call',
    );
    add(
      'purchase_origin_registered',
      'hard',
      purchase.resourceOrigin !== null && purchase.resourceOrigin === purchase.merchantOrigin,
      "Resource is on the merchant's registered API",
      `asked for ${purchase.resourceOrigin ?? 'something that is not a web address'}; registered: ${purchase.merchantOrigin ?? 'none'}`,
      'The resource is not on the API address the principal registered for this merchant',
    );
    add(
      'purchase_within_call_cap',
      'hard',
      request.amount <= purchase.callCap,
      "Price is within the gateway's per-call cap",
      `${money(request.amount)} vs cap ${money(purchase.callCap)}`,
      `The price is above the per-call cap of ${money(purchase.callCap)}`,
    );
  }

  // A per-call purchase is paid at once or not at all: there is nobody to wait for an approval while an
  // API call is open. So for a purchase, the checks that would send a payment to the approver refuse it.
  const softKind: CheckKind = purchase === null ? 'soft' : 'hard';

  add(
    'payee_on_allowlist',
    softKind,
    !mandateUsable ? 'skipped' : mandate.payeeAllowed,
    purchase === null
      ? "Payee is on the mandate's allowlist"
      : "Gateway's spend wallet is on the mandate's allowlist",
    !mandateUsable
      ? 'no usable mandate'
      : mandate.payeeAllowed
        ? 'on the allowlist'
        : 'not on the allowlist',
    purchase === null
      ? "The payee is in the vendor registry but not yet on this mandate's allowlist"
      : "The gateway's spend wallet is not on this mandate's allowlist",
  );

  add(
    'within_per_payment_cap',
    softKind,
    !mandateUsable ? 'skipped' : request.amount <= mandate.perPaymentCap,
    'Amount is within the per-payment cap',
    !mandateUsable
      ? 'no usable mandate'
      : `${money(request.amount)} vs cap ${money(mandate.perPaymentCap)}`,
    `The amount is above the per-payment cap${mandate === null ? '' : ` of ${money(mandate.perPaymentCap)}`}`,
  );

  add(
    'within_daily_cap',
    softKind,
    !mandateUsable ? 'skipped' : dayTotal <= mandate.dailyCap,
    'Day total stays within the daily cap',
    !mandateUsable
      ? 'no usable mandate'
      : `${money(mandate.spentToday)} paid today + ${money(request.amount)} vs cap ${money(mandate.dailyCap)}`,
    `The payment would take today's total above the daily cap${mandate === null ? '' : ` of ${money(mandate.dailyCap)}`}`,
  );

  const decision = decisionFromChecks(checks);
  const deciding: CheckKind | null =
    decision === 'refused' ? 'hard' : decision === 'needs_approval' ? 'soft' : null;
  const reasons =
    deciding === null
      ? [`All ${checks.length} checks passed`]
      : checks
          .filter((check) => check.kind === deciding && check.result === 'fail')
          .map((check) => failures.get(check.key) ?? check.label);

  return { decision, reasons, checks };
}

/** The UTC day number the vault uses for its daily counters. */
export function utcDay(timestamp: number): number {
  return Math.floor(timestamp / SECONDS_PER_DAY);
}

function describeMandateProblem(mandate: MandateFacts | null, input: PolicyInput): string | null {
  if (mandate === null) return 'The agent has no mandate with this gateway as executor';
  if (!isAddressEqual(mandate.executor, input.gatewayExecutor)) {
    return "This gateway is not the mandate's executor";
  }
  if (mandate.revoked) return `Mandate ${mandate.id} has been revoked`;
  if (input.now > mandate.validUntil) {
    return `Mandate ${mandate.id} expired on ${isoTime(mandate.validUntil)}`;
  }
  return null;
}

function isoTime(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace('.000Z', 'Z');
}
