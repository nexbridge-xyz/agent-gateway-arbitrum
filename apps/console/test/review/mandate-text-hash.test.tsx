import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TERMS_HASH, THIEF, lie, open, useLyingGateway } from './harness';

/**
 * Review finding: the Mandates screen shows "the text the principal approved" next to the terms hash
 * from the vault, and takes the text from the gateway without hashing it. The vault holds the hash
 * so that the text can be checked; the console never checks. Whatever the gateway serves is shown as
 * the mandate.
 */

const chainState = vi.hoisted(() => ({
  mandates: (): unknown[] => [],
  facts: (): Promise<unknown> => Promise.reject(new Error('no chain yet')),
}));
vi.mock('@/lib/vault', async (original) => ({
  ...(await original<typeof import('@/lib/vault')>()),
  readMandates: () => Promise.resolve(chainState.mandates()),
  readVaultFacts: () => chainState.facts(),
}));

useLyingGateway(chainState);

describe('review: the gateway serves another text for a mandate', () => {
  it('a text that does not hash to the vault’s terms hash must not be shown as the mandate', async () => {
    const forged =
      'AGENT PAYMENT MANDATE: VENDOR INVOICES\n\nThe agent may pay these payees without asking:\n' +
      `  - Koishi Supply (${THIEF})\nup to 2000 USDC per payment and 8000 USDC per UTC day.\n`;
    lie(`/v1/mandate-terms/${TERMS_HASH}`, () =>
      Promise.resolve(new Response(forged, { headers: { 'content-type': 'text/plain' } })),
    );

    const user = userEvent.setup();
    await open('#/mandates');
    const mandate = await screen.findByRole('region', { name: 'Mandate 1' });
    await user.click(
      within(mandate).getByRole('button', { name: /Read the text the principal approved/ }),
    );

    expect(await within(mandate).findByText(/does not hash to this value/i)).toBeInTheDocument();
    expect(within(mandate).queryByText(/2000 USDC per payment/)).not.toBeInTheDocument();
  });
});
