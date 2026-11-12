import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, type Hex, getAddress, keccak256, stringToHex } from 'viem';

import {
  type ApprovedPaymentRequest,
  type MandatePaymentRequest,
  PaymentError,
  type PaymentExecutor,
  type PaymentReceipt,
} from '../src/chain/executor';
import { chooseMandate } from '../src/chain/mandates';
import {
  type Purchase,
  type PurchaseClient,
  PurchaseError,
  type PurchaseRequest,
} from '../src/chain/purchases';
import type { ChainInfo, ChainReader, Snapshot } from '../src/chain/reader';
import { Gateway } from '../src/gateway';
import { recoverApprovalSigner } from '../src/protocol/approval';
import type { Json } from '../src/protocol/json';
import { EvidenceStore } from '../src/store/evidenceStore';
import { Ledger } from '../src/store/ledger';
import { PayeeDirectory, type PayeesFile } from '../src/store/payees';
import { NOW, USDC, VAULT, newAccount, newAddress } from './helpers';

export const MERCHANT_ORIGIN = 'https://data.tsukimi.example';

/** One mandate as the fake vault holds it, with its own day counter and approval number. */
export type FakeMandate = {
  id: bigint;
  agentId: bigint;
  executor: Address;
  revoked: boolean;
  validUntil: number;
  perPaymentCap: bigint;
  dailyCap: bigint;
  hardCeiling: bigint;
  payees: Set<Address>;
  spentToday: bigint;
  approvalNonce: bigint;
};

/**
 * An in-memory stand-in for Arbitrum: the ERC-8004 registry, the vault with the agent's mandates, and
 * the vault's own rules for payWithinMandate and payWithApproval. It lets the gateway be tested
 * without a chain.
 */
export class FakeWorld implements ChainReader, PaymentExecutor {
  /** The gateway's executor key. Tests use it to show that it cannot approve its own payments. */
  readonly executorAccount = newAccount();
  readonly address = this.executorAccount.address;
  readonly principal = newAddress();
  readonly approverAccount = newAccount();
  readonly approver = this.approverAccount.address;
  readonly agent = newAccount();
  readonly agentId = 354n;
  readonly spendWallet = newAddress();
  readonly merchant = newAddress();
  readonly vendorA = newAddress();
  readonly vendorB = newAddress();
  readonly unlistedVendor = newAddress();

  time = NOW;
  blockNumber = 1_000n;
  paused = false;
  balance = 30n * USDC;

  agents = new Map<bigint, { wallet: Address | null; active: boolean | null }>([
    [this.agentId, { wallet: this.agent.address, active: true }],
  ]);

  /** The agent's mandate. By default it lists the spend wallet and both vendors. */
  mandate: FakeMandate | null = {
    id: 1n,
    agentId: this.agentId,
    executor: this.address,
    revoked: false,
    validUntil: NOW + 30 * 86_400,
    perPaymentCap: 2n * USDC,
    dailyCap: 8n * USDC,
    hardCeiling: 20n * USDC,
    payees: new Set([this.spendWallet, this.vendorA, this.vendorB]),
    spentToday: 0n,
    approvalNonce: 0n,
  };

  /** A second, newer mandate for the same agent, when a test gives the spend wallet its own. */
  spendMandate: FakeMandate | null = null;

  readonly usedEvidence = new Set<Hex>();
  /** The approval nonce each approved payment used, by evidence hash. */
  readonly approvalNonces = new Map<Hex, bigint>();
  readonly payments: (MandatePaymentRequest & { event: PaymentReceipt['event'] })[] = [];
  snapshots = 0;

  /** Called between the gateway's decision and its payment, to simulate the world changing. */
  beforePayment: (() => void) | null = null;

  /**
   * Splits the agent's authority the way the demo does: the first mandate keeps the vendors, and a new
   * small one lists the spend wallet alone (0.50 per payment, 1 per day, ceiling 1).
   */
  splitMandates(): FakeMandate {
    this.mandate?.payees.delete(this.spendWallet);
    this.spendMandate = {
      id: 2n,
      agentId: this.agentId,
      executor: this.address,
      revoked: false,
      validUntil: NOW + 30 * 86_400,
      perPaymentCap: USDC / 2n,
      dailyCap: USDC,
      hardCeiling: USDC,
      payees: new Set([this.spendWallet]),
      spentToday: 0n,
      approvalNonce: 0n,
    };
    return this.spendMandate;
  }

