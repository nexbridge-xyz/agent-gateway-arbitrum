import { type Hex, formatUnits } from 'viem';

import { type PaymentExecutor, PaymentError } from './chain/executor';
import type { ChainReader } from './chain/reader';
import { evaluate } from './policy/evaluate';
import {
  type Decision,
  EVIDENCE_FORMAT,
  EVIDENCE_RECORD_FORMAT,
  type EvidenceFile,
  type EvidenceRecord,
  type EvidenceResult,
  evidenceHash,
} from './protocol/evidence';
import {
  type SignedIntent,
  intentId,
  recoverIntentSigner,
  signedIntentSchema,
} from './protocol/intent';
import type { EvidenceStore } from './store/evidenceStore';
import type { Ledger } from './store/ledger';
import type { PayeeDirectory } from './store/payees';

/** What the gateway tells the caller about one intent. */
export type IntentOutcome = {
  intentId: Hex;
  decision: Decision;
  reasons: string[];
  status: EvidenceResult['status'];
  evidenceHash: Hex;
  transactionHash: Hex | null;
  error: string | null;
};

export type GatewayOptions = {
  chain: ChainReader;
  executor: PaymentExecutor;
  ledger: Ledger;
  evidence: EvidenceStore;
  /** Reads the principal's vendor registry and denylist. Called for every decision. */
  loadPayees: () => Promise<PayeeDirectory>;
  now?: () => Date;
};

const MAX_SOURCE_LENGTH = 200;

/**
 * The gateway: takes a signed payment intent, checks who sent it, decides by policy, writes the
 * evidence record, and pays through the vault when the decision is "auto".
 */
export class Gateway {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get executorAddress() {
    return this.options.executor.address;
  }

