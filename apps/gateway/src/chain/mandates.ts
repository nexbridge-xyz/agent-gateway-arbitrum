import { type Address, isAddressEqual } from 'viem';

/**
 * Which of an agent's mandates a request is decided under.
 *
 * An agent can hold more than one mandate. The demo's agent has two: one for vendor invoices, and a
 * small one that only funds the gateway's spend wallet. Each mandate has its own caps in the vault,
 * so which one applies is part of the decision and has to follow a fixed rule.
 */

/** What the choice looks at. The vault's `getMandate` returns all of it. */
export type MandateCandidate = {
  id: bigint;
  executor: Address;
  revoked: boolean;
  /** Last second (Unix time) at which the mandate can pay. */
  validUntil: number;
  hardCeiling: bigint;
  /** The mandate's allowlist. It is fixed when the mandate is created. */
  payees: readonly Address[];
};

export type MandateQuery = {
  /** The address the vault would pay. For a per-call purchase that is the gateway's spend wallet. */
  payee: Address;
  /** The executor key this gateway pays with. */
  executor: Address;
  /** Time of the block the candidates were read at, Unix seconds. */
  now: number;
  /**
   * Set when a request that was already decided is looked at again, at approval time: the mandate it
   * was decided under, and no other, applies.
   */
  mandateId?: bigint | undefined;
};

export const listsPayee = (candidate: MandateCandidate, payee: Address) =>
  candidate.payees.some((listed) => isAddressEqual(listed, payee));

/**
 * The rule, in order:
 *
 *  1. Only mandates with this gateway as executor count. Among them, live ones (not revoked, not
 *     expired) come first; if none is live, the choice is made among the dead ones, so that the
 *     refusal can say what happened to the mandate.
 *  2. The newest mandate that lists the payee applies.
 *  3. If none lists the payee, the payment can only go through with the approver's signature. The
 *     mandate with the highest hard ceiling applies, the newest one if several are equal.
 *  4. If the agent has mandates but none with this gateway as executor, the newest one is returned,
 *     so that the refusal can say so.
 *
 * `candidates` are the agent's own mandates, newest first. Returns null if there are none.
 */
export function chooseMandate<Candidate extends MandateCandidate>(
  candidates: readonly Candidate[],
  query: MandateQuery,
): Candidate | null {
  if (query.mandateId !== undefined) {
    return candidates.find((candidate) => candidate.id === query.mandateId) ?? null;
  }

  const ours = candidates.filter((candidate) => isAddressEqual(candidate.executor, query.executor));
  if (ours.length === 0) return candidates[0] ?? null;

  const live = ours.filter((candidate) => !candidate.revoked && query.now <= candidate.validUntil);
  const pool = live.length > 0 ? live : ours;

  const listing = pool.find((candidate) => listsPayee(candidate, query.payee));
  if (listing !== undefined) return listing;

  // `pool` is newest first, and a later candidate replaces the pick only if its ceiling is higher.
  return pool.reduce((widest, candidate) =>
    candidate.hardCeiling > widest.hardCeiling ? candidate : widest,
  );
}