  /** Today's total of the first mandate. */
  get spentToday(): bigint {
    return this.mandate?.spentToday ?? 0n;
  }
  set spentToday(value: bigint) {
    if (this.mandate !== null) this.mandate.spentToday = value;
  }

  /** The next approval number of the first mandate. */
  get approvalNonce(): bigint {
    return this.mandate?.approvalNonce ?? 0n;
  }

  /** The agent's mandates, newest first, as the vault would list them. */
  private mandates(): FakeMandate[] {
    return [this.spendMandate, this.mandate]
      .filter((mandate): mandate is FakeMandate => mandate !== null)
      .sort((a, b) => (a.id > b.id ? -1 : 1));
  }

  info(): Promise<ChainInfo> {
    return Promise.resolve({
      chainId: 421_614,
      vault: VAULT,
      principal: this.principal,
      token: getAddress('0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'),
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      identityRegistry: getAddress('0x8004a818bfb912233c491871b3d84c89a494bd9e'),
    });
  }

  snapshot({
    agentId,
    payee,
    executor,
    mandateId,
  }: {
    agentId: bigint;
    payee: Address;
    executor: Address;
    mandateId?: bigint | undefined;
  }): Promise<Snapshot> {
    this.snapshots += 1;
    const agent = this.agents.get(agentId);
    const candidates = this.mandates()
      .filter((mandate) => mandate.agentId === agentId)
      .map((mandate) => ({ ...mandate, payees: [...mandate.payees] }));
    const mandate = chooseMandate(candidates, { payee, executor, now: this.time, mandateId });
    return Promise.resolve({
      blockNumber: this.blockNumber,
      blockTimestamp: this.time,
      agent:
        agent === undefined
          ? { registered: false, wallet: null, active: null }
          : { registered: true, wallet: agent.wallet, active: agent.active },
      mandate:
        mandate === null
          ? null
          : {
              id: mandate.id,
              executor: mandate.executor,
              approver: this.approver,
              revoked: mandate.revoked,
              validUntil: mandate.validUntil,
              perPaymentCap: mandate.perPaymentCap,
              dailyCap: mandate.dailyCap,
              hardCeiling: mandate.hardCeiling,
              approvalNonce: mandate.approvalNonce,
              payeeAllowed: mandate.payees.includes(payee),
              spentToday: mandate.spentToday,
            },
      vault: { paused: this.paused, balance: this.balance },
    });
  }

  approvalState(mandateId: bigint): Promise<{ nonce: bigint; blockTimestamp: number }> {
    const mandate = this.mandates().find((item) => item.id === mandateId);
    return Promise.resolve({ nonce: mandate?.approvalNonce ?? 0n, blockTimestamp: this.time });
  }

  private refuse(error: string): Promise<never> {
    return Promise.reject(new PaymentError(`the vault refused: ${error}`, null));
  }

  private settle(
    mandate: FakeMandate,
    request: MandatePaymentRequest,
    event: PaymentReceipt['event'],
  ): Promise<PaymentReceipt> {
    mandate.spentToday += request.amount;
    this.balance -= request.amount;
    this.usedEvidence.add(request.evidenceHash);
    this.payments.push({ ...request, event });
    this.blockNumber += 1n;
    return Promise.resolve({
      transactionHash: keccak256(request.evidenceHash),
      blockNumber: this.blockNumber,
      event,
    });
  }

  /** The vault's rules, restated: this is what MandateVault.payWithinMandate enforces onchain. */
  payWithinMandate(request: MandatePaymentRequest): Promise<PaymentReceipt> {
    this.beforePayment?.();
    const mandate = this.mandates().find((item) => item.id === request.mandateId);

    if (this.paused) return this.refuse('EnforcedPause()');
    if (mandate === undefined) return this.refuse('NotExecutor()');
    if (mandate.revoked) return this.refuse(`MandateIsRevoked(${mandate.id})`);
    if (this.time > mandate.validUntil) return this.refuse(`MandateExpired(${mandate.id})`);
    if (!mandate.payees.has(request.payee)) {
      return this.refuse(`PayeeNotAllowed(${mandate.id}, ${request.payee})`);
    }
    if (request.amount === 0n) return this.refuse('ZeroAmount()');
    if (request.amount > mandate.perPaymentCap) return this.refuse('PerPaymentCapExceeded()');
    if (mandate.spentToday + request.amount > mandate.dailyCap) {
      return this.refuse('DailyCapExceeded()');
    }
    if (this.usedEvidence.has(request.evidenceHash)) return this.refuse('EvidenceAlreadyUsed()');
    if (request.amount > this.balance) return this.refuse('ERC20InsufficientBalance()');

    return this.settle(mandate, request, 'MandatePayment');
  }

