import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_RECORD_FORMAT,
  type EvidenceCheck,
  type EvidenceRecord,
  decisionFromChecks,
  evidenceHash,
} from '../src/protocol/evidence';
import { intentId } from '../src/protocol/intent';
import { type Json, canonicalize } from '../src/protocol/json';
import { DOMAIN, VAULT, makeIntent, newAddress } from './helpers';

function record(): EvidenceRecord {
  const intent = makeIntent({ nonce: `0x${'11'.repeat(32)}` });
  return {
    format: EVIDENCE_RECORD_FORMAT,
    intentId: intentId(DOMAIN, intent),
    decidedAt: '2026-11-13T03:00:00.000Z',
    chain: {
      chainId: 421_614,
      vault: VAULT,
      token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      blockNumber: '328251484',
      blockTimestamp: 1_794_538_800,
    },
    who: {
      agentId: '354',
      agentWallet: '0x277F7fcBEf2886A6b5F114DeeCaD52aaAE794B2a',
      principal: '0xd42f974802a327789F217Db9f61DeA26EA5418A5',
      mandateId: '1',
      executor: '0xB0aA521c777F8363DaA0446DD05807347d2f08B9',
      approver: '0x062Ac773F7470034411A7f739a5664F6B3cfcE69',
    },
    what: {
      payee: intent.payee,
      payeeName: 'Koishi Supply',
      amount: intent.amount,
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      purpose: intent.purpose,
      invoiceId: intent.invoiceId,
    },
    request: {
      intent,
      signature: `0x${'ab'.repeat(65)}`,
      signer: '0x277F7fcBEf2886A6b5F114DeeCaD52aaAE794B2a',
    },
    why: {
      decision: 'auto',
      reasons: ['All 1 checks passed'],
      checks: [
        {
          key: 'vault_open',
          kind: 'hard',
          result: 'pass',
          label: 'Vault is not paused',
          detail: 'not paused',
        },
      ],
    },
  };
}

/** Every path to a leaf value in the record, so a test can change each one in turn. */
function leafPaths(value: Json, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => leafPaths(item, [...path, index]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...path, key]));
  }
  return [path];
}

function changeLeaf(root: EvidenceRecord, path: (string | number)[]): EvidenceRecord {
  const copy = structuredClone(root) as unknown as Record<string | number, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path.at(-1) as string | number;
  const current = node[last];
  node[last] =
    typeof current === 'number'
      ? current + 1
      : typeof current === 'boolean'
        ? !current
        : typeof current === 'string'
          ? `${current}x`
          : 'x';
  return copy as unknown as EvidenceRecord;
}

describe('evidence hash', () => {
  it('is a 32-byte hash of the canonical record', () => {
    expect(evidenceHash(record())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('does not depend on the order the fields were written in', () => {
    const original = record();
    const reordered = JSON.parse(
      JSON.stringify(original, (_key, value: unknown) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    ) as EvidenceRecord;

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(original));
    expect(evidenceHash(reordered)).toBe(evidenceHash(original));
  });

  it('survives being written to a file and read back', () => {
    const original = record();
    const fromDisk = JSON.parse(JSON.stringify(original, null, 2)) as EvidenceRecord;
    expect(evidenceHash(fromDisk)).toBe(evidenceHash(original));
  });

  it('changes when any single value in the record changes', () => {
    const original = record();
    const hash = evidenceHash(original);
    const paths = leafPaths(original);
    expect(paths.length).toBeGreaterThan(30);

    for (const path of paths) {
      expect(evidenceHash(changeLeaf(original, path)), `changing ${path.join('.')}`).not.toBe(hash);
    }
  });

  it('changes when a check is added, removed or reordered', () => {
    const original = record();
    const hash = evidenceHash(original);
    const extra: EvidenceCheck = {
      key: 'extra',
      kind: 'soft',
      result: 'pass',
      label: 'x',
      detail: 'y',
    };

    const added = structuredClone(original);
    added.why.checks.push(extra);
    expect(evidenceHash(added)).not.toBe(hash);

    const reversed = structuredClone(added);
    reversed.why.checks.reverse();
    expect(evidenceHash(reversed)).not.toBe(evidenceHash(added));

    const removed = structuredClone(original);
    removed.why.checks = [];
    expect(evidenceHash(removed)).not.toBe(hash);
  });

  it('contains only plain JSON values', () => {
    expect(() => canonicalize(record())).not.toThrow();
    expect(JSON.parse(canonicalize(record()))).toEqual(record());
  });

  it('differs for the same request sent to another payee', () => {
    const a = record();
    const b = structuredClone(a);
    b.what.payee = newAddress();
    expect(evidenceHash(a)).not.toBe(evidenceHash(b));
  });
});

describe('decisionFromChecks', () => {
  const check = (kind: EvidenceCheck['kind'], result: EvidenceCheck['result']): EvidenceCheck => ({
    key: `${kind}-${result}`,
    kind,
    result,
    label: '',
    detail: '',
  });

  it('follows hard before soft before auto', () => {
    expect(decisionFromChecks([])).toBe('auto');
    expect(decisionFromChecks([check('hard', 'pass'), check('soft', 'pass')])).toBe('auto');
    expect(decisionFromChecks([check('hard', 'pass'), check('soft', 'fail')])).toBe(
      'needs_approval',
    );
    expect(decisionFromChecks([check('hard', 'fail'), check('soft', 'pass')])).toBe('refused');
    expect(decisionFromChecks([check('hard', 'fail'), check('soft', 'fail')])).toBe('refused');
  });

  it('never treats a check that was skipped as passed', () => {
    expect(decisionFromChecks([check('hard', 'skipped')])).toBe('refused');
    expect(decisionFromChecks([check('soft', 'skipped')])).toBe('needs_approval');
  });
});
