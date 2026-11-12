import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { type Address, createPublicClient, formatUnits, getAddress, http, isAddress } from 'viem';

import deployment from '@agent-gateway/contracts/deployments/arbitrum-sepolia.json' with { type: 'json' };

import { explorerTx, repositoryRoot } from '../runtime';
import { type LedgerEntry, parseLedger } from '../store/ledger';
import { type VerifyReport, createVerifierChain, verifyEvidence } from '../verify';

const USAGE = `Check Agent Gateway evidence files.

  pnpm verify-evidence <file>... [--vault <address>] [--offline] [--rpc <url>] [--ledger <file>]

  --vault <address>  the vault the files must be about (default: MANDATE_VAULT_ADDRESS from the
                     environment or the repository's .env, or else the vault this repository records
                     as deployed). A file about any other contract does not verify.
  --offline          check each file against itself only; do not contact the chain
  --rpc <url>        RPC endpoint (default: ARBITRUM_SEPOLIA_RPC_URL, or the public Arbitrum Sepolia endpoint)
  --ledger <file>    the gateway's ledger (default: ledger.jsonl next to the evidence folder, if it exists)

Exit code 0 when every check of every file passes, 1 when one fails, 2 when a file cannot be read.`;

/**
 * An evidence file comes from somebody else. Before any of its text is printed, control and
 * formatting characters are shown as code points, so the file cannot rewrite the terminal.
 */
function show(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const clean = text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) =>
      `<U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`,
  );
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function print(report: VerifyReport, extra: string[]): void {
  const { file, checks } = report;
  if (file !== null) {
    const { record, result } = file;
    const money = `${formatUnits(BigInt(record.what.amount), record.what.tokenDecimals)} ${show(record.what.tokenSymbol, 16)}`;
    const payee =
      record.what.payeeName === null
        ? record.what.payee
        : `${show(record.what.payeeName, 80)} (${record.what.payee})`;
    console.log(`Evidence for intent ${record.intentId}`);
    console.log(`  vault ${record.chain.vault} on chain ${record.chain.chainId}`);
    console.log(`  ${record.why.decision} -> ${result.status}: ${money} to ${payee}`);
    console.log(
      `  agent ${record.who.agentId}, mandate ${record.who.mandateId ?? 'none'}, decided ${record.decidedAt}`,
    );
    console.log(`  purpose: ${show(record.what.purpose)}`);
    for (const reason of record.why.reasons) console.log(`  reason: ${show(reason, 400)}`);
    const purchase = record.purchase ?? null;
    if (purchase !== null) {
      console.log(
        `  per-call purchase of ${show(purchase.resource)}, paid through spend wallet ${purchase.spendWallet ?? 'none'}`,
      );
    }
    if (result.status === 'paid') {
      console.log(
        `  ${purchase === null ? 'payment' : 'top-up from the vault'}: ${explorerTx(result.transactionHash)}`,
      );
      if (result.purchase?.status === 'settled') {
        console.log(
          `  settlement at the merchant: ${explorerTx(result.purchase.settlementTransactionHash)}`,
        );
      }
      if (result.purchase?.status === 'failed') {
        console.log(`  the purchase failed at the merchant: ${show(result.purchase.error, 400)}`);
      }
    }
    if (result.status === 'declined')
      console.log(`  declined by approver ${result.approver} at ${show(result.declinedAt, 40)}`);
    console.log('');
  }

  const names = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP' } as const;
  for (const check of checks) {
    console.log(
      `  ${names[check.verdict]}  ${check.label}${check.detail === '' ? '' : `  (${show(check.detail)})`}`,
    );
  }

  const passed = checks.filter((check) => check.verdict === 'pass').length;
  const skipped = checks.filter((check) => check.verdict === 'skipped').length;
  console.log('');
  console.log(
    `  ${report.verified ? 'VERIFIED' : 'NOT VERIFIED'}: ${passed} of ${checks.length - skipped} checks passed` +
      (skipped === 0 ? '' : `, ${skipped} not checked`),
  );
  for (const line of extra) console.log(`  ${line}`);
  console.log('');
  console.log(
    '  What this cannot show: that the gateway recorded every request it received, or that the',
  );
  console.log(
    '  ledger was not rebuilt or cut short by whoever holds it. The vault events onchain are the',
  );
  console.log('  part of the record that nobody can rewrite.');
}

