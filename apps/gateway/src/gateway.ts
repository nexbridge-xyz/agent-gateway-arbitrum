import { type Address, type Hex, formatUnits, hashTypedData, isAddressEqual } from 'viem';
import { z } from 'zod';

import { type PaymentExecutor, PaymentError, type PaymentReceipt } from './chain/executor';
import { type PurchaseClient, PurchaseError } from './chain/purchases';
import type { ChainInfo, ChainReader, Snapshot } from './chain/reader';
import { RequestError } from './errors';
import { type PolicyResult, evaluate } from './policy/evaluate';
import {
  approvalTypedData,
  declineTypedData,
  recoverApprovalSigner,
  recoverDeclineSigner,
} from './protocol/approval';
import {
  type Decision,
  EVIDENCE_FORMAT,
  EVIDENCE_RECORD_FORMAT,
  type EvidenceFile,
  type EvidenceRecord,
  type EvidenceResult,
  type PurchaseOutcome,
  evidenceHash,
} from './protocol/evidence';
import {
  type SignedIntent,
  intentId,
  recoverIntentSigner,
  signedIntentSchema,
} from './protocol/intent';
import type { Json } from './protocol/json';
import type { EvidenceStore } from './store/evidenceStore';
import type { Ledger } from './store/ledger';
import type { PayeeDirectory, PayeesFile } from './store/payees';

/** What the gateway tells the caller about one intent. */
export type IntentOutcome = {
  intentId: Hex;
  decision: Decision;
  reasons: string[];
  status: EvidenceResult['status'];
  evidenceHash: Hex;
  transactionHash: Hex | null;
  error: string | null;
  /** For a per-call purchase: what happened at the merchant. */
  purchase: PurchaseOutcome | null;
  /** For a per-call purchase that settled: what the merchant returned. Not stored by the gateway. */
  data?: Json;
};

/** One payment waiting for the approver, with the exact message to sign. */
export type PendingApproval = {
  intentId: Hex;
  evidenceHash: Hex;
  decidedAt: string;
  agentId: string;
  mandateId: string;
  approver: Address;
  payee: Address;
  payeeName: string | null;
  amount: string;
  tokenSymbol: string;
  tokenDecimals: number;
  purpose: string;
  invoiceId: string;
  reasons: string[];
  /** EIP-712 typed data for the approver's wallet. Numbers are decimal strings. */
  approval: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    primaryType: 'PaymentApproval';
    message: {
      mandateId: string;
      payee: Address;
      amount: string;
      evidenceHash: Hex;
      nonce: string;
      deadline: string;
    };
  };
  /** EIP-712 typed data for saying no. */
  decline: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    primaryType: 'ApprovalDecline';
    message: { intentId: Hex; evidenceHash: Hex };
  };
};

export type GatewayOptions = {
  chain: ChainReader;
  executor: PaymentExecutor;
  ledger: Ledger;
  evidence: EvidenceStore;
  /** Reads the principal's vendor registry and denylist. Called for every decision. */
  loadPayees: () => Promise<PayeeDirectory>;
  /** Buys per call with the spend wallet. Null if this gateway has no spend wallet. */
  purchases?: PurchaseClient | null;
  /** The most the gateway pays for one API call, in the token's smallest unit. */
  purchaseCallCap?: bigint;
  now?: () => Date;
};

const MAX_SOURCE_LENGTH = 200;
const APPROVAL_WINDOW_SECONDS = 600n;
const DEFAULT_CALL_CAP = 500_000n; // 0.50 USDC

const signatureField = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, 'must be a 65-byte signature in hex');
const approvalSchema = z.strictObject({
  signature: signatureField,
  /** Last second (Unix time) at which the vault accepts this approval. */
  deadline: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform((value) => BigInt(value)),
});
const declineSchema = z.strictObject({ signature: signatureField });

/**
 * The gateway: takes a signed payment intent, checks who sent it, decides by policy, writes the
 * evidence record, and pays through the vault when the decision is "auto". A payment that needs
 * approval waits until the mandate's approver signs for it.
 */
