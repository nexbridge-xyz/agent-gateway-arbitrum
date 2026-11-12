import { ArrowRight } from 'lucide-react';
import { useState } from 'react';

import { HashValue, Money, Note, ScreenHead, Stamp } from '@/components/parts';
import type { IntentSummary } from '@/lib/api';
import { useDataMode, useIntents } from '@/lib/data';
import { clock, day, short } from '@/lib/format';
import { href } from '@/lib/route';
import { cn } from '@/lib/utils';

const SHOWN = 200;
const NONE: ReadonlySet<string> = new Set();
const COLUMNS =
  'grid grid-cols-[4.75rem_minmax(0,1fr)] md:grid-cols-[5.25rem_9.5rem_9rem_minmax(0,1fr)_minmax(0,1.3fr)_8.5rem]';

/** Every request an agent sent and what the gateway decided, newest first. */
export function Feed() {
  const intents = useIntents();
  const mode = useDataMode();
  const all = intents.data ?? [];
  const rows = all.slice(0, SHOWN);

  // Rows that were not there at the last look arrive with a short motion. The first load does not move.
  const [lastSeen, setLastSeen] = useState<IntentSummary[] | undefined>(undefined);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NONE);
  if (intents.data !== lastSeen) {
    setLastSeen(intents.data);
    if (lastSeen !== undefined && intents.data !== undefined) {
      const before = new Set(lastSeen.map((row) => row.intentId));
      setFresh(new Set(intents.data.map((row) => row.intentId).filter((id) => !before.has(id))));
    } else {
      setFresh(NONE);
    }
  }

  const count = (test: (row: IntentSummary) => boolean) => all.filter(test).length;
  const tally = [
    [
      'Paid on its own',
      count((row) => row.status === 'paid' && row.decision === 'auto'),
      'text-ok',
    ],
    [
      'Paid with approval',
      count((row) => row.status === 'paid' && row.decision === 'needs_approval'),
      'text-ok',
    ],
    ['Waiting for the approver', count((row) => row.status === 'pending_approval'), 'text-wait'],
    [
      'Refused, declined or failed',
      count(
        (row) => row.status === 'refused' || row.status === 'declined' || row.status === 'failed',
      ),
      'text-stop',
    ],
  ] as const;

  return (
    <div className="sheet content-start">
      <ScreenHead
        title="Live feed"
        about="Every request an agent sent to the gateway, and what the gateway decided. Newest first."
      />

      <div className="sheet grid-cols-2 md:grid-cols-4">
        {tally.map(([label, value, tone]) => (
          <div key={label} className="cell">
            <div className="label">{label}</div>
            <div className={cn('num mt-1 text-2xl leading-none', value > 0 ? tone : 'text-text-3')}>
              {value}
            </div>
          </div>
        ))}
      </div>

      <div className={cn(COLUMNS, 'label bg-ink-2 items-center gap-x-4 px-5 py-2')}>
        <span className="flex items-center gap-2">
          {mode === 'live' && !intents.isError ? <span aria-hidden className="live-dot" /> : null}
          Time UTC
        </span>
        <span className="hidden md:block">Outcome</span>
        <span className="hidden md:block">Amount</span>
        <span className="hidden md:block">Payee</span>
        <span>Request</span>
        <span className="hidden text-right md:block">Proof</span>
      </div>

      {intents.isError ? (
        <Note tone="stop" title="The feed could not be read">
          {intents.error.message}
        </Note>
      ) : intents.isPending ? (
        <Note title="Reading the feed…" />
      ) : rows.length === 0 ? (
        <Note title="No requests yet">
          When an agent asks the gateway for a payment, it appears here with the decision and the
          reasons. Run <code className="num text-xs">pnpm demo</code> to see the whole path.
        </Note>
      ) : (
        <ol className="sheet m-0 list-none p-0" aria-label="Requests, newest first">
          {rows.map((row, index) => (
            <Row key={row.intentId} row={row} arriving={fresh.has(row.intentId)} order={index} />
          ))}
        </ol>
      )}

      {all.length > SHOWN ? (
        <p className="cell text-text-3 text-xs">
          Showing the newest {SHOWN} of {all.length.toLocaleString('en-US')} requests.
        </p>
      ) : null}
    </div>
  );
}

function Row({ row, arriving, order }: { row: IntentSummary; arriving: boolean; order: number }) {
  const explained = row.decision !== 'auto' || row.status === 'failed';
  return (
    <li
      className={cn(COLUMNS, 'items-start gap-x-4 gap-y-1.5 px-5 py-3', arriving && 'arrive')}
      style={arriving ? { animationDelay: `${Math.min(order * 40, 280)}ms` } : undefined}
    >
      <div className="num text-text-2 text-xs leading-6">
        <time dateTime={row.decidedAt} title={`${day(row.decidedAt)} UTC`}>
          {clock(row.decidedAt)}
        </time>
      </div>
      <div className="md:order-none">
        <Stamp decision={row.decision} status={row.status} />
      </div>
      <div className="col-start-2 md:col-start-auto">
        <Money amount={row.amount} decimals={row.tokenDecimals} symbol={row.tokenSymbol} />
      </div>
      <div className="col-start-2 min-w-0 md:col-start-auto">
        <div className="truncate text-sm" title={row.payeeName ?? undefined}>
          {row.payeeName ?? 'Not in the vendor registry'}
        </div>
        <div className="num text-text-3 text-xs">{short(row.payee)}</div>
      </div>
      <div className="col-start-2 min-w-0 md:col-start-auto">
        <div className="line-clamp-2 text-sm break-words">{row.purpose}</div>
        {row.purchase ? (
          <div className="text-text-3 mt-0.5 truncate text-xs">
            Bought per call from {row.purchase.resource}
          </div>
        ) : null}
        {explained ? (
          <ul className="text-text-2 mt-1.5 list-none space-y-1 p-0 text-xs">
            {(row.error ? [row.error] : row.reasons).map((reason) => (
              <li key={reason} className="border-line-3 border-l pl-2 break-words">
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="col-start-2 flex min-w-0 flex-col items-start gap-0.5 md:col-start-auto md:items-end">
        {row.transactionHash ? (
          <HashValue
            value={row.transactionHash}
            href={row.explorerUrl}
            lead={6}
            tail={4}
            label="transaction"
          />
        ) : (
          <span className="text-text-3 text-xs leading-6">no transaction</span>
        )}
        <a
          href={href('evidence', row.intentId)}
          className="inline-flex items-center gap-1 text-xs no-underline hover:underline"
        >
          Evidence <ArrowRight aria-hidden className="size-3" />
        </a>
      </div>
    </li>
  );
}