type Options = { offline: boolean; rpc?: string | undefined; ledger?: string | undefined };

/** One value from an env file, without loading the rest of the file (it holds keys) into this process. */
function envFileValue(path: string, name: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const found = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (found?.[1] === name) return (found[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/**
 * The vault the reader means: --vault, or the one this checkout is set up for, or the one this
 * repository records as deployed. Null if what was given is not an address.
 */
function expectedVault(flag: string | undefined): Address | null {
  const text =
    flag ??
    (process.env.MANDATE_VAULT_ADDRESS ||
      envFileValue(join(repositoryRoot, '.env'), 'MANDATE_VAULT_ADDRESS') ||
      deployment.contracts.MandateVault.address);
  return isAddress(text, { strict: false }) ? getAddress(text) : null;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      offline: { type: 'boolean', default: false },
      rpc: { type: 'string' },
      ledger: { type: 'string' },
      vault: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const vault = expectedVault(values.vault);
  if (vault === null) {
    console.log('NOT VERIFIED: the vault to check against is not an address. Pass --vault 0x…');
    return 2;
  }
  const expected = { chainId: deployment.chainId, vault };

  // pnpm runs scripts from the package folder; paths are meant relative to where the user stood.
  const base = process.env.INIT_CWD ?? process.cwd();
  let worst = 0;
  let verified = 0;
  for (const [index, name] of positionals.entries()) {
    if (index > 0) console.log('');
    const code = await checkFile(resolve(base, name), base, values, expected);
    if (code === 0) verified += 1;
    worst = Math.max(worst, code);
  }
  if (positionals.length > 1) {
    console.log('');
    console.log(`${verified} of ${positionals.length} files verified`);
  }
  return worst;
}

/** Checks one file and prints its report. Returns the exit code that file alone would give. */
async function checkFile(
  path: string,
  base: string,
  values: Options,
  expected: { chainId: number; vault: Address },
): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.log(
      `NOT VERIFIED: ${show(path)} cannot be read as JSON (${show(error instanceof Error ? error.message : error)})`,
    );
    return 2;
  }

  const extra: string[] = [];
  let ledger: LedgerEntry[] | undefined;
  const ledgerPath =
    values.ledger !== undefined
      ? resolve(base, values.ledger)
      : join(dirname(dirname(path)), 'ledger.jsonl');
  if (existsSync(ledgerPath)) {
    try {
      ledger = parseLedger(await readFile(ledgerPath, 'utf8'));
      extra.push(`ledger: ${ledgerPath}`);
    } catch {
      console.log(`NOT VERIFIED: the ledger at ${show(ledgerPath)} cannot be read`);
      return 2;
    }
  } else if (values.ledger !== undefined) {
    console.log(`NOT VERIFIED: no ledger at ${show(ledgerPath)}`);
    return 2;
  }

  let chain = null;
  if (!values.offline) {
    const envFile = join(repositoryRoot, '.env');
    if (
      values.rpc === undefined &&
      process.env.ARBITRUM_SEPOLIA_RPC_URL === undefined &&
      existsSync(envFile)
    ) {
      process.loadEnvFile(envFile);
    }
    const rpc =
      values.rpc ??
      (process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc');
    chain = createVerifierChain(createPublicClient({ transport: http(rpc) }));
  }

  const report = await verifyEvidence(input, { chain, ledger, expected });
  print(report, extra);
  return report.verified ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`NOT VERIFIED: ${show(error instanceof Error ? error.message : error, 400)}`);
    process.exitCode = 2;
  },
);
