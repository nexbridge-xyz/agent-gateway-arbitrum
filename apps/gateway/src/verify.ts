import {
  type Address,
  type Hex,
  type PublicClient,
  erc20Abi,
  isAddressEqual,
  parseEventLogs,
} from 'viem';

import { identityRegistryAbi, mandateVaultAbi } from './chain/abis';
import { MAX_REQUEST_LIFETIME_SECONDS } from './policy/evaluate';
import { recoverApprovalSigner, recoverDeclineSigner } from './protocol/approval';
import {
  type EvidenceFile,
  type EvidenceRecord,
  decisionFromChecks,
  evidenceHash,
} from './protocol/evidence';
import { evidenceFileSchema } from './protocol/evidenceSchema';
import { intentId, recoverIntentSigner } from './protocol/intent';
import { type LedgerEntry, verifyEntries } from './store/ledger';

/**
 * Checks one evidence file: first against itself, then against the chain, then against the ledger.
 * Every check is independent of the gateway that wrote the file.
 */

export type Verdict = 'pass' | 'fail' | 'skipped';
export type VerifyCheck = { verdict: Verdict; label: string; detail: string };

/** What the verifier needs from the chain. */
export type VerifierChain = {
  chainId(): Promise<number>;
  /** The time of a block, Unix seconds, or null if the endpoint does not have that block. */
  blockTimestamp(blockNumber: bigint): Promise<number | null>;
  vaultSettings(
    vault: Address,
  ): Promise<{ principal: Address; token: Address; identityRegistry: Address }>;
  agentWallet(registry: Address, agentId: bigint): Promise<Address | null>;
  evidenceUsed(vault: Address, hash: Hex): Promise<boolean>;
  payment(
    vault: Address,
    transactionHash: Hex,
  ): Promise<{
    found: boolean;
    succeeded: boolean;
    to: Address | null;
    from: Address | null;
    blockNumber: bigint | null;
    events: {
      name: 'MandatePayment' | 'ApprovedPayment';
      mandateId: bigint;
      agentId: bigint;
      payee: Address;
      amount: bigint;
      evidenceHash: Hex;
      approver: Address | null;
      nonce: bigint | null;
    }[];
  }>;
  /** The token transfers in one transaction, for checking a merchant's settlement. */
  tokenTransfers(
    token: Address,
    transactionHash: Hex,
  ): Promise<{
    found: boolean;
    succeeded: boolean;
    transfers: { from: Address; to: Address; value: bigint }[];
  }>;
};

export type VerifyOptions = {
  /** Null runs the offline checks only. */
  chain: VerifierChain | null;
  /** The gateway's ledger, if the verifier has it. */
  ledger?: readonly LedgerEntry[];
  /**
   * The vault the reader means. A file names its own vault, token and registry, and every other check
   * follows what the file names. Without this, a file about somebody else's contract verifies as well
   * as one about yours: say which vault you mean.
   */
  expected?: { chainId: number; vault: Address } | undefined;
};

export type VerifyReport = {
  file: EvidenceFile | null;
  checks: VerifyCheck[];
  verified: boolean;
};

const same = (a: Address | null, b: Address | null) =>
  a !== null && b !== null && isAddressEqual(a, b);

/**
 * The longest a payment inside the mandate may be mined after the block its decision was based on.
 * The gateway sends such a payment at once and waits two minutes for it; this leaves room for a slow
 * endpoint and no room for a record written days later.
 */
export const MAX_PAYMENT_DELAY_SECONDS = 10 * 60;