export class Gateway {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly purchases: PurchaseClient | null;
  private readonly callCap: bigint;

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? (() => new Date());
    this.purchases = options.purchases ?? null;
    this.callCap = options.purchaseCallCap ?? DEFAULT_CALL_CAP;
  }

  get executorAddress() {
    return this.options.executor.address;
  }

  get spendWalletAddress(): Address | null {
    return this.purchases?.spendWallet ?? null;
  }

  /** Everything that changes state runs one at a time, so each step sees the spending before it. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Decides one intent. Throws a ZodError when the body is not a well-formed signed intent. */
  async submit(body: unknown): Promise<IntentOutcome> {
    const signed = signedIntentSchema.parse(body);
    return this.inTurn(() => this.decide(signed));
  }

  /** The approver's signature for a waiting payment. Pays it through the vault. */
  async approve(id: Hex, body: unknown): Promise<IntentOutcome> {
    const { signature, deadline } = approvalSchema.parse(body);
    return this.inTurn(() => this.payApproved(id, signature as Hex, deadline));
  }

  /** The approver's signed refusal of a waiting payment. */
  async decline(id: Hex, body: unknown): Promise<IntentOutcome> {
    const { signature } = declineSchema.parse(body);
    return this.inTurn(() => this.recordDecline(id, signature as Hex));
  }

  async evidenceFor(id: Hex): Promise<EvidenceFile | null> {
    return this.options.evidence.get(id);
  }

  /** The newest decisions first, each with its whole evidence file. */
  async recent(limit: number): Promise<EvidenceFile[]> {
    const { evidence } = this.options;
    const files: EvidenceFile[] = [];
    for (const id of await evidence.list()) {
      const file = await evidence.get(id);
      if (file !== null) files.push(file);
    }
    return files
      .sort((a, b) => b.record.decidedAt.localeCompare(a.record.decidedAt))
      .slice(0, limit);
  }

  /** The principal's vendor registry and denylist, as written. */
  async payees(): Promise<PayeesFile> {
    return (await this.options.loadPayees()).file;
  }

  /** Payments waiting for an approver, oldest first, each with the message to sign. */
  async pendingApprovals(): Promise<PendingApproval[]> {
    const { chain, evidence } = this.options;
    const info = await chain.info();
    const pending: PendingApproval[] = [];

    for (const id of await evidence.list()) {
      const file = await evidence.get(id);
      if (file === null || file.result.status !== 'pending_approval') continue;
      const { record } = file;
      if (record.who.mandateId === null || record.who.approver === null) continue;

      const state = await chain.approvalState(BigInt(record.who.mandateId));
      const vault = { chainId: info.chainId, address: info.vault };
      const typed = approvalTypedData(vault, {
        mandateId: BigInt(record.who.mandateId),
        payee: record.what.payee,
        amount: BigInt(record.what.amount),
        evidenceHash: file.evidenceHash,
        nonce: state.nonce,
        deadline: BigInt(state.blockTimestamp) + APPROVAL_WINDOW_SECONDS,
      });
      const declineTyped = declineTypedData(vault, record.intentId, file.evidenceHash);

      pending.push({
        intentId: record.intentId,
        evidenceHash: file.evidenceHash,
        decidedAt: record.decidedAt,
        agentId: record.who.agentId,
        mandateId: record.who.mandateId,
        approver: record.who.approver,
        payee: record.what.payee,
        payeeName: record.what.payeeName,
        amount: record.what.amount,
        tokenSymbol: record.what.tokenSymbol,
        tokenDecimals: record.what.tokenDecimals,
        purpose: record.what.purpose,
        invoiceId: record.what.invoiceId,
        reasons: record.why.reasons,
        approval: {
          domain: typed.domain,
          primaryType: typed.primaryType,
          message: {
            mandateId: typed.message.mandateId.toString(),
            payee: typed.message.payee,
            amount: typed.message.amount.toString(),
            evidenceHash: typed.message.evidenceHash,
            nonce: typed.message.nonce.toString(),
            deadline: typed.message.deadline.toString(),
          },
        },
        decline: {
          domain: declineTyped.domain,
          primaryType: declineTyped.primaryType,
          message: declineTyped.message,
        },
      });
    }
    return pending.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  }

  // --- Deciding ----------------------------------------------------------------------------------------

  private async decide(signed: SignedIntent): Promise<IntentOutcome> {
    const { chain, executor, ledger, evidence } = this.options;
    const { intent } = signed;
    const info = await chain.info();
    const domain = { chainId: info.chainId, vault: info.vault };
    const id = intentId(domain, intent);

    // The same request always gets the same answer, and is never paid twice. The id covers the intent
    // and not its signature, so a copy of an intent that the agent did not sign has the id of the
    // agent's own request. Such a copy is refused and recorded, but its record must not answer for the
    // agent: only the record of a request the agent's wallet signed, or of these very bytes, is final.
    const known = await evidence.get(id);
    if (known !== null && (isFinal(known) || sameSignature(known, signed))) {
      // A payment that was sent and never confirmed: look at its transaction again before answering.
      await this.settle(known);
      return outcomeOf(known);
    }

    const amount = BigInt(intent.amount);
    const resource = purchaseResource(intent.context);
    const spendWallet = this.purchases?.spendWallet ?? null;
    // For a purchase the vault pays the spend wallet, which then pays the merchant.
    const onchainPayee = resource !== null && spendWallet !== null ? spendWallet : intent.payee;

    const [snapshot, signer, payees] = await Promise.all([
      chain.snapshot({
        agentId: BigInt(intent.agentId),
        payee: onchainPayee,
        executor: executor.address,
      }),
      recoverIntentSigner(domain, signed),
      this.options.loadPayees(),
    ]);
    const vendor = payees.vendor(intent.payee);
    const policy = this.evaluate(info, snapshot, payees, {
      payee: intent.payee,
      amount,
      expiresAt: intent.expiresAt,
      signer,
      context: intent.context,
      resource,
      requestAlreadyAccepted: false,
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
      purchase: resource === null ? null : { protocol: 'mpp', resource, spendWallet },
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
      `${policy.decision}: agent ${intent.agentId} asks to ${resource === null ? 'pay' : 'buy for'} ${money} ${resource === null ? 'to' : 'from'} ${payeeLabel}`,
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

    let data: Json | undefined;
    if (policy.decision === 'auto' && snapshot.mandate !== null) {
      const mandateId = snapshot.mandate.id;
      const paid = await this.pay(file, `under mandate ${mandateId}`, () =>
        executor.payWithinMandate({ mandateId, payee: onchainPayee, amount, evidenceHash: hash }),
      );
      if (paid && resource !== null) data = await this.buy(file, info, resource);
      file.updatedAt = this.now().toISOString();
      await evidence.save(file);
    }

    return { ...outcomeOf(file), ...(data === undefined ? {} : { data }) };
  }

  /** Runs the policy on a snapshot. Used for the first decision and again at approval time. */
  private evaluate(
    info: ChainInfo,
    snapshot: Snapshot,
    payees: PayeeDirectory,
    request: {
      payee: Address;
      amount: bigint;
      expiresAt: number;
      signer: Address | null;
      context: SignedIntent['intent']['context'];
      resource: string | null;
      requestAlreadyAccepted: boolean;
    },
  ): PolicyResult {
    const vendor = payees.vendor(request.payee);
    const claimedSource = request.context.payeeSource;
    return evaluate({
      now: snapshot.blockTimestamp,
      gatewayExecutor: this.options.executor.address,
      request: {
        payee: request.payee,
        amount: request.amount,
        expiresAt: request.expiresAt,
        signer: request.signer,
        payeeSource:
          typeof claimedSource === 'string' ? claimedSource.slice(0, MAX_SOURCE_LENGTH) : null,
      },
      agent: snapshot.agent,
      mandate: snapshot.mandate,
      vault: snapshot.vault,
      payee: { vendor, denied: payees.denial(request.payee) },
      token: { symbol: info.tokenSymbol, decimals: info.tokenDecimals },
      purchase:
        request.resource === null
          ? null
          : {
              spendWalletReady: this.purchases !== null,
              resourceOrigin: originOf(request.resource),
              merchantOrigin: vendor?.origin ?? null,
              callCap: this.callCap,
            },
      requestAlreadyAccepted: request.requestAlreadyAccepted,
    });
  }

  // --- Paying ------------------------------------------------------------------------------------------

  /** Sends one vault payment and writes its outcome into the evidence file and the ledger. */
  private async pay(
    file: EvidenceFile,
    how: string,
    send: () => Promise<PaymentReceipt>,
  ): Promise<boolean> {
    const { ledger } = this.options;
    const { record } = file;
    const money = `${formatUnits(BigInt(record.what.amount), record.what.tokenDecimals)} ${record.what.tokenSymbol}`;
    const payeeLabel =
      record.what.payeeName === null
        ? record.what.payee
        : `${record.what.payeeName} (${record.what.payee})`;

    try {
      const receipt = await send();
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
        `paid ${money} ${record.purchase ? 'to the spend wallet for a purchase from' : 'to'} ${payeeLabel} ${how}`,
        {
          intentId: record.intentId,
          evidenceHash: file.evidenceHash,
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber.toString(),
          event: receipt.event,
        },
        executedAt,
      );
      return true;
    } catch (error) {
      const failure =
        error instanceof PaymentError
          ? error
          : new PaymentError(error instanceof Error ? error.message : 'unknown error', null);
      if (failure.unconfirmed && failure.transactionHash !== null) {
        // The transaction left this machine and its receipt could not be read. That is not a failed
        // payment: the vault may have paid, or may still. Say so, and say nothing more than is known.
        file.result = {
          status: 'executing',
          transactionHash: failure.transactionHash,
          unconfirmed: failure.message,
        };
        await ledger.append(
          'PAYMENT_UNCONFIRMED',
          `payment of ${money} to ${payeeLabel} was sent and could not be confirmed: ${failure.message}`,
          {
            intentId: record.intentId,
            evidenceHash: file.evidenceHash,
            transactionHash: failure.transactionHash,
            error: failure.message,
          },
          this.now(),
        );
        return false;
      }
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
          intentId: record.intentId,
          evidenceHash: file.evidenceHash,
          error: failure.message,
          transactionHash: failure.transactionHash,
        },
        failedAt,
      );
      return false;
    }
  }

  /**
   * Looks again at a payment that was sent and could not be confirmed, and writes down what became of
   * it. If the answer is still unknown the file is left as it is.
   */
  private async settle(file: EvidenceFile): Promise<void> {
    const { executor, ledger, evidence } = this.options;
    const { record, result } = file;
    if (result.status !== 'executing' || result.transactionHash === undefined) return;
    const event = file.approval === null ? 'MandatePayment' : 'ApprovedPayment';

    try {
      const receipt = await executor.lookAgain(result.transactionHash, event, file.evidenceHash);
      if (receipt === null) return;
      const executedAt = this.now();
      file.result = {
        status: 'paid',
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        event: receipt.event,
        executedAt: executedAt.toISOString(),
        // For a purchase the vault funded the spend wallet, and the call at the merchant was never made.
        ...(record.purchase
          ? {
              purchase: {
                status: 'failed' as const,
                error: 'the top-up was confirmed late, and the call was not made',
              },
            }
          : {}),
      };
      await ledger.append(
        'PAYMENT_EXECUTED',
        `payment for intent ${record.intentId} was confirmed after all`,
        {
          intentId: record.intentId,
          evidenceHash: file.evidenceHash,
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber.toString(),
          event: receipt.event,
        },
        executedAt,
      );
    } catch (error) {
      if (!(error instanceof PaymentError)) return;
      const failedAt = this.now();
      file.result = {
        status: 'failed',
        error: error.message,
        transactionHash: error.transactionHash,
        failedAt: failedAt.toISOString(),
      };
      await ledger.append(
        'PAYMENT_FAILED',
        `payment for intent ${record.intentId} failed: ${error.message}`,
        {
          intentId: record.intentId,
          evidenceHash: file.evidenceHash,
          error: error.message,
          transactionHash: error.transactionHash,
        },
        failedAt,
      );
    }
    file.updatedAt = this.now().toISOString();
    await evidence.save(file);
  }

  /** After the vault topped up the spend wallet: pays the merchant's challenge and returns the data. */
  private async buy(
    file: EvidenceFile,
    info: ChainInfo,
    resource: string,
  ): Promise<Json | undefined> {
    const { ledger } = this.options;
    const { record, result } = file;
    if (this.purchases === null || result.status !== 'paid') return undefined;
    const money = `${formatUnits(BigInt(record.what.amount), record.what.tokenDecimals)} ${record.what.tokenSymbol}`;

    try {
      const purchase = await this.purchases.buy({
        resource,
        merchant: record.what.payee,
        amount: BigInt(record.what.amount),
        token: info.token,
        chainId: info.chainId,
      });
      result.purchase = {
        status: 'settled',
        settlementTransactionHash: purchase.settlementTransactionHash,
        settledAt: purchase.settledAt,
        responseHash: purchase.responseHash,
      };
      await ledger.append(
        'PURCHASE_SETTLED',
        `spend wallet paid ${money} to ${record.what.payeeName ?? record.what.payee} for ${resource}`,
        {
          intentId: record.intentId,
          evidenceHash: file.evidenceHash,
          settlementTransactionHash: purchase.settlementTransactionHash,
          responseHash: purchase.responseHash,
        },
        this.now(),
      );
      return purchase.body;
    } catch (error) {
      const message =
        error instanceof PurchaseError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'unknown error';
      result.purchase = { status: 'failed', error: message };
      await ledger.append(
        'PURCHASE_FAILED',
        `purchase from ${record.what.payeeName ?? record.what.payee} failed after the top-up: ${message}`,
        { intentId: record.intentId, evidenceHash: file.evidenceHash, error: message },
        this.now(),
      );
      return undefined;
    }
  }

  // --- Approvals ---------------------------------------------------------------------------------------

  private async waiting(id: Hex): Promise<EvidenceFile> {
    const file = await this.options.evidence.get(id);
    if (file === null) throw new RequestError(404, 'No such intent');
    // An approved payment that was sent and never confirmed: see what became of it first.
    await this.settle(file);
    if (file.result.status !== 'pending_approval') {
      throw new RequestError(
        409,
        `This request is not waiting for approval: it is ${file.result.status}`,
      );
    }
    return file;
  }

  private async payApproved(id: Hex, signature: Hex, deadline: bigint): Promise<IntentOutcome> {
    const { chain, executor, ledger, evidence } = this.options;
    const file = await this.waiting(id);
    const { record } = file;
    const info = await chain.info();
    const amount = BigInt(record.what.amount);

    // Look at the chain again: the world may have changed since the request arrived.
    const [snapshot, payees] = await Promise.all([
      chain.snapshot({
        agentId: BigInt(record.who.agentId),
        payee: record.what.payee,
        executor: executor.address,
        // The mandate the request was decided under applies, even if the agent has a newer one now.
        mandateId: record.who.mandateId === null ? undefined : BigInt(record.who.mandateId),
      }),
      this.options.loadPayees(),
    ]);
    const mandate = snapshot.mandate;
    const problems: string[] = [];
    if (mandate === null || mandate.id.toString() !== record.who.mandateId) {
      problems.push('The mandate this request was decided under no longer exists for this agent');
    } else {
      const recheck = this.evaluate(info, snapshot, payees, {
        payee: record.what.payee,
        amount,
        expiresAt: record.request.intent.expiresAt,
        signer: record.request.signer,
        context: record.request.intent.context,
        resource: null,
        requestAlreadyAccepted: true,
      });
      if (recheck.decision === 'refused') problems.push(...recheck.reasons);
    }
    if (mandate === null || problems.length > 0) {
      await ledger.append(
        'APPROVAL_NOT_EXECUTED',
        `approval for intent ${id} was not carried out: ${problems.join('; ')}`,
        { intentId: id, evidenceHash: file.evidenceHash, reasons: problems },
        this.now(),
      );
      throw new RequestError(409, 'The payment can no longer be made', problems);
    }

    if (deadline < BigInt(snapshot.blockTimestamp))
      throw new RequestError(400, 'The approval has expired');
    const vault = { chainId: info.chainId, address: info.vault };
    const approval = {
      mandateId: mandate.id,
      payee: record.what.payee,
      amount,
      evidenceHash: file.evidenceHash,
      nonce: mandate.approvalNonce,
      deadline,
    };
    // Check the signature the way the vault will, so that a signature the vault would refuse is
    // turned away here, before a transaction is sent and the request is spent.
    const byCode = await chain.askApproverCode(
      mandate.approver,
      hashTypedData(approvalTypedData(vault, approval)),
      signature,
    );
    if (byCode === 'not-confirmed') {
      throw new RequestError(
        400,
        `The approver's address ${mandate.approver} has contract code: it is a smart account, or a key with an EIP-7702 delegation. The vault asks that code to confirm a signature, and it did not confirm this one`,
      );
    }
    if (byCode === 'no-code') {
      const signer = await recoverApprovalSigner(vault, approval, signature);
      if (signer === null || !isAddressEqual(signer, mandate.approver)) {
        throw new RequestError(
          400,
          `The signature is not the approver's signature for this payment and approval number ${mandate.approvalNonce}`,
        );
      }
    }

    const receivedAt = this.now();
    file.approval = {
      approver: mandate.approver,
      nonce: mandate.approvalNonce.toString(),
      deadline: deadline.toString(),
      signature,
      receivedAt: receivedAt.toISOString(),
    };
    await ledger.append(
      'APPROVAL_RECEIVED',
      `approver ${mandate.approver} approved intent ${id}`,
      {
        intentId: id,
        evidenceHash: file.evidenceHash,
        approver: mandate.approver,
        nonce: mandate.approvalNonce.toString(),
      },
      receivedAt,
    );
    await evidence.save(file);

    await this.pay(file, `with the approver's signature, mandate ${mandate.id}`, () =>
      executor.payWithApproval({
        mandateId: mandate.id,
        payee: record.what.payee,
        amount,
        evidenceHash: file.evidenceHash,
        deadline,
        signature,
      }),
    );
    file.updatedAt = this.now().toISOString();
    await evidence.save(file);
    return outcomeOf(file);
  }

  private async recordDecline(id: Hex, signature: Hex): Promise<IntentOutcome> {
    const { chain, ledger, evidence } = this.options;
    const file = await this.waiting(id);
    const { record } = file;
    const info = await chain.info();

    const signer = await recoverDeclineSigner(
      { chainId: info.chainId, address: info.vault },
      id,
      file.evidenceHash,
      signature,
    );
    if (
      signer === null ||
      record.who.approver === null ||
      !isAddressEqual(signer, record.who.approver)
    ) {
      throw new RequestError(
        400,
        "The signature is not the approver's signature for declining this request",
      );
    }

    const declinedAt = this.now();
    file.result = {
      status: 'declined',
      approver: record.who.approver,
      signature,
      declinedAt: declinedAt.toISOString(),
    };
    file.updatedAt = declinedAt.toISOString();
    await ledger.append(
      'APPROVAL_DECLINED',
      `approver ${record.who.approver} declined intent ${id}`,
      { intentId: id, evidenceHash: file.evidenceHash, approver: record.who.approver },
      declinedAt,
    );
    await evidence.save(file);
    return outcomeOf(file);
  }
}

