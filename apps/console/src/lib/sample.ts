import type { Hex } from 'viem';

import type {
  EvidenceFile,
  GatewayConfig,
  IntentSummary,
  Ledger,
  Payees,
  PendingApproval,
  Verification,
} from './api';
import { MADE_UP_NOW } from './clock';
import type { Mandate } from './vault';

/**
 * Made-up data for looking at the screens under strain: a thousand rows, very long and very short
 * names, names in other scripts, amounts with many digits, every status, a broken ledger. None of it
 * comes from a chain. The console shows a banner while it is in use.
 */

const hex = (seed: number, bytes: number): Hex => {
  let out = '';
  let state = (seed * 2_654_435_761) >>> 0;
  for (let index = 0; index < bytes; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    out += (state >>> 24).toString(16).padStart(2, '0');
  }
  return `0x${out}`;
};
const address = (seed: number) => hex(seed, 20);

const VAULT = address(1);
const NOW = MADE_UP_NOW;
const NOW_SECONDS = Math.floor(NOW / 1000);

const NAMES: (string | null)[] = [
  'Koishi Supply',
  'Nagikumo Research',
  'Tsukimi Data',
  'K',
  // 78 characters: the vendor registry allows 80.
  'Hoshizora Logistics and Warehousing Holdings, Tokyo Bay Distribution Centre 14',
  '月見データ株式会社',
  'Ünïcødé Ströme GmbH & Co. KG',
  'محل البيانات',
  'Emoji Vendor 🧾📦',
  null,
  // Twenty-five full-width characters without a space, and full-width Latin letters and digits.
  'みなと信託フィナンシャル・ホールディングス株式会社',
  'ＡＢＣ銀行　第２営業部',
];
const PURPOSES = [
  'Invoice KS-2026-1107: packing materials, November',
  'Market data: one TSK-LOGI20 quote',
  'Invoice NR-2026-0042: quarterly sector report',
  'Priority access fee, as asked in a vendor note',
  'Q',
  'Invoice 2026-11-000000000000000000000417: consolidated shipment of packing materials, pallets, labels and protective film for the December orders, including the delayed items from October and the replacement of the damaged cartons that were returned in week 44',
  '請求書 2026-11-12: 市場データ利用料',
  // Text that must be shown as it is, never run or formatted.
  '<script>alert(1)</script> &amp; **bold** <b>not bold</b>',
  'Line one\nLine two, after a line break in a one-line field',
  // One space: the shortest purpose the gateway accepts.
  ' ',
  // 280 characters: the longest purpose the gateway accepts.
  `${'Invoice AB-2026-0001 for the annual maintenance contract of the cold-storage units. '.repeat(3)}Ends here: ${'x'.repeat(280 - 84 * 3 - 11)}`,
];
// The largest amount and agent id the gateway accepts: 2^256 - 1.
const UINT256_MAX = (2n ** 256n - 1n).toString();
const AMOUNTS = [
  '100000',
  '1500000',
  '6000000',
  '4000000',
  '1',
  '12345678901234',
  '999999999999999999',
  UINT256_MAX,
];
const SHAPES: Pick<IntentSummary, 'decision' | 'status'>[] = [
  { decision: 'auto', status: 'paid' },
  { decision: 'auto', status: 'paid' },
  { decision: 'needs_approval', status: 'pending_approval' },
  { decision: 'refused', status: 'refused' },
  { decision: 'needs_approval', status: 'paid' },
  { decision: 'needs_approval', status: 'declined' },
  { decision: 'auto', status: 'failed' },
  { decision: 'auto', status: 'executing' },
];
const REASONS: Record<IntentSummary['decision'], string[]> = {
  auto: ['All 14 checks passed'],
  needs_approval: ['The amount is above the per-payment cap of 2 USDC'],
  refused: [
    "The payee is not in the principal's vendor registry. The address appears only in content the agent read (market-data response for TSK-FOOD30 from http://127.0.0.1:8788), which is not a trusted source",
    "The payment would take today's total above the mandate's hard ceiling of 20 USDC",
  ],
};