export async function verifyEvidence(
  input: unknown,
  options: VerifyOptions,
): Promise<VerifyReport> {
  const parsed = evidenceFileSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      file: null,
      checks: [
        {
          verdict: 'fail',
          label: 'File is built like an evidence file',
          detail: first === undefined ? 'unreadable' : `${first.path.join('.')}: ${first.message}`,
        },
      ],
      verified: false,
    };
  }

  const file = parsed.data;
  const { record, result, approval } = file;
  const purchase = record.purchase ?? null;
  const vault = { chainId: record.chain.chainId, address: record.chain.vault };
  const checks: VerifyCheck[] = [];
  const add = (ok: boolean | 'skipped', label: string, detail = '') => {
    checks.push({ verdict: ok === 'skipped' ? 'skipped' : ok ? 'pass' : 'fail', label, detail });
  };

  // --- The file against what the reader asked about ------------------------------------------------

  if (options.expected !== undefined) {
    const { expected } = options;
    add(
      record.chain.chainId === expected.chainId &&
        isAddressEqual(record.chain.vault, expected.vault),
      'Record is about the vault this check was asked for',
      `record: vault ${record.chain.vault} on chain ${record.chain.chainId}; asked for: vault ${expected.vault} on chain ${expected.chainId}`,
    );
  }

  // --- The file against itself ---------------------------------------------------------------------

  // Hash the record exactly as it stands in the file, not a tidied copy of it.
  const recomputed = evidenceHash((input as { record: EvidenceRecord }).record);
  add(recomputed === file.evidenceHash, 'Evidence hash is the hash of the record', recomputed);

  const domain = { chainId: record.chain.chainId, vault: record.chain.vault };
  const signedIntent = { intent: record.request.intent, signature: record.request.signature };
  add(
    intentId(domain, record.request.intent) === record.intentId,
    'Intent id is the hash of the signed request',
  );

  const signer = await recoverIntentSigner(domain, signedIntent);
  add(
    signer !== null && same(signer, record.request.signer),
    'Request signature recovers the recorded signer',
    signer ?? 'unreadable signature',
  );

  const agrees =
    record.request.intent.agentId === record.who.agentId &&
    record.request.intent.payee === record.what.payee &&
    record.request.intent.amount === record.what.amount &&
    record.request.intent.purpose === record.what.purpose &&
    record.request.intent.invoiceId === record.what.invoiceId;
  add(agrees, 'Recorded agent, payee, amount and purpose are the ones the agent signed');

  add(
    decisionFromChecks(record.why.checks) === record.why.decision,
    'Decision follows from the recorded checks',
    `${record.why.decision}; ${record.why.checks.filter((check) => check.result === 'fail').length} failed checks`,
  );

  const signedByAgent = same(record.request.signer, record.who.agentWallet);
  if (record.why.decision === 'refused') {
    add(
      result.status === 'refused',
      'A refused request has no payment',
      `status: ${result.status}`,
    );
  } else {
    add(signedByAgent, "A request that was not refused is signed by the agent's registered wallet");
    const expected =
      record.why.decision === 'auto'
        ? ['paid', 'failed', 'executing']
        : ['paid', 'failed', 'pending_approval', 'declined'];
    add(
      expected.includes(result.status),
      'Result fits the decision',
      `${record.why.decision} then ${result.status}`,
    );
  }

  // A signed request is good for a short time, and the record says at which block it was decided. A
  // record that puts an old request behind a new decision was not decided by this gateway's rules,
  // whoever signed the request. Every request the agent ever signed is in the evidence store, so
  // without this check each of them could be shown again as the reason for another payment.
  if (record.why.decision !== 'refused') {
    const left = record.request.intent.expiresAt - record.chain.blockTimestamp;
    add(
      left >= 0 && left <= MAX_REQUEST_LIFETIME_SECONDS,
      'Request was current at the block the decision was based on',
      left < 0
        ? `it had expired ${-left} seconds before that block`
        : `it ran for ${left} more seconds; at most ${MAX_REQUEST_LIFETIME_SECONDS} are accepted`,
    );
  }

  const paidOutsideMandate = result.status === 'paid' && result.event === 'ApprovedPayment';
  if (record.why.decision === 'needs_approval' && result.status === 'paid') {
    add(
      paidOutsideMandate && approval !== null,
      'A payment that needed approval carries the approval',
    );
  }
  if (record.why.decision === 'auto' && result.status === 'paid') {
    add(
      result.event === 'MandatePayment' && approval === null,
      'A payment inside the mandate needed no approval',
    );
  }

  if (approval !== null) {
    const approvalSigner =
      record.who.mandateId === null
        ? null
        : await recoverApprovalSigner(
            vault,
            {
              mandateId: BigInt(record.who.mandateId),
              payee: record.what.payee,
              amount: BigInt(record.what.amount),
              evidenceHash: file.evidenceHash,
              nonce: BigInt(approval.nonce),
              deadline: BigInt(approval.deadline),
            },
            approval.signature,
          );
    add(
      same(approvalSigner, record.who.approver) && same(approval.approver, record.who.approver),
      "Approval is signed by the mandate's approver, for this payee, amount and evidence hash",
      approvalSigner ?? 'unreadable signature',
    );
  }

  if (result.status === 'declined') {
    const decliner = await recoverDeclineSigner(
      vault,
      record.intentId,
      file.evidenceHash,
      result.signature,
    );
    add(
      same(decliner, record.who.approver) && same(result.approver, record.who.approver),
      "Decline is signed by the mandate's approver, for this request",
      decliner ?? 'unreadable signature',
    );
  }

  if (purchase !== null && result.status === 'paid') {
    add(
      purchase.spendWallet !== null && result.purchase !== undefined,
      'A per-call purchase names the spend wallet and says what happened at the merchant',
      result.purchase?.status ?? 'no purchase outcome',
    );
  }

  // --- The file against the chain ------------------------------------------------------------------

  const { chain } = options;
  const offline = 'not checked: offline';
  if (chain === null) {
    add('skipped', 'Vault settings onchain match the record', offline);
    add('skipped', 'ERC-8004 registry names the recorded agent wallet', offline);
    add('skipped', 'Payment transaction and vault event match the record', offline);
  } else if ((await chain.chainId()) !== record.chain.chainId) {
    add(
      false,
      'RPC endpoint is on the chain named in the record',
      `record says chain ${record.chain.chainId}`,
    );
  } else {
    const settings = await chain.vaultSettings(record.chain.vault);
    add(
      same(settings.principal, record.who.principal) &&
        same(settings.token, record.chain.token) &&
        same(settings.identityRegistry, record.chain.identityRegistry),
      'Vault settings onchain match the record',
      `principal ${settings.principal}`,
    );

    const wallet = await chain.agentWallet(
      record.chain.identityRegistry,
      BigInt(record.who.agentId),
    );
    add(
      record.who.agentWallet === null ? wallet === null : same(wallet, record.who.agentWallet),
      'ERC-8004 registry names the recorded agent wallet',
      `today the registry says ${wallet ?? 'no wallet'}`,
    );

    const used = await chain.evidenceUsed(record.chain.vault, file.evidenceHash);
    if (result.status === 'paid') {
      // For a purchase the vault pays the gateway's spend wallet; otherwise it pays the payee.
      const paidByVault = purchase === null ? record.what.payee : purchase.spendWallet;
      const payment = await chain.payment(record.chain.vault, result.transactionHash);
      add(
        payment.found && payment.succeeded,
        'Payment transaction exists and succeeded',
        result.transactionHash,
      );
      add(
        same(payment.to, record.chain.vault) && same(payment.from, record.who.executor),
        "Transaction was sent to the vault by the mandate's executor",
      );
      const event = payment.events.find((item) => item.evidenceHash === file.evidenceHash);
      add(
        event !== undefined &&
          event.name === result.event &&
          event.mandateId.toString() === record.who.mandateId &&
          event.agentId.toString() === record.who.agentId &&
          same(event.payee, paidByVault) &&
          event.amount.toString() === record.what.amount,
        'Vault event carries this evidence hash and the same mandate, agent, payee and amount',
        event === undefined ? 'no event with this evidence hash' : event.name,
      );
      add(
        payment.blockNumber !== null && payment.blockNumber.toString() === result.blockNumber,
        'Block number matches',
        `block ${result.blockNumber}`,
      );
      if (approval !== null) {
        add(
          event !== undefined &&
            same(event.approver, record.who.approver) &&
            event.nonce?.toString() === approval.nonce,
          'Vault event names the approver and the approval nonce',
        );
      }

      // The block the record names must be a real one with that time: otherwise the check above that
      // the request was current rests on a number the record made up.
      const decisionBlock = BigInt(record.chain.blockNumber);
      const decisionTime = await chain.blockTimestamp(decisionBlock);
      add(
        decisionTime === record.chain.blockTimestamp,
        'Decision block is on the chain with the recorded time',
        decisionTime === null
          ? `the endpoint does not have block ${decisionBlock}`
          : `block ${decisionBlock} at ${decisionTime}`,
      );
      // A payment inside the mandate is sent the moment it is decided. One that was mined long after
      // its decision block was written around an old request. (A payment with an approval waits for a
      // person; there the approver's signature covers this very record, and the vault checks it.)
      if (result.event === 'MandatePayment') {
        const paidTime =
          payment.blockNumber === null ? null : await chain.blockTimestamp(payment.blockNumber);
        const delay = paidTime === null ? null : paidTime - record.chain.blockTimestamp;
        add(
          payment.blockNumber !== null &&
            payment.blockNumber >= decisionBlock &&
            delay !== null &&
            delay >= 0 &&
            delay <= MAX_PAYMENT_DELAY_SECONDS,
          'Payment inside the mandate was mined right after the decision',
          delay === null
            ? 'the time of the payment could not be read'
            : `${delay} seconds after the decision block; at most ${MAX_PAYMENT_DELAY_SECONDS} are accepted`,
        );
      }
      add(used, 'Vault marks this evidence hash as used');

      if (purchase !== null && result.purchase?.status === 'settled') {
        const settlement = await chain.tokenTransfers(
          record.chain.token,
          result.purchase.settlementTransactionHash,
        );
        add(
          settlement.found &&
            settlement.succeeded &&
            settlement.transfers.some(
              (transfer) =>
                same(transfer.from, purchase.spendWallet) &&
                same(transfer.to, record.what.payee) &&
                transfer.value.toString() === record.what.amount,
            ),
          "Merchant's settlement moved the same amount from the spend wallet to the merchant",
          result.purchase.settlementTransactionHash,
        );
      }
    } else {
      add(!used, 'Vault has not paid anything on this evidence hash', `status: ${result.status}`);
    }
  }

  // --- The file against the ledger -----------------------------------------------------------------

  if (options.ledger !== undefined) {
    const chainCheck = verifyEntries(options.ledger);
    add(
      chainCheck.ok,
      'Ledger hash chain is intact',
      chainCheck.ok ? `${chainCheck.count} entries` : chainCheck.why,
    );
    const mine = options.ledger.filter((entry) => entry.data.intentId === record.intentId);
    add(
      mine.some(
        (entry) =>
          entry.kind === 'INTENT_DECIDED' &&
          entry.data.evidenceHash === file.evidenceHash &&
          entry.data.decision === record.why.decision,
      ),
      'Ledger records this decision',
    );
    if (result.status === 'paid') {
      add(
        mine.some(
          (entry) =>
            entry.kind === 'PAYMENT_EXECUTED' &&
            entry.data.transactionHash === result.transactionHash,
        ),
        'Ledger records this payment',
      );
    }
    if (approval !== null) {
      add(
        mine.some(
          (entry) =>
            entry.kind === 'APPROVAL_RECEIVED' && entry.data.approver === approval.approver,
        ),
        'Ledger records the approval',
      );
    }
  }

  return { file, checks, verified: checks.every((check) => check.verdict !== 'fail') };
}

