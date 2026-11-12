import { HashValue, Mark, Note, ScreenHead } from '@/components/parts';
import { useLedger } from '@/lib/data';
import { clock, day, short } from '@/lib/format';
import { href } from '@/lib/route';
import { cn } from '@/lib/utils';

const COLUMNS =
  'grid grid-cols-[3rem_minmax(0,1fr)] md:grid-cols-[3.5rem_9.5rem_11rem_minmax(0,1fr)_13rem]';
const SHOWN = 300;

/** The gateway's own running record: every decision, approval and payment, each entry chained to the one before. */
export function Ledger() {
  const ledger = useLedger();
  const entries = ledger.data?.entries ?? [];
  const newestFirst = [...entries].reverse().slice(0, SHOWN);
  const check = ledger.data?.check;

  return (
    <div className="sheet content-start">
      <ScreenHead
        title="Ledger"
        about="The gateway's running record. Each entry carries the hash of the one before it, so an entry cannot be changed or removed without breaking the chain after it."
      />

      {ledger.isError ? (
        <Note tone="stop" title="The ledger could not be read">
          {ledger.error.message}
        </Note>
      ) : ledger.isPending || check === undefined ? (
        <Note title="Reading the ledger…" />
      ) : (
        <>
          <div className="sheet grid-cols-1 md:grid-cols-[auto_1fr_auto]">
            <div className="cell flex items-center">
              {check.ok ? (
                <Mark tone="ok">Chain intact</Mark>
              ) : (
                <Mark tone="stop">Chain broken</Mark>
              )}
            </div>
            <div className="cell text-sm">
              {check.ok ? (
                <>
                  {check.count} {check.count === 1 ? 'entry' : 'entries'}, each one following from
                  the one before.
                </>
              ) : (
                <span className="text-stop" role="alert">
                  The chain breaks at entry {check.brokenAt}: {check.why}. Entries from that point
                  on cannot be relied on.
                </span>
              )}
              <p className="text-text-3 mt-1 text-xs">
                This shows the ledger agrees with itself. Whoever holds it could still rebuild it or
                cut it short. The vault&apos;s events on Arbitrum are the part nobody can rewrite.
              </p>
            </div>
            <div className="cell">
              <div className="label mb-1">Head</div>
              <HashValue value={ledger.data.head} label="ledger head" />
            </div>
          </div>

          <div className={`${COLUMNS} label bg-ink-2 gap-x-4 px-5 py-2`}>
            <span>No.</span>
            <span className="hidden md:block">Time UTC</span>
            <span className="hidden md:block">Kind</span>
            <span>Entry</span>
            <span className="hidden md:block">Hash, after the one before</span>
          </div>

          {newestFirst.length === 0 ? (
            <Note title="The ledger is empty">
              The first decision the gateway makes becomes entry 1.
            </Note>
          ) : (
            <ol className="sheet m-0 list-none p-0" aria-label="Ledger entries, newest first">
              {newestFirst.map((entry, index) => {
                const intentId =
                  typeof entry.data.intentId === 'string' ? entry.data.intentId : null;
                // From the entry where the chain breaks onwards, nothing can be relied on.
                const broken = !check.ok && entry.seq >= check.brokenAt;
                const link = broken ? 'bg-stop/60' : 'bg-line-3';
                return (
                  <li
                    key={entry.seq}
                    className={`${COLUMNS} items-start gap-x-4 gap-y-1 px-5 py-2.5`}
                  >
                    <span className="num text-text-3 text-xs leading-5">{entry.seq}</span>
                    <time
                      className="num text-text-2 col-start-2 text-xs leading-5 md:col-start-auto"
                      dateTime={entry.ts}
                      title={`${day(entry.ts)} UTC`}
                    >
                      {day(entry.ts).replace(/ \d{4}$/, '')} {clock(entry.ts)}
                    </time>
                    <span className="num text-ice col-start-2 text-[0.6875rem] leading-5 tracking-[0.04em] md:col-start-auto">
                      {entry.kind.replaceAll('_', ' ')}
                    </span>
                    <span className="col-start-2 min-w-0 text-sm break-words md:col-start-auto">
                      {entry.summary}
                      {intentId ? (
                        <a
                          className="ml-2 text-xs whitespace-nowrap no-underline hover:underline"
                          href={href('evidence', intentId)}
                        >
                          evidence
                        </a>
                      ) : null}
                    </span>
                    {/* The chain, drawn: each hash hangs on the one before it, the row below. */}
                    <span className="num text-text-3 relative col-start-2 self-stretch pl-5 text-xs md:col-start-auto">
                      {index > 0 ? (
                        <span
                          aria-hidden
                          className={cn('absolute -top-[11px] left-[3px] h-[16px] w-px', link)}
                        />
                      ) : null}
                      {entry.seq > 1 ? (
                        <span
                          aria-hidden
                          className={cn('absolute top-[12px] -bottom-[11px] left-[3px] w-px', link)}
                        />
                      ) : null}
                      <span
                        aria-hidden
                        className={cn(
                          'absolute top-[5px] left-0 size-[7px] border',
                          broken ? 'border-stop bg-stop-soft' : 'border-ice bg-ink',
                        )}
                      />
                      <span className={broken ? 'text-stop' : 'text-text-2'}>
                        {short(entry.hash, 8, 6)}
                      </span>
                      <br />
                      after {short(entry.prev, 8, 6)}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {entries.length > SHOWN ? (
            <p className="cell text-text-3 text-xs">
              Showing the newest {SHOWN} of {entries.length.toLocaleString('en-US')} entries.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