/**
 * Whether a stored record settles its intent for good. A record of a request that the agent's
 * registered wallet did not sign can only be a refusal, and says nothing about the agent's own request.
 */
function isFinal(file: EvidenceFile): boolean {
  const { signer } = file.record.request;
  const { agentWallet } = file.record.who;
  const signedByAgent =
    signer !== null && agentWallet !== null && isAddressEqual(signer, agentWallet);
  return signedByAgent || file.result.status !== 'refused';
}

const sameSignature = (file: EvidenceFile, signed: SignedIntent) =>
  file.record.request.signature.toLowerCase() === signed.signature.toLowerCase();

/** The resource of a per-call purchase, from `context.mpp.resource`, or null for a direct payment. */
function purchaseResource(context: SignedIntent['intent']['context']): string | null {
  const mpp = context.mpp;
  if (typeof mpp !== 'object' || mpp === null || Array.isArray(mpp)) return null;
  return typeof mpp.resource === 'string' ? mpp.resource : null;
}

function originOf(resource: string): string | null {
  try {
    const url = new URL(resource);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
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
      result.status === 'paid' || result.status === 'failed'
        ? result.transactionHash
        : result.status === 'executing'
          ? (result.transactionHash ?? null)
          : null,
    error:
      result.status === 'failed'
        ? result.error
        : result.status === 'executing'
          ? (result.unconfirmed ?? null)
          : null,
    purchase: result.status === 'paid' ? (result.purchase ?? null) : null,
  };
}