/** Reads what the verifier needs through a viem client. */
export function createVerifierChain(client: PublicClient): VerifierChain {
  return {
    chainId: () => client.getChainId(),

    async blockTimestamp(blockNumber) {
      try {
        return Number((await client.getBlock({ blockNumber })).timestamp);
      } catch {
        return null;
      }
    },

    async vaultSettings(vault) {
      const contract = { address: vault, abi: mandateVaultAbi } as const;
      const [principal, token, identityRegistry] = await Promise.all([
        client.readContract({ ...contract, functionName: 'principal' }),
        client.readContract({ ...contract, functionName: 'token' }),
        client.readContract({ ...contract, functionName: 'identityRegistry' }),
      ]);
      return { principal, token, identityRegistry };
    },

    async agentWallet(registry, agentId) {
      try {
        const wallet = await client.readContract({
          address: registry,
          abi: identityRegistryAbi,
          functionName: 'getAgentWallet',
          args: [agentId],
        });
        return /^0x0{40}$/.test(wallet) ? null : wallet;
      } catch {
        return null;
      }
    },

    evidenceUsed: (vault, hash) =>
      client.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: 'evidenceUsed',
        args: [hash],
      }),

    async payment(vault, transactionHash) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: transactionHash });
      } catch {
        return {
          found: false,
          succeeded: false,
          to: null,
          from: null,
          blockNumber: null,
          events: [],
        };
      }
      const logs = receipt.logs.filter((log) => isAddressEqual(log.address, vault));
      const inside = parseEventLogs({
        abi: mandateVaultAbi,
        logs,
        eventName: 'MandatePayment',
      }).map((log) => ({
        name: 'MandatePayment' as const,
        ...log.args,
        approver: null,
        nonce: null,
      }));
      const approved = parseEventLogs({
        abi: mandateVaultAbi,
        logs,
        eventName: 'ApprovedPayment',
      }).map((log) => ({ name: 'ApprovedPayment' as const, ...log.args }));
      return {
        found: true,
        succeeded: receipt.status === 'success',
        to: receipt.to,
        from: receipt.from,
        blockNumber: receipt.blockNumber,
        events: [...inside, ...approved],
      };
    },

    async tokenTransfers(token, transactionHash) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: transactionHash });
      } catch {
        return { found: false, succeeded: false, transfers: [] };
      }
      const logs = receipt.logs.filter((log) => isAddressEqual(log.address, token));
      const transfers = parseEventLogs({ abi: erc20Abi, logs, eventName: 'Transfer' }).map(
        (log) => ({
          from: log.args.from,
          to: log.args.to,
          value: log.args.value,
        }),
      );
      return { found: true, succeeded: receipt.status === 'success', transfers };
    },
  };
}
