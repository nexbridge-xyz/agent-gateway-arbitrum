import { type Address, type Hex, keccak256, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_FORMAT,
  EVIDENCE_RECORD_FORMAT,
  type EvidenceFile,
  type EvidenceRecord,
  evidenceHash,
} from '../../src/protocol/evidence';
import { intentId, signIntent } from '../../src/protocol/intent';
import { type VerifierChain, verifyEvidence } from '../../src/verify';
import { NOW, VAULT, makeIntent, newAccount, newAddress } from '../helpers';

/**
 * Review finding: `verify-evidence` takes the vault, the token and the identity registry from the file
 * it is checking, and never asks whether that vault is the one the reader cares about.
 *
 * Anyone can deploy a contract of their own on Arbitrum Sepolia, name it in a file, and get
 * "VERIFIED" for a payment the real vault never made. The forger needs no key of the company: not the
 * agent's, not the executor's, not the approver's.
 */

const CHAIN_ID = 421_614;

/** What the forger owns: one key, and three contracts they deployed themselves. */
function forgery() {
  const forger = newAccount();
  return {
    forger,
    vault: newAddress(),
    token: newAddress(),
    registry: newAddress(),
    victim: newAddress(),
    transactionHash: keccak256(stringToHex('a transaction to the forger’s own contract')),
  };
}

async function forgedFile(f: ReturnType<typeof forgery>): Promise<EvidenceFile> {
  const domain = { chainId: CHAIN_ID, vault: f.vault };
  // The same agent id as the company's agent. In the forger's registry it belongs to the forger.
  const intent = makeIntent({
    agentId: '354',
    payee: f.victim,
    amount: '6000000',
    purpose: 'Invoice 2026-118: research report',
  });
  const signed = await signIntent(f.forger, domain, intent);
  const record: EvidenceRecord = {
    format: EVIDENCE_RECORD_FORMAT,
    intentId: intentId(domain, intent),
    decidedAt: new Date(NOW * 1000).toISOString(),
    chain: {
      chainId: CHAIN_ID,
      vault: f.vault,
      token: f.token,
      identityRegistry: f.registry,
      blockNumber: '1000',
      blockTimestamp: NOW,
    },
    who: {
      agentId: '354',
      agentWallet: f.forger.address,
      principal: f.forger.address,
      mandateId: '1',
      executor: f.forger.address,
      approver: newAddress(),
    },
    what: {
      payee: f.victim,
      payeeName: 'Nagikumo Research',
      amount: '6000000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      purpose: intent.purpose,
      invoiceId: intent.invoiceId,
    },
    request: { intent, signature: signed.signature as Hex, signer: f.forger.address },
    purchase: null,
    why: {
      decision: 'auto',
      reasons: ['All 14 checks passed'],
      checks: [
        {
          key: 'agent_signature',
          kind: 'hard',
          result: 'pass',
          label: "Request is signed by the agent's registered wallet",
          detail: 'signed by the registered wallet',
        },
      ],
    },
  };
  return {
    format: EVIDENCE_FORMAT,
    evidenceHash: evidenceHash(record),
    record,
    approval: null,
    result: {
      status: 'paid',
      transactionHash: f.transactionHash,
      blockNumber: '1001',
      event: 'MandatePayment',
      executedAt: new Date((NOW + 2) * 1000).toISOString(),
    },
    updatedAt: new Date((NOW + 2) * 1000).toISOString(),
  };
}

/** Arbitrum Sepolia as it answers about the forger's contracts. Nothing here needs a key. */
function chainWithTheForgersContracts(
  f: ReturnType<typeof forgery>,
  file: EvidenceFile,
): VerifierChain & Record<string, unknown> {
  const only = <T>(address: Address, expected: Address, value: T): T => {
    if (address !== expected) throw new Error(`unexpected contract ${address}`);
    return value;
  };
  return {
    chainId: () => Promise.resolve(CHAIN_ID),
    vaultSettings: (vault) =>
      Promise.resolve(
        only(vault, f.vault, {
          principal: f.forger.address,
          token: f.token,
          identityRegistry: f.registry,
        }),
      ),
    agentWallet: (registry) => Promise.resolve(only(registry, f.registry, f.forger.address)),
    evidenceUsed: (vault) => Promise.resolve(only(vault, f.vault, true)),
    payment: (vault, transactionHash) =>
      Promise.resolve(
        only(vault, f.vault, {
          found: transactionHash === f.transactionHash,
          succeeded: true,
          to: f.vault,
          from: f.forger.address,
          blockNumber: 1001n,
          events: [
            {
              name: 'MandatePayment' as const,
              mandateId: 1n,
              agentId: 354n,
              payee: f.victim,
              amount: 6_000_000n,
              evidenceHash: file.evidenceHash,
              approver: null,
              nonce: null,
            },
          ],
        }),
      ),
    tokenTransfers: () => Promise.resolve({ found: false, succeeded: false, transfers: [] }),
    // What a fixed verifier may also ask. The forger's contracts answer these as well.
    blockTimestamp: (blockNumber: bigint) => Promise.resolve(blockNumber === 1000n ? NOW : NOW + 2),
    token: () => Promise.resolve({ symbol: 'USDC', decimals: 6 }),
  };
}

describe('review: evidence about somebody else’s vault', () => {
  it('is what it looks like on main: every check passes for a forger’s own contracts', async () => {
    const f = forgery();
    const file = await forgedFile(f);
    const report = await verifyEvidence(file, { chain: chainWithTheForgersContracts(f, file) });
    // No check can fail: every address the verifier asks about came out of the file.
    expect(report.checks.filter((check) => check.verdict === 'fail')).toEqual([]);
  });

  it('must not verify when the reader names the vault they mean', async () => {
    const f = forgery();
    const file = await forgedFile(f);
    // The reader means the company's vault. The file is about another contract.
    const options = {
      chain: chainWithTheForgersContracts(f, file),
      expected: { chainId: CHAIN_ID, vault: VAULT },
    };
    const report = await verifyEvidence(file, options);

    expect(report.verified).toBe(false);
    expect(
      report.checks.filter((check) => check.verdict === 'fail').map((check) => check.label),
    ).toContain('Record is about the vault this check was asked for');
  });

  it('still verifies an honest file for the vault the reader names', async () => {
    const f = forgery();
    const file = await forgedFile(f);
    // The same file, read by somebody who does mean that contract.
    const options = {
      chain: chainWithTheForgersContracts(f, file),
      expected: { chainId: CHAIN_ID, vault: f.vault },
    };
    const report = await verifyEvidence(file, options);
    expect(report.checks.filter((check) => check.verdict === 'fail')).toEqual([]);
    expect(report.checks.map((check) => check.label)).toContain(
      'Record is about the vault this check was asked for',
    );
  });
});