function intent(index: number): IntentSummary {
  const shape = SHAPES[index % SHAPES.length] as (typeof SHAPES)[number];
  const purchase = index % 5 === 1;
  const paid = shape.status === 'paid';
  const transactionHash = paid || shape.status === 'failed' ? hex(index + 9000, 32) : null;
  return {
    intentId: hex(index + 100, 32),
    decidedAt: new Date(NOW - index * 47_000).toISOString(),
    updatedAt: new Date(NOW - index * 47_000 + 4000).toISOString(),
    agentId: index % 7 === 0 ? UINT256_MAX : '354',
    mandateId: shape.decision === 'refused' && index % 2 === 0 ? null : String(3 + (index % 2)),
    payee: address(index % 23),
    payeeName: NAMES[index % NAMES.length] ?? null,
    amount: AMOUNTS[index % AMOUNTS.length] as string,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    purpose: PURPOSES[index % PURPOSES.length] as string,
    invoiceId: index % 3 === 0 ? 'KS-2026-1107' : '',
    decision: shape.decision,
    status: shape.status,
    reasons: REASONS[shape.decision],
    payeeSource: shape.decision === 'refused' ? 'market-data response for TSK-FOOD30' : null,
    evidenceHash: hex(index + 5000, 32),
    transactionHash,
    explorerUrl:
      transactionHash === null ? null : `https://sepolia.arbiscan.io/tx/${transactionHash}`,
    purchase: purchase
      ? {
          resource: 'http://127.0.0.1:8788/v1/quotes/TSK-LOGI20',
          status: paid ? (index % 10 === 1 ? 'failed' : 'settled') : null,
          settlementTransactionHash: paid && index % 10 !== 1 ? hex(index + 7000, 32) : null,
          settlementUrl:
            paid && index % 10 !== 1
              ? `https://sepolia.arbiscan.io/tx/${hex(index + 7000, 32)}`
              : null,
        }
      : null,
    approvedBy: shape.decision === 'needs_approval' && paid ? address(77) : null,
    error:
      shape.status !== 'failed'
        ? null
        : index % 16 === 6
          ? 'the vault refused: DailyCapExceeded(8100000, 8000000)'
          : // What a network failure looks like when it is passed on as it came.
            'HTTP request failed.\n\nURL: https://sepolia-rollup.arbitrum.io/rpc\nRequest body: {"method":"eth_sendRawTransaction","params":["0x02f8b383066eee80830f4240830f4240830249f094…"]}\n\nDetails: fetch failed\nVersion: viem@2.57.15',
  };
}

const INTENTS = Array.from({ length: 1000 }, (_, index) => intent(index));

const domain = (name: string) => ({
  name,
  version: '1',
  chainId: 421_614,
  verifyingContract: VAULT,
});

function pending(index: number, deadlineIn: number): PendingApproval {
  const base = INTENTS[2 + index * 8] as IntentSummary;
  return {
    intentId: base.intentId,
    evidenceHash: base.evidenceHash,
    decidedAt: base.decidedAt,
    agentId: base.agentId,
    mandateId: '9',
    approver: address(77),
    payee: base.payee,
    payeeName: NAMES[(index * 4) % NAMES.length] ?? null,
    amount: AMOUNTS[(index + 2) % AMOUNTS.length] as string,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    purpose: PURPOSES[(index * 3 + 2) % PURPOSES.length] as string,
    invoiceId: index === 0 ? 'NR-2026-0042' : '',
    reasons:
      index === 1
        ? [
            ...REASONS.needs_approval,
            "The payee is in the vendor registry but not yet on this mandate's allowlist",
          ]
        : REASONS.needs_approval,
    approval: {
      domain: domain('MandateVault'),
      primaryType: 'PaymentApproval',
      message: {
        mandateId: '9',
        payee: base.payee,
        amount: AMOUNTS[(index + 2) % AMOUNTS.length] as string,
        evidenceHash: base.evidenceHash,
        nonce: String(index),
        deadline: String(NOW_SECONDS + deadlineIn),
      },
    },
    decline: {
      domain: domain('AgentGateway'),
      primaryType: 'ApprovalDecline',
      message: { intentId: base.intentId, evidenceHash: base.evidenceHash },
    },
  };
}

const mandate = (id: bigint, changes: Partial<Mandate>): Mandate => ({
  id,
  agentId: 354n,
  executor: address(70),
  approver: address(77),
  validUntil: NOW_SECONDS + 30 * 86_400,
  revoked: false,
  perPaymentCap: 2_000_000n,
  dailyCap: 8_000_000n,
  hardCeiling: 20_000_000n,
  approvalNonce: 1n,
  termsHash: hex(Number(id) + 300, 32),
  payees: [address(0), address(1)],
  spentToday: 0n,
  active: true,
  ...changes,
});

const LEDGER_KINDS = [
  'INTENT_DECIDED',
  'PAYMENT_EXECUTED',
  'APPROVAL_RECEIVED',
  'PURCHASE_SETTLED',
  'APPROVAL_DECLINED',
  'PAYMENT_FAILED',
] as const;

