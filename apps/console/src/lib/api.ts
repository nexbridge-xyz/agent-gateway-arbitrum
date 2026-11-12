import type { Hex } from 'viem';

import type {
  ConfigResponse,
  IntentSummary,
  LedgerResponse,
  OutcomeResponse,
  PayeesResponse,
  PendingApproval,
  VerificationResponse,
} from '@agent-gateway/gateway';
import type { EvidenceFile } from '@agent-gateway/gateway/protocol';

/**
 * The gateway's HTTP API, as the console uses it.
 *
 * The types are the gateway's own. They are imported as types only, so none of the gateway's code ends
 * up in the page: the two meet over JSON, and cannot disagree about its shape.
 */

export type { EvidenceFile, IntentSummary, PendingApproval };
export type GatewayConfig = ConfigResponse;
export type Outcome = OutcomeResponse;
export type Ledger = LedgerResponse;
export type LedgerEntry = LedgerResponse['entries'][number];
export type Payees = PayeesResponse;
export type Verification = VerificationResponse;
export type Decision = IntentSummary['decision'];
export type Status = IntentSummary['status'];

/** A request the gateway answered with an error, or could not be reached for. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function read<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    reasons?: string[];
  } | null;
  throw new ApiError(
    response.status,
    body?.error ?? `The gateway answered ${response.status}`,
    body?.reasons ?? [],
  );
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(
      0,
      'The gateway cannot be reached. Is it running? Start it with: pnpm gateway',
    );
  }
  return read<T>(response);
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  config: () => call<GatewayConfig>('/v1/config'),
  intents: () => call<{ intents: IntentSummary[] }>('/v1/payment-intents?limit=200'),
  approvals: () => call<{ approvals: PendingApproval[] }>('/v1/approvals'),
  ledger: () => call<Ledger>('/v1/ledger'),
  payees: () => call<Payees>('/v1/payees'),
  evidence: (intentId: Hex) => call<EvidenceFile>(`/v1/payment-intents/${intentId}`),
  verification: (intentId: Hex) =>
    call<Verification>(`/v1/payment-intents/${intentId}/verification`),
  approve: (intentId: Hex, signature: Hex, deadline: string) =>
    call<Outcome>(`/v1/approvals/${intentId}`, post({ signature, deadline })),
  decline: (intentId: Hex, signature: Hex) =>
    call<Outcome>(`/v1/approvals/${intentId}/decline`, post({ signature })),
  /** The plain text of a mandate, or null if the gateway holds none for this hash. */
  async terms(termsHash: Hex): Promise<string | null> {
    let response: Response;
    try {
      response = await fetch(`/v1/mandate-terms/${termsHash}`);
    } catch {
      throw new ApiError(0, 'The gateway cannot be reached');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError(response.status, 'The mandate text could not be read');
    return response.text();
  },
  async storeTerms(termsHash: Hex, text: string): Promise<void> {
    await call(`/v1/mandate-terms/${termsHash}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: text,
    });
  },
};