  /**
   * Decides one intent. Throws a ZodError when the body is not a well-formed signed intent.
   * Decisions run one at a time, so each one sees the spending of the one before it.
   */
  async submit(body: unknown): Promise<IntentOutcome> {
    const signed = signedIntentSchema.parse(body);
    const run = this.queue.then(() => this.decide(signed));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async evidenceFor(id: Hex): Promise<EvidenceFile | null> {
    return this.options.evidence.get(id);
  }

  private async decide(signed: SignedIntent): Promise<IntentOutcome> {
    const { chain, executor, ledger, evidence } = this.options;
    const { intent } = signed;
    const info = await chain.info();
    const domain = { chainId: info.chainId, vault: info.vault };
    const id = intentId(domain, intent);

    // The same intent always gets the same answer, and is never paid twice.
    const known = await evidence.get(id);
    if (known !== null) return outcomeOf(known);

    const amount = BigInt(intent.amount);
    const [snapshot, signer, payees] = await Promise.all([
      chain.snapshot({
        agentId: BigInt(intent.agentId),
        payee: intent.payee,
        executor: executor.address,
      }),
      recoverIntentSigner(domain, signed),
      this.options.loadPayees(),
    ]);
    const vendor = payees.vendor(intent.payee);
    const claimedSource = intent.context.payeeSource;

    const policy = evaluate({
      now: snapshot.blockTimestamp,
      gatewayExecutor: executor.address,
      request: {
        payee: intent.payee,
        amount,
        expiresAt: intent.expiresAt,
        signer,
        payeeSource:
          typeof claimedSource === 'string' ? claimedSource.slice(0, MAX_SOURCE_LENGTH) : null,
      },
      agent: snapshot.agent,
      mandate: snapshot.mandate,
      vault: snapshot.vault,
      payee: { vendor, denied: payees.denial(intent.payee) },
      token: { symbol: info.tokenSymbol, decimals: info.tokenDecimals },
    });

    const decidedAt = this.now().toISOString();
    const record: EvidenceRecord = {
      format: EVIDENCE_RECORD_FORMAT,
      intentId: id,
      decidedAt,
      chain: {
        chainId: info.chainId,
        vault: info.vault,
        token: info.token,
        identityRegistry: info.identityRegistry,
        blockNumber: snapshot.blockNumber.toString(),
        blockTimestamp: snapshot.blockTimestamp,
      },
      who: {
        agentId: intent.agentId,
        agentWallet: snapshot.agent.wallet,
        principal: info.principal,
        mandateId: snapshot.mandate?.id.toString() ?? null,
        executor: snapshot.mandate?.executor ?? null,
        approver: snapshot.mandate?.approver ?? null,
      },
      what: {
        payee: intent.payee,
        payeeName: vendor?.name ?? null,
        amount: intent.amount,
        tokenSymbol: info.tokenSymbol,
        tokenDecimals: info.tokenDecimals,
        purpose: intent.purpose,
        invoiceId: intent.invoiceId,
      },
      request: { intent, signature: signed.signature as Hex, signer },
      why: { decision: policy.decision, reasons: policy.reasons, checks: policy.checks },
    };
    const hash = evidenceHash(record);

    const file: EvidenceFile = {
      format: EVIDENCE_FORMAT,
      evidenceHash: hash,
      record,
      approval: null,
      result: initialResult(policy.decision),
      updatedAt: decidedAt,
    };
    const money = `${formatUnits(amount, info.tokenDecimals)} ${info.tokenSymbol}`;
    const payeeLabel = vendor === null ? intent.payee : `${vendor.name} (${intent.payee})`;

    await evidence.save(file);
    await ledger.append(
      'INTENT_DECIDED',
      `${policy.decision}: agent ${intent.agentId} asks to pay ${money} to ${payeeLabel}`,
      {
        intentId: id,
        evidenceHash: hash,
        decision: policy.decision,
        agentId: intent.agentId,
        mandateId: record.who.mandateId,
        payee: intent.payee,
        amount: intent.amount,
        reasons: policy.reasons,
      },
      this.now(),
    );

    if (policy.decision === 'auto' && snapshot.mandate !== null) {
      try {
        const receipt = await executor.payWithinMandate({
          mandateId: snapshot.mandate.id,
          payee: intent.payee,
          amount,
          evidenceHash: hash,
        });
        const executedAt = this.now();
        file.result = {
          status: 'paid',
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber.toString(),
          event: receipt.event,
          executedAt: executedAt.toISOString(),
        };
        await ledger.append(
          'PAYMENT_EXECUTED',
          `paid ${money} to ${payeeLabel} under mandate ${snapshot.mandate.id}`,
          {
            intentId: id,
            evidenceHash: hash,
            transactionHash: receipt.transactionHash,
            blockNumber: receipt.blockNumber.toString(),
            event: receipt.event,
          },
          executedAt,
        );
      } catch (error) {
        const failure =
          error instanceof PaymentError
            ? error
            : new PaymentError(error instanceof Error ? error.message : 'unknown error', null);
        const failedAt = this.now();
        file.result = {
          status: 'failed',
          error: failure.message,
          transactionHash: failure.transactionHash,
          failedAt: failedAt.toISOString(),
        };
        await ledger.append(
          'PAYMENT_FAILED',
          `payment of ${money} to ${payeeLabel} failed: ${failure.message}`,
          {
            intentId: id,
            evidenceHash: hash,
            error: failure.message,
            transactionHash: failure.transactionHash,
          },
          failedAt,
        );
      }
      file.updatedAt = this.now().toISOString();
      await evidence.save(file);
    }

    return outcomeOf(file);
  }
}

function initialResult(decision: Decision): EvidenceResult {
  if (decision === 'auto') return { status: 'executing' };
  if (decision === 'needs_approval') return { status: 'pending_approval' };
  return { status: 'refused' };
}

export function outcomeOf(file: EvidenceFile): IntentOutcome {
  const { result } = file;
  return {
    intentId: file.record.intentId,
    decision: file.record.why.decision,
    reasons: file.record.why.reasons,
    status: result.status,
    evidenceHash: file.evidenceHash,
    transactionHash:
      result.status === 'paid' || result.status === 'failed' ? result.transactionHash : null,
    error: result.status === 'failed' ? result.error : null,
  };
}
