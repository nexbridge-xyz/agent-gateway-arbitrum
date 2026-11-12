import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LimitRail } from '@/components/LimitRail';

const USDC = 1_000_000n;
const rail = (
  spentToday: bigint,
  caps: [bigint, bigint, bigint] = [2n * USDC, 8n * USDC, 20n * USDC],
) =>
  render(
    <LimitRail
      perPaymentCap={caps[0]}
      dailyCap={caps[1]}
      hardCeiling={caps[2]}
      spentToday={spentToday}
      decimals={6}
      symbol="USDC"
    />,
  );

describe('the limit rail', () => {
  it('says the same in words as it draws', () => {
    rail(1_500_000n);
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Paid today 1.50 USDC. Per payment up to 2.00, per day up to 8.00, hard ceiling 20.00 with approvals included.',
    );
    expect(screen.getByText('6.50 left before approval is needed')).toBeInTheDocument();
    expect(screen.getByText('per day 8.00')).toBeInTheDocument();
    expect(screen.getByText('ceiling 20.00')).toBeInTheDocument();
  });

  it('says that further payments need approval once the daily cap is used up', () => {
    rail(8n * USDC);
    expect(screen.getByText('further payments need approval')).toBeInTheDocument();
  });

  it('writes one label where the daily cap is the ceiling', () => {
    rail(500_000n, [500_000n, USDC, USDC]);
    expect(screen.getByText('per day and ceiling 1.00')).toBeInTheDocument();
    expect(screen.queryByText('per day 1.00')).not.toBeInTheDocument();
  });

  it('draws a mandate with amounts a float cannot hold, and one with nothing spent', () => {
    const huge = 999_999_999_999_999_999n;
    rail(12_345_678_901_234n, [huge, huge, huge]);
    expect(screen.getByRole('img')).toHaveAccessibleName(/Paid today 12,345,678.901234 USDC/);
  });
});
