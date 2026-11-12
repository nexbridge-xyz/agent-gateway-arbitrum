import { money } from '@/lib/format';
import { cn } from '@/lib/utils';

const TICKS = Array.from({ length: 19 }, (_, index) => index + 1);

/**
 * The limit rail: a mandate drawn to scale.
 *
 * One line runs from zero to the hard ceiling, under a ruler of twenty divisions. The daily cap is a
 * post on it. What the mandate has paid today fills the line from the left. The dashed bracket after
 * the fill is the room for the next payment that can run on its own: the per-payment cap, or what is
 * left of the day, whichever is less. Past the daily cap the line is hatched: that stretch can only be
 * reached with the approver's signature.
 *
 * With `proposed`, the rail also shows one payment that is being asked for, placed after today's total.
 */
export function LimitRail({
  perPaymentCap,
  dailyCap,
  hardCeiling,
  spentToday,
  decimals,
  symbol,
  inactive = false,
  proposed,
}: {
  perPaymentCap: bigint;
  dailyCap: bigint;
  hardCeiling: bigint;
  spentToday: bigint;
  decimals: number;
  symbol: string;
  inactive?: boolean;
  proposed?: bigint;
}) {
  // Positions in percent of the ceiling, to two decimals, without floating-point amounts.
  const at = (value: bigint) => {
    if (hardCeiling <= 0n) return 0;
    const clamped = value < 0n ? 0n : value > hardCeiling ? hardCeiling : value;
    return Number((clamped * 10_000n) / hardCeiling) / 100;
  };
  const spent = at(spentToday);
  const daily = at(dailyCap);
  const ownEnd = spentToday >= dailyCap ? spentToday : spentToday + perPaymentCap;
  const next = at(ownEnd > dailyCap ? dailyCap : ownEnd);
  const left = dailyCap > spentToday ? dailyCap - spentToday : 0n;
  const asked = proposed === undefined ? null : at(spentToday + proposed);
  const amount = (value: bigint) => money(value, decimals);

  const summary =
    `Paid today ${amount(spentToday)} ${symbol}. ` +
    `Per payment up to ${amount(perPaymentCap)}, per day up to ${amount(dailyCap)}, ` +
    `hard ceiling ${amount(hardCeiling)} with approvals included.` +
    (proposed === undefined
      ? ''
      : ` This payment of ${amount(proposed)} would take today's total to ${amount(spentToday + proposed)}.`);

  return (
    <div className={cn('w-full', inactive && 'opacity-45')}>
      <div className="num mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <span>
          <span className="label mr-2">Paid today, UTC</span>
          <span className="text-foreground text-base">{amount(spentToday)}</span>
          <span className="text-text-3 ml-1">{symbol}</span>
        </span>
        <span className="text-text-3">
          {proposed !== undefined
            ? `with this payment ${amount(spentToday + proposed)} of ${amount(hardCeiling)}`
            : left > 0n
              ? `${amount(left)} left before approval is needed`
              : 'further payments need approval'}
        </span>
      </div>

      <div role="img" aria-label={summary} className="relative h-[3.25rem]">
        {/* The ruler: twenty divisions from zero to the ceiling, every fifth one longer. */}
        {TICKS.map((tick) => (
          <div
            key={tick}
            className={cn(
              'bg-line-3 absolute w-px',
              tick % 5 === 0 ? 'top-0 h-[14px]' : 'top-[7px] h-[7px]',
            )}
            style={{ left: `${tick * 5}%` }}
          />
        ))}
        {/* The line itself. Past the daily cap it is hatched: reachable only with an approval. */}
        <div className="bg-line-3 absolute inset-x-0 top-[19px] h-px" />
        <div
          className="absolute top-[17px] h-[5px]"
          style={{
            left: `${daily}%`,
            right: 0,
            backgroundImage:
              'repeating-linear-gradient(135deg, color-mix(in srgb, var(--console-wait) 55%, transparent) 0 1px, transparent 1px 5px)',
          }}
        />
        {/*
          What has been paid today: on its own up to the daily cap, with approvals beyond it. Each bar
          spans its whole stretch and is scaled from the left, so a change does not lay the page out again.
        */}
        {daily > 0 ? (
          <div
            className="rail-fill bg-ok absolute top-[17px] left-0 h-[5px]"
            style={{ width: `${daily}%`, transform: `scaleX(${Math.min(spent, daily) / daily})` }}
          />
        ) : null}
        {daily < 100 ? (
          <div
            className="rail-fill bg-wait absolute top-[17px] right-0 h-[5px]"
            style={{
              left: `${daily}%`,
              transform: `scaleX(${spent > daily ? (spent - daily) / (100 - daily) : 0})`,
            }}
          />
        ) : null}
        {/* The payment that is being asked for. */}
        {asked !== null && asked > spent ? (
          <div
            className="border-wait bg-wait/30 absolute top-[13px] h-[13px] border"
            style={{ left: `${spent}%`, width: `${asked - spent}%` }}
          />
        ) : null}
        {/* Room for the next payment that runs on its own. */}
        {asked === null && next > spent ? (
          <div
            className="border-ok/80 absolute top-[13px] h-[13px] border-y border-r border-dashed"
            style={{ left: `${spent}%`, width: `${next - spent}%` }}
          />
        ) : null}
        {/* Zero, the daily cap and the ceiling, as posts on the line. */}
        <div className="bg-foreground absolute top-0 left-0 h-[30px] w-px" />
        <div className="bg-foreground absolute top-0 h-[30px] w-px" style={{ left: `${daily}%` }} />
        <div className="bg-foreground absolute top-0 right-0 h-[30px] w-px" />

        <div className="num text-text-2 absolute inset-x-0 top-[36px] text-[0.6875rem]">
          <span className="absolute left-0">0</span>
          {daily >= 8 && daily < 82 ? (
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${daily}%` }}
            >
              per day {amount(dailyCap)}
            </span>
          ) : null}
          <span className="absolute right-0 whitespace-nowrap">
            {daily >= 82
              ? `per day and ceiling ${amount(hardCeiling)}`
              : `ceiling ${amount(hardCeiling)}`}
            {daily < 8 ? `, per day ${amount(dailyCap)}` : ''}
          </span>
        </div>
      </div>

      <p className="num text-text-3 mt-2 text-[0.6875rem]">
        per payment up to {amount(perPaymentCap)} {symbol}
        {proposed === undefined ? '' : `, this payment ${amount(proposed)}`}
      </p>
    </div>
  );
}
