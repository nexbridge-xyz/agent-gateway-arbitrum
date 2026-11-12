import { Check, Minus, X } from 'lucide-react';
import type { Hex } from 'viem';

import { Field, HashValue, Mark, Money, Note, ScreenHead, Stamp } from '@/components/parts';
import type { EvidenceFile } from '@/lib/api';
import { useEvidence, useGatewayConfig, useIntents, useVerification } from '@/lib/data';
import { clock, day, short } from '@/lib/format';
import { href } from '@/lib/route';
import { cn } from '@/lib/utils';

const isIntentId = (value: string | null): value is Hex =>
  value !== null && /^0x[0-9a-f]{64}$/.test(value);

function Verdict({ verdict }: { verdict: 'pass' | 'fail' | 'skipped' }) {
  const Icon = verdict === 'pass' ? Check : verdict === 'fail' ? X : Minus;
  return (
    <span
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center border',
        verdict === 'pass' && 'border-ok/40 text-ok',
        verdict === 'fail' && 'border-stop/50 bg-stop-soft text-stop',
        verdict === 'skipped' && 'border-line-2 text-text-3',
      )}
    >
      <Icon aria-hidden className="size-3" />
      <span className="sr-only">
        {verdict === 'pass' ? 'Passed' : verdict === 'fail' ? 'Failed' : 'Not checked'}
      </span>
    </span>
  );
}

