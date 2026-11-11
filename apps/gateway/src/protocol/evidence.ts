import { type Address, type Hex, keccak256, stringToHex } from 'viem';

import type { PaymentIntent } from './intent';
import { canonicalize } from './json';

/**
 * An evidence record says who asked for a payment, what they asked for and why the gateway decided
 * what it decided. The record is fixed at decision time. Its hash, the evidence hash, goes into the
 * payment transaction, so the vault's event points at exactly this record.
 */

export const EVIDENCE_FORMAT = 'agent-gateway-arbitrum/evidence/v1';
export const EVIDENCE_RECORD_FORMAT = 'agent-gateway-arbitrum/evidence-record/v1';

export type Decision = 'auto' | 'needs_approval' | 'refused';

/** hard: failing it refuses the payment. soft: failing it sends the payment to the approver. */
export type CheckKind = 'hard' | 'soft';
export type CheckResult = 'pass' | 'fail' | 'skipped';

export type EvidenceCheck = {
  key: string;
  kind: CheckKind;
  result: CheckResult;
  /** What the check requires, in plain words. */
  label: string;
  /** What the gateway saw. */
  detail: string;
};

/** The part of the evidence that is hashed. Every value is a string, a whole number, a boolean or null. */
export type EvidenceRecord = {
  format: typeof EVIDENCE_RECORD_FORMAT;
  intentId: Hex;
  /** Gateway clock, ISO 8601 UTC. */
  decidedAt: string;
  chain: {
    chainId: number;
    vault: Address;
    token: Address;
    identityRegistry: Address;
    /** The block whose state the decision was based on. */
    blockNumber: string;
    blockTimestamp: number;
  };
  who: {
    agentId: string;
    agentWallet: Address | null;
    principal: Address;
    mandateId: string | null;
    executor: Address | null;
    approver: Address | null;
  };
  what: {
    payee: Address;
    /** The payee's name in the principal's vendor registry, if it is there. */
    payeeName: string | null;
    amount: string;
    tokenSymbol: string;
    tokenDecimals: number;
    purpose: string;
    invoiceId: string;
  };
  request: {
    intent: PaymentIntent;
    signature: Hex;
    /** The address recovered from the signature. */
    signer: Address | null;
  };
  why: {
    decision: Decision;
    reasons: string[];
    checks: EvidenceCheck[];
  };
};

/** The approver's signature for a payment outside the mandate. It covers the evidence hash. */
export type EvidenceApproval = {
  approver: Address;
  nonce: string;
  deadline: string;
  signature: Hex;
  receivedAt: string;
};

export type EvidenceResult =
  | { status: 'refused' }
  | { status: 'pending_approval' }
  | {
      status: 'paid';
      transactionHash: Hex;
      blockNumber: string;
      event: 'MandatePayment' | 'ApprovedPayment';
      executedAt: string;
    }
  | { status: 'failed'; error: string; transactionHash: Hex | null; failedAt: string };

/** The file the gateway writes for every decision. Only `record` is covered by `evidenceHash`. */
export type EvidenceFile = {
  format: typeof EVIDENCE_FORMAT;
  evidenceHash: Hex;
  record: EvidenceRecord;
  approval: EvidenceApproval | null;
  result: EvidenceResult;
  updatedAt: string;
};

/** keccak256 of the record's canonical JSON (RFC 8785). */
export function evidenceHash(record: EvidenceRecord): Hex {
  return keccak256(stringToHex(canonicalize(record)));
}

/**
 * The decision that follows from a list of checks: any failed hard check refuses, otherwise any
 * failed soft check needs approval, otherwise the payment goes through on its own.
 */
export function decisionFromChecks(checks: readonly EvidenceCheck[]): Decision {
  if (checks.some((check) => check.kind === 'hard' && check.result !== 'pass')) return 'refused';
  if (checks.some((check) => check.kind === 'soft' && check.result !== 'pass'))
    return 'needs_approval';
  return 'auto';
}
