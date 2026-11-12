import { type Address, type Hex, isAddress } from 'viem';
import { z } from 'zod';

import { EVIDENCE_FORMAT, EVIDENCE_RECORD_FORMAT, type EvidenceFile } from './evidence';
import { paymentIntentSchema } from './intent';

/**
 * The shape of an evidence file, for reading one that came from somebody else. A file that does not
 * match is not evidence of anything, and the verifier says so instead of guessing.
 */

const hash = z.custom<Hex>(
  (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value),
  'must be a 32-byte hash',
);
const signature = z.custom<Hex>(
  (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value),
  'must be a 65-byte signature',
);
const address = z.custom<Address>(
  (value) => typeof value === 'string' && isAddress(value),
  'must be a checksummed address',
);
const uintString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
const text = z.string().max(2_000);

const checkSchema = z.strictObject({
  key: z.string().max(64),
  kind: z.enum(['hard', 'soft']),
  result: z.enum(['pass', 'fail', 'skipped']),
  label: text,
  detail: text,
});

const recordSchema = z.strictObject({
  format: z.literal(EVIDENCE_RECORD_FORMAT),
  intentId: hash,
  decidedAt: isoTime,
  chain: z.strictObject({
    chainId: z.number().int().positive(),
    vault: address,
    token: address,
    identityRegistry: address,
    blockNumber: uintString,
    blockTimestamp: z.number().int().nonnegative(),
  }),
  who: z.strictObject({
    agentId: uintString,
    agentWallet: address.nullable(),
    principal: address,
    mandateId: uintString.nullable(),
    executor: address.nullable(),
    approver: address.nullable(),
  }),
  what: z.strictObject({
    payee: address,
    payeeName: z.string().max(80).nullable(),
    amount: uintString,
    tokenSymbol: z.string().max(16),
    tokenDecimals: z.number().int().min(0).max(36),
    purpose: text,
    invoiceId: text,
  }),
  request: z.strictObject({
    intent: paymentIntentSchema,
    signature,
    signer: address.nullable(),
  }),
  purchase: z
    .strictObject({
      protocol: z.literal('mpp'),
      resource: z.string().max(2_000),
      spendWallet: address.nullable(),
    })
    .nullable()
    .optional(),
  why: z.strictObject({
    decision: z.enum(['auto', 'needs_approval', 'refused']),
    reasons: z.array(text).max(32),
    checks: z.array(checkSchema).max(64),
  }),
});

const purchaseOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('settled'),
    settlementTransactionHash: hash,
    settledAt: isoTime,
    responseHash: hash,
  }),
  z.strictObject({ status: z.literal('failed'), error: text }),
]);

const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('refused') }),
  z.strictObject({ status: z.literal('pending_approval') }),
  z.strictObject({
    status: z.literal('declined'),
    approver: address,
    signature,
    declinedAt: isoTime,
  }),
  z.strictObject({
    status: z.literal('executing'),
    transactionHash: hash.optional(),
    unconfirmed: text.optional(),
  }),
  z.strictObject({
    status: z.literal('paid'),
    transactionHash: hash,
    blockNumber: uintString,
    event: z.enum(['MandatePayment', 'ApprovedPayment']),
    executedAt: isoTime,
    purchase: purchaseOutcomeSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    error: text,
    transactionHash: hash.nullable(),
    failedAt: isoTime,
  }),
]);

export const evidenceFileSchema = z.strictObject({
  format: z.literal(EVIDENCE_FORMAT),
  evidenceHash: hash,
  record: recordSchema,
  approval: z
    .strictObject({
      approver: address,
      nonce: uintString,
      deadline: uintString,
      signature,
      receivedAt: isoTime,
    })
    .nullable(),
  result: resultSchema,
  updatedAt: isoTime,
});

// The schema and the EvidenceFile type must describe the same thing. These lines fail to compile if
// one of them changes without the other.
const schemaMatchesType: z.ZodType<EvidenceFile> = evidenceFileSchema;
void schemaMatchesType;
