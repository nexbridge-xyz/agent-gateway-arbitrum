import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import type { Decision, Status } from '@/lib/api';
import { money, short, yen } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Small pieces every screen uses. */

type Tone = 'ok' | 'wait' | 'stop' | 'plain';

const TONE: Record<Tone, string> = {
  ok: 'text-ok border-ok/40 bg-ok-soft',
  wait: 'text-wait border-wait/40 bg-wait-soft',
  stop: 'text-stop border-stop/40 bg-stop-soft',
  plain: 'text-text-2 border-line-2 bg-transparent',
};

/**
 * What became of a request, as a stamp. The word carries the meaning; the colour only repeats it, so
 * the stamp reads the same for someone who cannot tell the colours apart.
 */
export function Stamp({ decision, status }: { decision: Decision; status: Status }) {
  const [word, tone]: [string, Tone] =
    status === 'paid'
      ? [decision === 'needs_approval' ? 'Paid, approved' : 'Paid', 'ok']
      : status === 'pending_approval'
        ? ['Needs approval', 'wait']
        : status === 'executing'
          ? ['Paying', 'wait']
          : status === 'declined'
            ? ['Declined', 'stop']
            : status === 'failed'
              ? ['Failed', 'stop']
              : ['Refused', 'stop'];
  return <Mark tone={tone}>{word}</Mark>;
}

export function Mark({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center border px-2 font-mono text-[0.6875rem] tracking-[0.06em] whitespace-nowrap uppercase',
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * An amount in the token, with the yen figure at the demo rate under or beside it. The yen sign is
 * the brand's signal colour: it is one of the few places that colour appears.
 */
export function Money({
  amount,
  decimals,
  symbol,
  size = 'row',
}: {
  amount: string | bigint;
  decimals: number;
  symbol: string;
  size?: 'row' | 'large';
}) {
  return (
    <span className={cn('inline-flex max-w-full min-w-0 flex-col', size === 'large' && 'gap-1')}>
      <span
        className={cn(
          // An amount is never cut short: a very long one breaks onto a second line.
          'num break-all',
          size === 'large' ? 'text-[2rem] leading-none font-medium tracking-tight' : 'text-sm',
        )}
      >
        {money(amount, decimals)}
        <span className={cn('text-text-3 ml-1.5', size === 'large' ? 'text-base' : 'text-xs')}>
          {symbol}
        </span>
      </span>
      <span className={cn('num text-text-3 break-all', size === 'large' ? 'text-sm' : 'text-xs')}>
        <span className="text-signal">¥</span>
        {yen(amount, decimals)}
      </span>
    </span>
  );
}

/** A long hex value, shortened, with a way to copy all of it and an optional link to the explorer. */
export function HashValue({
  value,
  href,
  lead = 10,
  tail = 8,
  label,
}: {
  value: string;
  href?: string | null;
  lead?: number;
  tail?: number;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1200);
    });
  };
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      {href ? (
        <a
          className="num inline-flex min-w-0 items-center gap-1 text-xs no-underline hover:underline"
          href={href}
          target="_blank"
          rel="noreferrer"
          title={value}
        >
          <span className="truncate">{short(value, lead, tail)}</span>
          <ArrowUpRight aria-hidden className="size-3 shrink-0" />
          <span className="sr-only">Open {label} in the block explorer</span>
        </a>
      ) : (
        <span className="num text-text-2 truncate text-xs" title={value}>
          {short(value, lead, tail)}
        </span>
      )}
      <button
        type="button"
        onClick={copy}
        className="text-text-3 hover:text-foreground inline-flex size-6 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent"
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      >
        {copied ? (
          <Check aria-hidden className="text-ok size-3" />
        ) : (
          <Copy aria-hidden className="size-3" />
        )}
      </button>
    </span>
  );
}

/**
 * What a payment is for, in the agent's words. A purpose can be a single space; it is then said to be
 * missing instead of leaving a blank line. With `clamp`, long text is cut after two lines and the whole
 * of it is in the tooltip and on the evidence screen.
 */
export function Purpose({ text, clamp = false }: { text: string; clamp?: boolean }) {
  if (text.trim() === '') return <div className="text-text-3 text-sm">(no purpose given)</div>;
  return (
    <div
      className={cn('min-w-0 text-sm break-words', clamp && 'line-clamp-2')}
      title={clamp ? text : undefined}
    >
      {text}
    </div>
  );
}

/** A label with its value under it. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="label mb-1">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** What a screen says when there is nothing to show, or when the data could not be read. */
export function Note({
  title,
  children,
  tone = 'plain',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'plain' | 'stop';
}) {
  return (
    <div className="cell py-10" role={tone === 'stop' ? 'alert' : undefined}>
      <p className={cn('text-base font-medium', tone === 'stop' && 'text-stop')}>{title}</p>
      {children ? <div className="text-text-2 mt-1.5 max-w-[60ch] text-sm">{children}</div> : null}
    </div>
  );
}

/** The head of a screen: what it is, one line about it, and at most one call to action. */
export function ScreenHead({
  title,
  about,
  action,
}: {
  title: string;
  about: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className={cn('sheet', action ? 'grid-cols-[1fr_auto]' : 'grid-cols-1')}>
      <div className="cell py-5">
        {/* The title can take the focus: it does when the screen changes, so the keyboard goes on from here. */}
        <h1 id="screen-title" tabIndex={-1} className="text-[1.75rem] focus:outline-none">
          {title}
        </h1>
        <p className="text-text-2 mt-1.5 max-w-[72ch] text-sm">{about}</p>
      </div>
      {action ? <div className="flex items-stretch">{action}</div> : null}
    </header>
  );
}
