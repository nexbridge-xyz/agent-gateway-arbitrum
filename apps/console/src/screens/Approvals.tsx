import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useConnection, useSignTypedData } from 'wagmi';

import { APPROVAL_DECLINE_TYPES, PAYMENT_APPROVAL_TYPES } from '@agent-gateway/gateway/protocol';

import { LimitRail } from '@/components/LimitRail';
import { Field, HashValue, Mark, Money, Note, Purpose, ScreenHead } from '@/components/parts';
import { WRONG_NETWORK, useRole } from '@/components/WalletCell';
import { ApiError, type Outcome, type PendingApproval, api } from '@/lib/api';
import {
  useApprovals,
  useDataMode,
  useGatewayConfig,
  useGatewayProblem,
  useMandates,
  useNow,
} from '@/lib/data';
import { clock, money, short, until } from '@/lib/format';
import { href } from '@/lib/route';
import { cn } from '@/lib/utils';
import { VAULT } from '@/lib/vault';
import { chain } from '@/lib/wallet';

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

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why the console will not hand this request to a wallet, or null if what the gateway wants signed is
 * the payment the page describes, for this console's vault.
 *
 * The description on the screen (payee, amount, record) and the typed message for the wallet are
 * separate parts of the gateway's answer. A gateway that somebody else controls could describe a
 * vendor's invoice and ask for a signature over a payment to itself. The page can at least make sure
 * that the two are the same payment, and that the message is for its own vault and network.
 */
export function signingRefusal(
  pending: PendingApproval,
  token: { symbol: string; decimals: number } | undefined,
): string | null {
  const { domain, message } = pending.approval;
  const decline = pending.decline;
  const forThisVault = (d: { verifyingContract: string; chainId: number }) =>
    sameText(d.verifyingContract, VAULT) && Number(d.chainId) === chain.id;
  if (
    !forThisVault(domain) ||
    !forThisVault(decline.domain) ||
    domain.name !== 'MandateVault' ||
    domain.version !== '1'
  ) {
    return "The gateway asks your wallet to sign for another vault or network than this console's. Signing is switched off.";
  }
  if (
    !sameText(message.payee, pending.payee) ||
    message.amount !== pending.amount ||
    message.mandateId !== pending.mandateId ||
    !sameText(message.evidenceHash, pending.evidenceHash) ||
    !sameText(decline.message.intentId, pending.intentId) ||
    !sameText(decline.message.evidenceHash, pending.evidenceHash)
  ) {
    return 'The gateway asks your wallet to sign another payment than the one shown here. Signing is switched off.';
  }
  if (
    token !== undefined &&
    (pending.tokenDecimals !== token.decimals || pending.tokenSymbol !== token.symbol)
  ) {
    return 'The gateway shows this amount in other units than the token has, so the figure on the left is not the amount your wallet would sign. Signing is switched off.';
  }
  return null;
}

/** Payments that wait for a person. The approver signs one exact payment; the vault checks that signature. */
export function Approvals() {
  const approvals = useApprovals();
  const queue = approvals.data ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const [decided, setDecided] = useState<Decided[]>([]);
  // After "Review" the payment that was picked takes the focus, and after a decision its result does.
  // Otherwise the focus would be left on a button that is no longer there.
  const [picked, setPicked] = useState(false);
  const decidedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (decided.length > 0) decidedHeading.current?.focus();
  }, [decided.length]);
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
          takeFocus={picked && current.intentId === chosen}
          onDecided={(result) => {
            setDecided((list) => [result, ...list]);
            setChosen(null);
            setPicked(false);
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
                <Purpose text={item.purpose} clamp />
              </div>
              <button
                type="button"
                className="quiet-action h-full"
                onClick={() => {
                  setChosen(item.intentId);
                  setPicked(true);
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
          <h2
            ref={decidedHeading}
            tabIndex={-1}
            className="label bg-ink-2 px-5 py-2 focus:outline-none"
          >
            Decided in this session
          </h2>
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
  takeFocus,
  onDecided,
}: {
  pending: PendingApproval;
  position: number;
  total: number;
  /** True when the approver picked this payment from the list below. */
  takeFocus: boolean;
  onDecided: (result: Decided) => void;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (takeFocus) section.current?.focus();
  }, [takeFocus]);
  const { address, isConnected } = useConnection();
  const config = useGatewayConfig();
  const sign = useSignTypedData();
  const queryClient = useQueryClient();
  const mode = useDataMode();
  const now = useNow();
  const mandates = useMandates();
  const mandate = (mandates.data ?? []).find((item) => item.id.toString() === pending.mandateId);
  const { wrongNetwork } = useRole();
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const { message } = pending.approval;
  const deadline = Number(message.deadline);
  const expired = deadline <= now;
  const isApprover = address?.toLowerCase() === pending.approver.toLowerCase();
  const gatewayProblem = useGatewayProblem();
  // The token as the chain describes it: the console has compared the gateway's description with it.
  // Made-up data is never signed, so there is nothing to compare it with.
  const refusal =
    mode === 'live'
      ? signingRefusal(pending, gatewayProblem === null ? config.data?.token : undefined)
      : null;
  const blocked =
    mode !== 'live'
      ? 'This is made-up data. Signing is switched off.'
      : gatewayProblem !== null
        ? gatewayProblem
        : !isConnected
          ? "Connect the approver's wallet to sign."
          : !isApprover
            ? `The connected wallet is not this mandate's approver, ${short(pending.approver)}.`
            : wrongNetwork
              ? WRONG_NETWORK
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
    if (refusal !== null) return;
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
    if (refusal !== null) return;
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
      ref={section}
      tabIndex={-1}
      className="sheet grid-cols-1 focus:outline-none xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16rem]"
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
            <Purpose text={pending.purpose} />
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
          disabled={blocked !== null || refusal !== null || busy !== null}
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
          disabled={blocked !== null || refusal !== null || busy !== null}
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
        {blocked !== null || problem !== null || refusal !== null ? (
          <p
            className={cn(
              'border-t px-5 py-3 text-xs',
              problem !== null || refusal !== null ? 'text-stop' : 'text-text-2',
            )}
            role={problem !== null || refusal !== null ? 'alert' : 'status'}
          >
            {refusal ?? problem ?? blocked}
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
