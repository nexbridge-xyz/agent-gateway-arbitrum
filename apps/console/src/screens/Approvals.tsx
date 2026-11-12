import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { useConnection, useSignTypedData } from 'wagmi';

import { APPROVAL_DECLINE_TYPES, PAYMENT_APPROVAL_TYPES } from '@agent-gateway/gateway/protocol';

import { LimitRail } from '@/components/LimitRail';
import { Field, HashValue, Mark, Money, Note, ScreenHead } from '@/components/parts';
import { ApiError, type Outcome, type PendingApproval, api } from '@/lib/api';
import { useApprovals, useDataMode, useGatewayConfig, useMandates, useNow } from '@/lib/data';
import { clock, money, short, until } from '@/lib/format';
import { href } from '@/lib/route';
import { cn } from '@/lib/utils';

type Decided = { pending: PendingApproval; outcome: Outcome; said: 'approved' | 'declined' };
type Busy = 'sign' | 'pay' | 'sign-decline' | 'record' | null;

/** Says what went wrong in words a person at the approver's desk can act on. */
function explain(error: unknown): string {
  if (error instanceof ApiError) return [error.message, ...error.reasons].join(' ');
  if (error instanceof Error) {
    if (/reject|denied|declin/i.test(error.message))
      return 'The wallet did not sign. Nothing was sent.';
    return error.message.split('\n')[0] ?? 'Something went wrong';
  }
  return 'Something went wrong';
}