/** One request's evidence: who asked, what for, every check, the decision, and what is onchain. */
export function Evidence({ intentId }: { intentId: string | null }) {
  const id = isIntentId(intentId) ? intentId : null;
  const evidence = useEvidence(id);
  const verification = useVerification(id);
  const config = useGatewayConfig();
  const explorer = config.data?.explorerUrl ?? null;
  const tx = (hash: string | null | undefined) =>
    hash && explorer ? `${explorer}/tx/${hash}` : null;

  const head = (
    <ScreenHead
      title="Evidence"
      about="For every request the gateway writes down who asked, what for and how each check went. The hash of that record goes onchain with the payment, when the vault pays."
    />
  );

  if (id === null) {
    return (
      <div className="sheet content-start">
        {head}
        {intentId !== null ? (
          <Note tone="stop" title="That is not an intent id">
            An intent id is 0x followed by 64 hex characters.
          </Note>
        ) : null}
        <Picker />
      </div>
    );
  }
  if (evidence.isError) {
    return (
      <div className="sheet content-start">
        {head}
        <Note tone="stop" title="This record could not be read">
          {evidence.error.message}
        </Note>
        <Picker />
      </div>
    );
  }
  if (evidence.isPending) {
    return (
      <div className="sheet content-start">
        {head}
        <Note title="Reading the record…" />
      </div>
    );
  }
  const file = evidence.data;
  if (file === null) {
    return (
      <div className="sheet content-start">
        {head}
        <Note title="No record with this intent id" />
        <Picker />
      </div>
    );
  }

  const { record, result, approval } = file;
  const purchase = record.purchase ?? null;
  const paid = result.status === 'paid';

  return (
    <div className="sheet content-start">
      {head}
      <div className="sheet grid-cols-1 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="sheet content-start">
          <section className="cell space-y-4 py-5" aria-label="What was asked">
            <div className="flex flex-wrap items-center gap-3">
              <Stamp decision={record.why.decision} status={result.status} />
              <span className="label">
                decided {day(record.decidedAt)} {clock(record.decidedAt)} UTC
              </span>
            </div>
            <Money
              amount={record.what.amount}
              decimals={record.what.tokenDecimals}
              symbol={record.what.tokenSymbol}
              size="large"
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Payee">
                <div className="text-sm break-words">
                  {record.what.payeeName ?? 'Not in the vendor registry'}
                </div>
                <HashValue value={record.what.payee} label="payee address" />
              </Field>
              <Field label="For">
                <div className="text-sm break-words">{record.what.purpose}</div>
                {record.what.invoiceId ? (
                  <div className="num text-text-3 text-xs">Invoice {record.what.invoiceId}</div>
                ) : null}
              </Field>
            </div>
            {purchase ? (
              <Field label="Bought per call">
                <div className="num text-xs break-all">{purchase.resource}</div>
                <div className="text-text-3 mt-0.5 text-xs">
                  The vault paid the gateway&apos;s spend wallet{' '}
                  {purchase.spendWallet ? short(purchase.spendWallet) : ''}, which paid the
                  merchant.
                </div>
              </Field>
            ) : null}
          </section>

          <section
            className="cell grid grid-cols-2 gap-4 py-5 md:grid-cols-3"
            aria-label="Who asked"
          >
            <Field label="Agent (ERC-8004)">
              <span className="num text-sm break-all">{record.who.agentId}</span>
            </Field>
            <Field label="Signed by">
              {record.request.signer ? (
                <HashValue value={record.request.signer} lead={6} tail={4} label="signer address" />
              ) : (
                <span className="text-stop text-xs">unreadable signature</span>
              )}
            </Field>
            <Field label="Mandate">
              <span className="num text-sm">{record.who.mandateId ?? 'none'}</span>
            </Field>
            <Field label="Principal">
              <HashValue value={record.who.principal} lead={6} tail={4} label="principal address" />
            </Field>
            <Field label="Executor">
              {record.who.executor ? (
                <HashValue value={record.who.executor} lead={6} tail={4} label="executor address" />
              ) : (
                <span className="text-text-3 text-xs">none</span>
              )}
            </Field>
            <Field label="Approver">
              {record.who.approver ? (
                <HashValue value={record.who.approver} lead={6} tail={4} label="approver address" />
              ) : (
                <span className="text-text-3 text-xs">none</span>
              )}
            </Field>
          </section>

          <section className="cell py-5" aria-label="Why">
            <h2 className="label mb-3">Why: the checks the gateway ran</h2>
            <ul className="m-0 list-none space-y-1.5 p-0 text-sm">
              {record.why.reasons.map((reason) => (
                <li key={reason} className="border-line-3 border-l-2 pl-2.5 break-words">
                  {reason}
                </li>
              ))}
            </ul>
            <ul className="m-0 mt-4 list-none p-0">
              {record.why.checks.map((check) => (
                <li
                  key={check.key}
                  className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 border-t py-2 first:border-t-0"
                >
                  <Verdict verdict={check.result} />
                  <div className="min-w-0">
                    <div className="text-sm">
                      {check.label}
                      <span className="label ml-2">
                        {check.kind === 'hard' ? 'refuses' : 'asks the approver'}
                      </span>
                    </div>
                    <div className="text-text-3 text-xs break-words">{check.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="sheet content-start">
          <section className="cell space-y-4 py-5" aria-label="The record's hash and the chain">
            <Field label="Evidence hash">
              <div className="num text-ice text-[0.8125rem] leading-relaxed break-all">
                {file.evidenceHash}
              </div>
              <p className="text-text-3 mt-1 text-xs">
                keccak256 of the record in canonical JSON (RFC 8785).
              </p>
            </Field>
            <Field label="Onchain">
              {paid && result.transactionHash ? (
                <>
                  <HashValue
                    value={result.transactionHash}
                    href={tx(result.transactionHash)}
                    label="payment transaction"
                  />
                  <p className="text-text-3 mt-1 text-xs">
                    The vault&apos;s <span className="num">{result.event}</span> event in block{' '}
                    <span className="num">{result.blockNumber}</span> carries this evidence hash.
                  </p>
                </>
              ) : (
                <p className="text-text-2 text-sm">
                  Nothing was paid on this record, so nothing about it is onchain. It exists in the
                  gateway&apos;s files only.
                </p>
              )}
            </Field>
            {paid && result.purchase ? (
              <Field label="Settlement at the merchant">
                {result.purchase.status === 'settled' ? (
                  <>
                    <HashValue
                      value={result.purchase.settlementTransactionHash}
                      href={tx(result.purchase.settlementTransactionHash)}
                      label="settlement transaction"
                    />
                    <p className="text-text-3 mt-1 text-xs">
                      A plain USDC transfer from the spend wallet to the merchant. It does not carry
                      the evidence hash: this record names it, and the check below compares the two.
                    </p>
                  </>
                ) : (
                  <p className="text-stop text-sm break-words">
                    The purchase failed: {result.purchase.error}
                  </p>
                )}
              </Field>
            ) : null}
            {approval ? (
              <Field label="Approved by">
                <HashValue value={approval.approver} label="approver address" />
                <p className="text-text-3 mt-1 text-xs">
                  Approval number <span className="num">{approval.nonce}</span>, signed{' '}
                  {clock(approval.receivedAt)} UTC. The signature covers the payee, the amount and
                  this evidence hash.
                </p>
              </Field>
            ) : null}
            {result.status === 'declined' && result.approver ? (
              <Field label="Declined by">
                <HashValue value={result.approver} label="approver address" />
              </Field>
            ) : null}
            {result.status === 'failed' && result.error ? (
              <Field label="Payment failed">
                <p className="text-stop text-sm break-words">{result.error}</p>
              </Field>
            ) : null}
          </section>

          <section className="cell py-5" aria-label="The record checked">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="label">The record, checked against the chain and the ledger</h2>
              {verification.data ? (
                verification.data.verified ? (
                  <Mark tone="ok">Verified</Mark>
                ) : (
                  <Mark tone="stop">Not verified</Mark>
                )
              ) : null}
            </div>
            {verification.isError ? (
              <p className="text-stop text-sm" role="alert">
                The check could not be run: {verification.error.message}
              </p>
            ) : verification.isPending ? (
              <p className="text-text-3 text-sm">Checking…</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {(verification.data?.checks ?? []).map((check) => (
                  <li
                    key={check.label}
                    className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 border-t py-1.5 first:border-t-0"
                  >
                    <Verdict verdict={check.verdict} />
                    <div className="min-w-0 text-sm">
                      {check.label}
                      {check.detail ? (
                        <span className="num text-text-3 ml-2 text-xs break-all">
                          {short(check.detail, 24, 8)}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-text-3 mt-4 text-xs">
              Here the gateway checks its own file. To check it without trusting the gateway, save
              the record and run <code className="num">pnpm verify-evidence &lt;file&gt;</code>.
            </p>
          </section>

          <details className="cell">
            <summary className="label cursor-pointer py-1">The whole file</summary>
            <RawFile file={file} />
          </details>
        </div>
      </div>
    </div>
  );
}

function RawFile({ file }: { file: EvidenceFile }) {
  return (
    <pre className="num text-text-2 mt-3 max-h-[28rem] overflow-auto text-[0.6875rem] leading-relaxed break-all whitespace-pre-wrap">
      {JSON.stringify(file, null, 2)}
    </pre>
  );
}

/** The latest requests, to pick one from. */
function Picker() {
  const intents = useIntents();
  const rows = (intents.data ?? []).slice(0, 30);
  if (rows.length === 0) {
    return intents.isPending ? null : (
      <Note title="No records yet">
        Each request an agent sends leaves one. They are listed here.
      </Note>
    );
  }
  return (
    <section className="sheet" aria-label="Latest records">
      <h2 className="label bg-ink-2 px-5 py-2">Latest records</h2>
      {rows.map((row) => (
        <a
          key={row.intentId}
          href={href('evidence', row.intentId)}
          className="cell text-foreground hover:bg-surface grid grid-cols-1 items-center gap-x-4 gap-y-1 no-underline md:grid-cols-[5.5rem_9.5rem_9rem_minmax(0,1fr)_9rem]"
        >
          <span className="num text-text-2 text-xs">{clock(row.decidedAt)}</span>
          <span>
            <Stamp decision={row.decision} status={row.status} />
          </span>
          <Money amount={row.amount} decimals={row.tokenDecimals} symbol={row.tokenSymbol} />
          <span className="min-w-0 truncate text-sm">
            {row.payeeName ?? 'Not in the vendor registry'} · {row.purpose}
          </span>
          <span className="num text-text-3 text-xs md:text-right">{short(row.intentId, 8, 6)}</span>
        </a>
      ))}
    </section>
  );
}
