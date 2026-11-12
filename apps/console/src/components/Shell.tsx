import type { ReactNode } from 'react';

import { HashValue } from '@/components/parts';
import { WalletCell } from '@/components/WalletCell';
import {
  DATA_MODES,
  type DataMode,
  setDataMode,
  useApprovals,
  useDataMode,
  useGatewayConfig,
} from '@/lib/data';
import { DEMO_JPY_PER_USDC } from '@/lib/format';
import { SCREENS, type Screen, href } from '@/lib/route';
import { cn } from '@/lib/utils';

const TITLES: Record<Screen, string> = {
  feed: 'Live feed',
  approvals: 'Approvals',
  mandates: 'Mandates',
  evidence: 'Evidence',
  ledger: 'Ledger',
};

const MODE_NAMES: Record<DataMode, string> = { live: 'Live', worst: 'Worst', empty: 'Empty' };
const MODE_HINTS: Record<DataMode, string> = {
  live: 'The gateway and the chain',
  worst: 'Made-up worst-case data: a thousand rows, awkward names, huge amounts',
  empty: 'The screens with nothing in them',
};

/** The frame every screen sits in: the rail on the left, the strip of context on top. */
export function Shell({ screen, children }: { screen: Screen; children: ReactNode }) {
  const config = useGatewayConfig();
  const approvals = useApprovals();
  const mode = useDataMode();
  const waiting = approvals.data?.length ?? 0;
  const explorer = config.data?.explorerUrl ?? null;

  return (
    <div className="sheet min-h-screen grid-cols-1 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
      <aside className="flex flex-col lg:min-h-screen">
        <div className="cell border-b py-5">
          <div className="text-[1.0625rem] leading-tight font-semibold tracking-tight">
            Agent Gateway
          </div>
          <div className="label mt-1.5">NexBridge · console</div>
        </div>

        <nav aria-label="Screens" className="flex flex-row flex-wrap lg:flex-col">
          {SCREENS.map((name) => {
            const current = name === screen;
            return (
              <a
                key={name}
                href={href(name)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'relative flex h-11 items-center justify-between gap-3 px-5 text-sm no-underline',
                  'transition-colors duration-[120ms] ease-(--ease-brand)',
                  current
                    ? 'bg-surface text-foreground font-medium'
                    : 'text-text-2 hover:bg-surface hover:text-foreground',
                )}
              >
                {current ? (
                  <span aria-hidden className="bg-ice absolute inset-y-0 left-0 w-0.5" />
                ) : null}
                <span>{TITLES[name]}</span>
                {name === 'approvals' && waiting > 0 ? (
                  <span className="num border-wait/50 bg-wait-soft text-wait inline-flex h-5 min-w-5 items-center justify-center border px-1 text-[0.6875rem]">
                    {waiting}
                    <span className="sr-only"> waiting</span>
                  </span>
                ) : null}
              </a>
            );
          })}
        </nav>

        <div className="mt-auto hidden border-t lg:block">
          <div className="cell">
            <div className="label mb-2">Data shown</div>
            <div role="group" aria-label="Data shown" className="sheet grid-cols-3 border">
              {DATA_MODES.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={mode === name}
                  title={MODE_HINTS[name]}
                  onClick={() => {
                    setDataMode(name);
                  }}
                  className={cn(
                    'h-8 cursor-pointer border-0 px-1 text-[0.6875rem] transition-colors duration-[120ms]',
                    mode === name
                      ? 'bg-surface-3 text-foreground'
                      : 'text-text-3 hover:text-foreground bg-transparent',
                  )}
                >
                  {MODE_NAMES[name]}
                </button>
              ))}
            </div>
          </div>
          <p className="cell text-text-3 border-t text-xs">
            Testnet demo. Fictional company and vendor names.
          </p>
        </div>
      </aside>

      <div className="sheet min-w-0 grid-rows-[auto_1fr] content-start">
        <div className="sheet grid-cols-2 md:grid-cols-[1fr_1.2fr_1.1fr_minmax(13rem,auto)]">
          <div className="cell py-3">
            <div className="label">Network</div>
            <div className="mt-0.5 text-sm">
              Arbitrum Sepolia{' '}
              <span className="num text-text-3 text-xs">{config.data?.chainId ?? ''}</span>
            </div>
          </div>
          <div className="cell py-3">
            <div className="label">Vault</div>
            <div className="mt-0.5">
              {config.data ? (
                <HashValue
                  value={config.data.vault}
                  href={explorer ? `${explorer}/address/${config.data.vault}` : null}
                  label="vault address"
                />
              ) : (
                <span className="text-text-3 text-xs">
                  {config.isError ? 'gateway not reached' : 'reading…'}
                </span>
              )}
            </div>
          </div>
          <div className="cell col-span-2 py-3 md:col-span-1">
            <div className="label">Yen figures</div>
            <div
              className="num mt-0.5 text-xs md:whitespace-nowrap"
              title="A fixed rate for this demo. Not a market rate."
            >
              1 {config.data?.token.symbol ?? 'USDC'} = <span className="text-signal">¥</span>
              {DEMO_JPY_PER_USDC.toString()} <span className="text-text-3">fixed demo rate</span>
            </div>
          </div>
          <div className="col-span-2 flex items-stretch md:col-span-1">
            <WalletCell />
          </div>
        </div>

        <main className="min-w-0">
          {mode !== 'live' ? (
            <p className="bg-wait-soft text-wait border-b px-5 py-2 text-xs" role="status">
              {mode === 'worst'
                ? 'Showing made-up worst-case data, not the gateway. Nothing here is on a chain.'
                : 'Showing the screens with no data, not the gateway.'}
            </p>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