/** Payments that wait for a person. The approver signs one exact payment; the vault checks that signature. */
export function Approvals() {
  const approvals = useApprovals();
  const queue = approvals.data ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const [decided, setDecided] = useState<Decided[]>([]);
  const current = queue.find((item) => item.intentId === chosen) ?? queue[0] ?? null;
  const others = queue.filter((item) => item !== current);

  return (
    <div className="sheet content-start">
      <ScreenHead
        title="Approvals"
        about="Payments outside a mandate wait here. You sign one exact payment: this payee, this amount, this record. The vault checks your signature before it pays, so the gateway cannot change what you approved."
      />

      {approvals.isError ? (
        <Note tone="stop" title="The approval queue could not be read">
          {approvals.error.message}
        </Note>
      ) : approvals.isPending ? (
        <Note title="Reading the queue…" />
      ) : current === null ? (
        <Note title="Nothing is waiting for approval">
          A payment lands here when it is above a cap or goes to a vendor that is not on the
          mandate&apos;s list.
        </Note>
      ) : (
        <Waiting
          key={current.intentId}
          pending={current}
          position={queue.indexOf(current) + 1}
          total={queue.length}
          onDecided={(result) => {
            setDecided((list) => [result, ...list]);
            setChosen(null);
          }}
        />
      )}

      {others.length > 0 ? (
        <section className="sheet" aria-label="Also waiting">
          <h2 className="label bg-ink-2 px-5 py-2">Also waiting</h2>
          {others.map((item) => (
            <div
              key={item.intentId}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4"
            >
              <div className="cell grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)]">
                <Money
                  amount={item.amount}
                  decimals={item.tokenDecimals}
                  symbol={item.tokenSymbol}
                />
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {item.payeeName ?? 'Not in the vendor registry'}
                  </div>
                  <div className="num text-text-3 text-xs">{short(item.payee)}</div>
                </div>
                <div className="line-clamp-2 min-w-0 text-sm break-words">{item.purpose}</div>
              </div>
              <button
                type="button"
                className="quiet-action h-full"
                onClick={() => {
                  setChosen(item.intentId);
                }}
              >
                Review <ArrowRight aria-hidden className="size-4" />
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {decided.length > 0 ? (
        <section className="sheet" aria-label="Decided in this session">
          <h2 className="label bg-ink-2 px-5 py-2">Decided in this session</h2>
          {decided.map(({ pending, outcome, said }) => (
            <div
              key={pending.intentId}
              className="cell arrive grid grid-cols-1 items-center gap-x-4 gap-y-1 md:grid-cols-[9.5rem_10rem_minmax(0,1fr)_auto]"
            >
              <div>
                {said === 'declined' ? (
                  <Mark tone="stop">Declined</Mark>
                ) : outcome.status === 'paid' ? (
                  <Mark tone="ok">Paid, approved</Mark>
                ) : (
                  <Mark tone="stop">Not paid</Mark>
                )}
              </div>
              <Money
                amount={pending.amount}
                decimals={pending.tokenDecimals}
                symbol={pending.tokenSymbol}
              />
              <div className="min-w-0 text-sm">
                <span className="truncate">{pending.payeeName ?? short(pending.payee)}</span>
                {outcome.error ? (
                  <span className="text-stop ml-2 text-xs">{outcome.error}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-4">
                {outcome.transactionHash ? (
                  <HashValue
                    value={outcome.transactionHash}
                    href={outcome.explorerUrl}
                    lead={6}
                    tail={4}
                    label="transaction"
                  />
                ) : null}
                <a
                  className="text-xs no-underline hover:underline"
                  href={href('evidence', pending.intentId)}
                >
                  Evidence
                </a>
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Waiting({
  pending,
  position,
  total,
  onDecided,
}: {
  pending: PendingApproval;
  position: number;
  total: number;
  onDecided: (result: Decided) => void;
}) {
  const { address, isConnected } = useConnection();
  const config = useGatewayConfig();
  const sign = useSignTypedData();
  const queryClient = useQueryClient();
  const mode = useDataMode();
  const now = useNow();
  const mandates = useMandates();
  const mandate = (mandates.data ?? []).find((item) => item.id.toString() === pending.mandateId);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const { message } = pending.approval;
  const deadline = Number(message.deadline);
  const expired = deadline <= now;
  const isApprover = address?.toLowerCase() === pending.approver.toLowerCase();
  const blocked =
    mode !== 'live'
      ? 'This is made-up data. Signing is switched off.'
      : !isConnected
        ? "Connect the approver's wallet to sign."
        : !isApprover
          ? `The connected wallet is not this mandate's approver, ${short(pending.approver)}.`
          : expired
            ? 'This signing window has passed. A new one opens in a moment.'
            : null;

  const refresh = async () => {
    await Promise.all(
      ['approvals', 'intents', 'ledger', 'mandates'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };

  const approve = async () => {
    setProblem(null);
    try {
      setBusy('sign');
      const signature = await sign.mutateAsync({
        domain: pending.approval.domain,
        types: PAYMENT_APPROVAL_TYPES,
        primaryType: 'PaymentApproval',
        message: {
          mandateId: BigInt(message.mandateId),
          payee: message.payee,
          amount: BigInt(message.amount),
          evidenceHash: message.evidenceHash,
          nonce: BigInt(message.nonce),
          deadline: BigInt(message.deadline),
        },
      });
      setBusy('pay');
      const outcome = await api.approve(pending.intentId, signature, message.deadline);
      await refresh();
      onDecided({ pending, outcome, said: 'approved' });
    } catch (error) {
      setProblem(explain(error));
      setBusy(null);
    }
  };

  const decline = async () => {
    setProblem(null);
    try {
      setBusy('sign-decline');
      const signature = await sign.mutateAsync({
        domain: pending.decline.domain,
        types: APPROVAL_DECLINE_TYPES,
        primaryType: 'ApprovalDecline',
        message: pending.decline.message,
      });
      setBusy('record');
      const outcome = await api.decline(pending.intentId, signature);
      await refresh();
      onDecided({ pending, outcome, said: 'declined' });
    } catch (error) {
      setProblem(explain(error));
      setBusy(null);
    }
  };

  const symbol = config.data?.token.symbol ?? pending.tokenSymbol;
  return (
    <section
      className="sheet grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16rem]"
      aria-label="Waiting for your approval"
    >
      <div className="cell space-y-5 py-5">
        <div className="flex items-center gap-3">
          <Mark tone="wait">Needs approval</Mark>
          <span className="label">
            {position} of {total} · asked {clock(pending.decidedAt)} UTC
          </span>
        </div>
        <Money
          amount={pending.amount}
          decimals={pending.tokenDecimals}
          symbol={pending.tokenSymbol}
          size="large"
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Pay to">
            <div className="text-sm break-words">
              {pending.payeeName ?? 'Not in the vendor registry'}
            </div>
            <HashValue value={pending.payee} label="payee address" />
          </Field>
          <Field label="For">
            <div className="text-sm break-words">{pending.purpose}</div>
            {pending.invoiceId ? (
              <div className="num text-text-3 text-xs">Invoice {pending.invoiceId}</div>
            ) : null}
          </Field>
        </div>
        <Field label="Why it needs you">
          <ul className="m-0 list-none space-y-1 p-0 text-sm">
            {pending.reasons.map((reason) => (
              <li key={reason} className="border-wait/60 border-l-2 pl-2.5 break-words">
                {reason}
              </li>
            ))}
          </ul>
        </Field>
        {mandate ? (
          <Field label={`Where it lands on mandate ${mandate.id}`}>
            <div className="mt-2">
              <LimitRail
                perPaymentCap={mandate.perPaymentCap}
                dailyCap={mandate.dailyCap}
                hardCeiling={mandate.hardCeiling}
                spentToday={mandate.spentToday}
                decimals={pending.tokenDecimals}
                symbol={pending.tokenSymbol}
                proposed={BigInt(pending.amount)}
              />
            </div>
          </Field>
        ) : null}
        <a
          className="inline-flex items-center gap-1 text-xs no-underline hover:underline"
          href={href('evidence', pending.intentId)}
        >
          Read the full record <ArrowRight aria-hidden className="size-3" />
        </a>
      </div>

      <div className="cell py-5">
        <h2 className="label mb-3">What your wallet will ask you to sign</h2>
        <dl className="num m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
          <dt className="text-text-3">mandateId</dt>
          <dd className="m-0">{message.mandateId}</dd>
          <dt className="text-text-3">payee</dt>
          <dd className="m-0 break-all">{message.payee}</dd>
          <dt className="text-text-3">amount</dt>
          <dd className="m-0 break-all">
            {message.amount}{' '}
            <span className="text-text-3">
              = {money(message.amount, pending.tokenDecimals)} {symbol}
            </span>
          </dd>
          <dt className="text-text-3">evidenceHash</dt>
          <dd className="m-0 break-all">{message.evidenceHash}</dd>
          <dt className="text-text-3">nonce</dt>
          <dd className="m-0">
            {message.nonce} <span className="text-text-3">= approval number of this mandate</span>
          </dd>
          <dt className="text-text-3">deadline</dt>
          <dd className={cn('m-0', expired && 'text-stop')}>
            {message.deadline}{' '}
            <span className={expired ? 'text-stop' : 'text-text-3'}>= {until(deadline, now)}</span>
          </dd>
        </dl>
        <p className="text-text-3 mt-4 max-w-[52ch] text-xs">
          A typed message (EIP-712) for this vault on Arbitrum Sepolia. It is good for this one
          payment and stops working at the deadline. Check that the payee and the amount are the
          ones on the left.
        </p>
      </div>

      <div className="flex flex-col">
        <button
          type="button"
          className="action-cell h-24 w-full"
          disabled={blocked !== null || busy !== null}
          onClick={() => {
            void approve();
          }}
        >
          <span>
            {busy === 'sign'
              ? 'Waiting for your signature…'
              : busy === 'pay'
                ? 'Paying through the vault…'
                : 'Sign approval'}
          </span>
          <ArrowRight aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          data-tone="stop"
          className="quiet-action w-full border-t"
          disabled={blocked !== null || busy !== null}
          onClick={() => {
            void decline();
          }}
        >
          {busy === 'sign-decline'
            ? 'Waiting for your signature…'
            : busy === 'record'
              ? 'Recording…'
              : 'Decline'}
        </button>
        {blocked !== null || problem !== null ? (
          <p
            className={cn(
              'border-t px-5 py-3 text-xs',
              problem !== null ? 'text-stop' : 'text-text-2',
            )}
            role={problem !== null ? 'alert' : 'status'}
          >
            {problem ?? blocked}
          </p>
        ) : null}
        <p className="text-text-3 border-t px-5 py-3 text-xs">
          Signing costs you no gas. The gateway sends the payment, and the vault checks your
          signature before it pays.
        </p>
      </div>
    </section>
  );
}