export const sample = {
  nowSeconds: NOW_SECONDS,

  config: (): GatewayConfig => ({
    chainId: 421_614,
    vault: VAULT,
    principal: address(60),
    identityRegistry: address(61),
    token: { address: address(62), symbol: 'USDC', decimals: 6 },
    executor: address(70),
    spendWallet: address(71),
    explorerUrl: 'https://sepolia.arbiscan.io',
  }),

  intents: (): IntentSummary[] => INTENTS,

  approvals: (): PendingApproval[] => [pending(0, 540), pending(1, 45), pending(2, -30)],

  mandates: (): Mandate[] => [
    // Nothing runs on its own: both caps are zero, so every payment needs the approver. Forty payees,
    // and an end date as far away as the vault can store (2^64 - 1 seconds).
    mandate(10n, {
      perPaymentCap: 0n,
      dailyCap: 0n,
      payees: Array.from({ length: 40 }, (_, index) => address(index)),
      validUntil: Number(2n ** 64n - 1n),
    }),
    // Today's spending is past the daily cap: the rest was approved by a person.
    mandate(9n, { spentToday: 13_700_000n }),
    mandate(8n, {
      perPaymentCap: 500_000n,
      dailyCap: 1_000_000n,
      hardCeiling: 1_000_000n,
      payees: [address(71)],
      spentToday: 1_000_000n,
    }),
    mandate(7n, {
      payees: Array.from({ length: 14 }, (_, index) => address(index)),
      spentToday: 1n,
    }),
    mandate(6n, {
      perPaymentCap: 999_999_999_999_999_999n,
      dailyCap: 999_999_999_999_999_999n,
      hardCeiling: 999_999_999_999_999_999n,
      spentToday: 12_345_678_901_234n,
    }),
    mandate(5n, { revoked: true, active: false, spentToday: 7_700_000n }),
    mandate(4n, { validUntil: NOW_SECONDS - 86_400, active: false }),
  ],

  payees: (): Payees => ({
    vendors: NAMES.filter((name): name is string => name !== null).map((name, index) => ({
      name,
      address: address(index),
      note:
        index === 4
          ? 'A note that is longer than notes usually are, to see where the line breaks and whether anything is pushed out of place'
          : 'vendor',
    })),
    denylist: [{ address: address(22), reason: 'bank details changed, under review' }],
  }),

  /** Exactly one of everything, to check words such as "1 payee" and "1 entry". */
  one: {
    // The fifth request was paid with an approval and has the longest vendor name.
    intents: (): IntentSummary[] => INTENTS.slice(4, 5),
    approvals: (): PendingApproval[] => [pending(0, 540)],
    mandates: (): Mandate[] => [mandate(9n, { payees: [address(0)], spentToday: 1n })],
    payees: (): Payees => ({ vendors: [{ name: 'K', address: address(0) }], denylist: [] }),
    ledger: (): Ledger => ({
      check: { ok: true, count: 1, head: hex(4000, 32) },
      head: hex(4000, 32),
      entries: [
        {
          seq: 1,
          ts: new Date(NOW - 31_000).toISOString(),
          kind: 'INTENT_DECIDED',
          summary: `auto: agent 354 asks to pay 1.5 USDC to Koishi Supply (${address(0)})`,
          data: { intentId: hex(104, 32) },
          prev: `0x${'0'.repeat(64)}`,
          hash: hex(4000, 32),
        },
      ],
    }),
  },

  ledger: (): Ledger => ({
    // A ledger that was edited: the chain of hashes breaks at entry 3.
    check: { ok: false, count: 400, brokenAt: 3, why: 'previous hash does not match' },
    head: hex(4000, 32),
    entries: Array.from({ length: 400 }, (_, index) => ({
      seq: index + 1,
      ts: new Date(NOW - (400 - index) * 31_000).toISOString(),
      kind: LEDGER_KINDS[index % LEDGER_KINDS.length] ?? 'INTENT_DECIDED',
      summary:
        index % 9 === 0
          ? `auto: agent 354 asks to pay 12,345,678.901234 USDC to ${NAMES[4] ?? ''} (${address(index)})`
          : `paid 1.5 USDC to Koishi Supply (${address(index)}) under mandate 3`,
      data: { intentId: hex(index + 100, 32) },
      prev: hex(index + 3999, 32),
      hash: hex(index + 4000, 32),
    })),
  }),

  evidence: (intentId: Hex): EvidenceFile | null => {
    const found = INTENTS.find((item) => item.intentId === intentId);
    if (found === undefined) return null;

    const settled = found.purchase?.settlementTransactionHash ?? null;
    const result: EvidenceFile['result'] =
      found.status === 'paid' && found.transactionHash !== null
        ? {
            status: 'paid',
            transactionHash: found.transactionHash,
            blockNumber: '328373806',
            event: found.approvedBy === null ? 'MandatePayment' : 'ApprovedPayment',
            executedAt: found.updatedAt,
            ...(found.purchase === null
              ? {}
              : {
                  purchase:
                    settled === null
                      ? {
                          status: 'failed',
                          error: 'the merchant answered 503 to the signed payment',
                        }
                      : {
                          status: 'settled',
                          settlementTransactionHash: settled,
                          settledAt: found.updatedAt,
                          responseHash: hex(8, 32),
                        },
                }),
          }
        : found.status === 'failed'
          ? {
              status: 'failed',
              error: found.error ?? 'unknown',
              transactionHash: found.transactionHash,
              failedAt: found.updatedAt,
            }
          : found.status === 'declined'
            ? {
                status: 'declined',
                approver: address(77),
                signature: hex(3, 65),
                declinedAt: found.updatedAt,
              }
            : found.status === 'pending_approval'
              ? { status: 'pending_approval' }
              : found.status === 'executing'
                ? { status: 'executing' }
                : { status: 'refused' };

    return {
      format: 'agent-gateway-arbitrum/evidence/v1',
      evidenceHash: found.evidenceHash,
      record: {
        format: 'agent-gateway-arbitrum/evidence-record/v1',
        intentId,
        decidedAt: found.decidedAt,
        chain: {
          chainId: 421_614,
          vault: VAULT,
          token: address(62),
          identityRegistry: address(61),
          blockNumber: '328373781',
          blockTimestamp: NOW_SECONDS,
        },
        who: {
          agentId: found.agentId,
          agentWallet: address(50),
          principal: address(60),
          mandateId: found.mandateId,
          executor: address(70),
          approver: address(77),
        },
        what: {
          payee: found.payee,
          payeeName: found.payeeName,
          amount: found.amount,
          tokenSymbol: 'USDC',
          tokenDecimals: 6,
          purpose: found.purpose,
          invoiceId: found.invoiceId,
        },
        request: {
          intent: {
            agentId: found.agentId,
            payee: found.payee,
            amount: found.amount,
            purpose: found.purpose,
            invoiceId: found.invoiceId,
            context: found.payeeSource === null ? {} : { payeeSource: found.payeeSource },
            nonce: hex(6, 32),
            expiresAt: NOW_SECONDS + 300,
          },
          signature: hex(1, 65),
          signer: address(50),
        },
        purchase:
          found.purchase === null
            ? null
            : { protocol: 'mpp', resource: found.purchase.resource, spendWallet: address(71) },
        why: {
          decision: found.decision,
          reasons: found.reasons,
          checks: [
            'request_current',
            'agent_registered',
            'agent_signature',
            'mandate_active',
            'payee_in_vendor_registry',
            'within_hard_ceiling',
            'within_per_payment_cap',
            'within_daily_cap',
          ].map((key, index) => ({
            key,
            kind: index > 5 ? 'soft' : 'hard',
            result:
              found.decision === 'refused' && index === 4
                ? 'fail'
                : found.decision === 'needs_approval' && index === 6
                  ? 'fail'
                  : 'pass',
            label: key.replaceAll('_', ' '),
            detail:
              index === 4
                ? `not registered; the agent says the address came from: ${found.payeeSource ?? 'nowhere'}`
                : 'as recorded',
          })),
        },
      },
      approval:
        found.approvedBy === null
          ? null
          : {
              approver: found.approvedBy,
              nonce: '0',
              deadline: String(NOW_SECONDS + 600),
              signature: hex(2, 65),
              receivedAt: found.updatedAt,
            },
      result,
      updatedAt: found.updatedAt,
    };
  },

  verification: (intentId: Hex): Verification => {
    const broken = Number.parseInt(intentId.slice(-1), 16) % 4 === 0;
    return {
      verified: !broken,
      checks: [
        { verdict: 'pass', label: 'Evidence hash is the hash of the record', detail: hex(1, 32) },
        {
          verdict: 'pass',
          label: 'Request signature recovers the recorded signer',
          detail: address(50),
        },
        {
          verdict: broken ? 'fail' : 'pass',
          label:
            'Vault event carries this evidence hash and the same mandate, agent, payee and amount',
          detail: broken ? 'no event with this evidence hash' : 'MandatePayment',
        },
        { verdict: 'skipped', label: 'Ledger records this decision', detail: 'not checked' },
      ],
    };
  },

  terms: (termsHash: Hex): string | null =>
    Number.parseInt(termsHash.slice(-1), 16) % 3 === 0
      ? null
      : `AGENT PAYMENT MANDATE: VENDOR INVOICES\n\nPrincipal: Kirenami Trading (${address(60)})\nThe agent may pay these payees without asking:\n  - ${NAMES[4] ?? ''} (${address(4)})\nup to 2 USDC per payment and 8 USDC per UTC day.\n`,
};
