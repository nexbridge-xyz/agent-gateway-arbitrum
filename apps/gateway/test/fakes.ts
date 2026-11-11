import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, type Hex, getAddress, keccak256 } from 'viem';

import {
  type MandatePaymentRequest,
  PaymentError,
  type PaymentExecutor,
  type PaymentReceipt,
} from '../src/chain/executor';
import type { ChainInfo, ChainReader, Snapshot } from '../src/chain/reader';
import { Gateway } from '../src/gateway';
import { EvidenceStore } from '../src/store/evidenceStore';
import { Ledger } from '../src/store/ledger';
import { PayeeDirectory, type PayeesFile } from '../src/store/payees';
import { NOW, USDC, VAULT, newAccount, newAddress } from './helpers';

/**
 * An in-memory stand-in for Arbitrum: the ERC-8004 registry, the vault with one mandate, and the
 * vault's own rules for payWithinMandate. It lets the gateway be tested without a chain.
 */
export class FakeWorld implements ChainReader, PaymentExecutor {
  readonly address = newAddress(); // the gateway's executor
  readonly principal = newAddress();
  readonly approver = newAddress();
  readonly agent = newAccount();
  readonly agentId = 354n;
  readonly vendorA = newAddress();
  readonly vendorB = newAddress();
  readonly unlistedVendor = newAddress();

  time = NOW;
  blockNumber = 1_000n;
  paused = false;
  balance = 10n * USDC;
  spentToday = 0n;

  agents = new Map<bigint, { wallet: Address | null; active: boolean | null }>([
    [this.agentId, { wallet: this.agent.address, active: true }],
  ]);

  mandate: {
    id: bigint;
    agentId: bigint;
    executor: Address;
    revoked: boolean;
    validUntil: number;
    perPaymentCap: bigint;
    dailyCap: bigint;
    hardCeiling: bigint;
    payees: Set<Address>;
  } | null = {
    id: 1n,
    agentId: this.agentId,
    executor: this.address,
    revoked: false,
    validUntil: NOW + 30 * 86_400,
    perPaymentCap: 2n * USDC,
    dailyCap: 8n * USDC,
    hardCeiling: 20n * USDC,
    payees: new Set([this.vendorA, this.vendorB]),
  };

  readonly usedEvidence = new Set<Hex>();
  readonly payments: MandatePaymentRequest[] = [];
  snapshots = 0;

  /** Called between the gateway's decision and its payment, to simulate the world changing. */
  beforePayment: (() => void) | null = null;

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
  }: {
    agentId: bigint;
    payee: Address;
    executor: Address;
  }): Promise<Snapshot> {
    this.snapshots += 1;
    const agent = this.agents.get(agentId);
    const mandate = this.mandate !== null && this.mandate.agentId === agentId ? this.mandate : null;
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
              payeeAllowed: mandate.payees.has(payee),
              spentToday: this.spentToday,
            },
      vault: { paused: this.paused, balance: this.balance },
    });
  }

  /** The vault's rules, restated: this is what MandateVault.payWithinMandate enforces onchain. */
  payWithinMandate(request: MandatePaymentRequest): Promise<PaymentReceipt> {
    this.beforePayment?.();
    const refuse = (error: string) =>
      Promise.reject(new PaymentError(`the vault refused: ${error}`, null));
    const mandate = this.mandate;

    if (this.paused) return refuse('EnforcedPause()');
    if (mandate === null || mandate.id !== request.mandateId) return refuse('NotExecutor()');
    if (mandate.revoked) return refuse(`MandateIsRevoked(${mandate.id})`);
    if (this.time > mandate.validUntil) return refuse(`MandateExpired(${mandate.id})`);
    if (!mandate.payees.has(request.payee))
      return refuse(`PayeeNotAllowed(${mandate.id}, ${request.payee})`);
    if (request.amount === 0n) return refuse('ZeroAmount()');
    if (request.amount > mandate.perPaymentCap) return refuse('PerPaymentCapExceeded()');
    if (this.spentToday + request.amount > mandate.dailyCap) return refuse('DailyCapExceeded()');
    if (this.usedEvidence.has(request.evidenceHash)) return refuse('EvidenceAlreadyUsed()');
    if (request.amount > this.balance) return refuse('ERC20InsufficientBalance()');

    this.spentToday += request.amount;
    this.balance -= request.amount;
    this.usedEvidence.add(request.evidenceHash);
    this.payments.push(request);
    this.blockNumber += 1n;
    return Promise.resolve({
      transactionHash: keccak256(request.evidenceHash),
      blockNumber: this.blockNumber,
      event: 'MandatePayment',
    });
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** A gateway wired to a FakeWorld, with its ledger and evidence in a temporary directory. */
export async function createHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'agw-gateway-'));
  const world = new FakeWorld();
  const payees: PayeesFile = {
    vendors: [
      { name: 'Tsukimi Data', address: world.vendorA },
      { name: 'Koishi Supply', address: world.vendorB },
      { name: 'Hatsuka Research', address: world.unlistedVendor },
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
    now: () => new Date((clock += 1000)),
  });
  return {
    dir,
    world,
    payees,
    ledger,
    evidence,
    gateway,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