  /** And what MandateVault.payWithApproval enforces: the approver's signature and the hard ceiling. */
  async payWithApproval(request: ApprovedPaymentRequest): Promise<PaymentReceipt> {
    this.beforePayment?.();
    const mandate = this.mandates().find((item) => item.id === request.mandateId);

    if (this.paused) return this.refuse('EnforcedPause()');
    if (mandate === undefined) return this.refuse('NotExecutor()');
    if (mandate.revoked) return this.refuse(`MandateIsRevoked(${mandate.id})`);
    if (this.time > mandate.validUntil) return this.refuse(`MandateExpired(${mandate.id})`);
    if (request.amount === 0n) return this.refuse('ZeroAmount()');
    if (BigInt(this.time) > request.deadline) return this.refuse('ApprovalExpired()');
    if (mandate.spentToday + request.amount > mandate.hardCeiling) {
      return this.refuse('HardCeilingExceeded()');
    }

    const signer = await recoverApprovalSigner(
      { chainId: 421_614, address: VAULT },
      {
        mandateId: request.mandateId,
        payee: request.payee,
        amount: request.amount,
        evidenceHash: request.evidenceHash,
        nonce: mandate.approvalNonce,
        deadline: request.deadline,
      },
      request.signature,
    );
    if (signer !== this.approver) return this.refuse('InvalidApproval()');
    if (this.usedEvidence.has(request.evidenceHash)) return this.refuse('EvidenceAlreadyUsed()');
    if (request.amount > this.balance) return this.refuse('ERC20InsufficientBalance()');

    this.approvalNonces.set(request.evidenceHash, mandate.approvalNonce);
    mandate.approvalNonce += 1n;
    return this.settle(mandate, request, 'ApprovedPayment');
  }
}

/** A stand-in for the merchant's paid API and the spend wallet that pays it. */
export class FakePurchases implements PurchaseClient {
  readonly calls: PurchaseRequest[] = [];
  /** The token transfer each settlement made, by transaction hash. */
  readonly settlements = new Map<Hex, { from: Address; to: Address; value: bigint }>();
  /** What the merchant returns. */
  body: Json = { symbol: 'TSK-LOGI20', price: 1234.5, vendor_note: null };
  /** Set to make the purchase fail after the vault has topped up the spend wallet. */
  failWith: string | null = null;

  constructor(readonly spendWallet: Address) {}

  buy(request: PurchaseRequest): Promise<Purchase> {
    this.calls.push(request);
    if (this.failWith !== null) return Promise.reject(new PurchaseError(this.failWith));
    const text = JSON.stringify(this.body);
    const settlementTransactionHash = keccak256(stringToHex(`settlement ${this.calls.length}`));
    this.settlements.set(settlementTransactionHash, {
      from: this.spendWallet,
      to: request.merchant,
      value: request.amount,
    });
    return Promise.resolve({
      settlementTransactionHash,
      settledAt: '2026-11-13T03:00:05.000Z',
      body: this.body,
      responseHash: keccak256(stringToHex(text)),
    });
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** A gateway wired to a FakeWorld, with its ledger and evidence in a temporary directory. */
export async function createHarness(options: { spendWallet?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agw-gateway-'));
  const world = new FakeWorld();
  const purchases = options.spendWallet === false ? null : new FakePurchases(world.spendWallet);
  const payees: PayeesFile = {
    vendors: [
      { name: 'Koishi Supply', address: world.vendorA },
      { name: 'Nagikumo Research', address: world.vendorB },
      { name: 'Hatsuka Research', address: world.unlistedVendor },
      { name: 'Agent Gateway spend wallet', address: world.spendWallet },
      { name: 'Tsukimi Data', address: world.merchant, origin: MERCHANT_ORIGIN },
    ],
    denylist: [],
  };
  const ledger = await Ledger.open(join(dir, 'ledger.jsonl'));
  const evidence = new EvidenceStore(join(dir, 'evidence'));
  let clock = NOW * 1000;
  const gateway = new Gateway({
    chain: world,
    executor: world,
    ledger,
    evidence,
    loadPayees: () => Promise.resolve(new PayeeDirectory(payees)),
    purchases,
    purchaseCallCap: 500_000n,
    now: () => new Date((clock += 1000)),
  });
  return {
    dir,
    world,
    purchases,
    payees,
    ledger,
    evidence,
    gateway,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
