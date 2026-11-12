import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Address, type Hex, decodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { mandateVaultAbi } from '@agent-gateway/contracts/abi';

import { USDC, VAULT } from '../../../gateway/test/helpers';
import { DECOY, json, lie, open, useLyingGateway } from './harness';

/**
 * Review finding: the console builds the principal's transactions from what the gateway says about
 * its vault in /v1/config.
 *
 * The console's own code says it "does not ask the gateway what the chain says". But it asks the
 * gateway which contract the vault is, and how many decimals its token has. A gateway that somebody
 * else controls can therefore:
 *
 *  - send the principal's revocation to a contract of its own, where it changes nothing, while the
 *    real mandate stays live in the real vault;
 *  - have the principal create a mandate whose caps are a million times what was typed.
 *
 * The principal's only defence on main is to read a hex address and raw integers in the wallet.
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

const world = useLyingGateway(chainState);

type Sent = { to: string; data: Hex };
const sent = () => world.node.sent('eth_sendTransaction').map((call) => call.params[0] as Sent);

describe('review: the gateway names another vault', () => {
  it('the principal’s revocation must not go to a contract the gateway chose', async () => {
    // The gateway says the vault is DECOY. A copy of the vault there can show the same mandates and
    // accept revokeMandate, while the real mandate stays live in the real vault.
    lie('/v1/config', (real) =>
      json<{ vault: Address }>(real, (body) => ({ ...body, vault: DECOY })),
    );

    const user = userEvent.setup();
    await open('#/mandates', [world.h.world.principal]);
    const mandate = await screen.findByRole('region', { name: 'Mandate 1' });

    const revoke = within(mandate).queryByRole('button', { name: 'Revoke' });
    if (revoke !== null && !(revoke as HTMLButtonElement).disabled) {
      await user.click(revoke);
      await user.click(within(mandate).getByRole('button', { name: 'Yes, revoke mandate 1' }));
      await waitFor(() => {
        expect(sent().length + screen.queryAllByRole('alert').length).toBeGreaterThan(0);
      });
    }

    // On main the wallet is asked to send revokeMandate(1) to DECOY.
    expect(sent()).toEqual([]);
    expect(
      (await screen.findAllByText(/not the vault this console was started for/i)).length,
    ).toBeGreaterThan(0);
  });

  it('a new mandate must not go to a contract the gateway chose either', async () => {
    lie('/v1/config', (real) =>
      json<{ vault: Address }>(real, (body) => ({ ...body, vault: DECOY })),
    );

    await open('#/mandates', [world.h.world.principal]);
    await screen.findByRole('region', { name: 'Mandate 1' });
    expect(screen.getByRole('button', { name: /New mandate/ })).toBeDisabled();
  });
});

describe('review: the gateway lies about the token', () => {
  it('caps typed as 2, 8 and 20 USDC must not reach the vault as millions', async () => {
    // USDC has six decimals. The gateway says twelve, and the console multiplies by what it is told.
    lie('/v1/config', (real) =>
      json<{ token: { decimals: number } }>(real, (body) => ({
        ...body,
        token: { ...body.token, decimals: 12 },
      })),
    );

    const user = userEvent.setup();
    await open('#/mandates', [world.h.world.principal]);
    await screen.findByRole('region', { name: 'Mandate 1' });

    const create = screen.getByRole('button', { name: /New mandate/ });
    if (!(create as HTMLButtonElement).disabled) {
      await user.click(create);
      const dialog = await screen.findByRole('dialog', { name: 'New mandate' });
      await user.type(within(dialog).getByLabelText('Agent id (ERC-8004)'), '354');
      await user.click(within(dialog).getByRole('button', { name: /Create mandate/ }));
      await waitFor(() => {
        expect(sent().length).toBeGreaterThan(0);
      });
    }

    // On main: createMandate(…, 2_000_000_000_000, 8_000_000_000_000, 20_000_000_000_000, …), which is
    // 2, 8 and 20 MILLION USDC, under a form that read "2", "8" and "20".
    const caps = sent().map((transaction) => {
      const call = decodeFunctionData({ abi: mandateVaultAbi, data: transaction.data });
      return (call.args as readonly unknown[]).slice(4, 7);
    });
    expect(caps.filter(([perPayment]) => perPayment !== 2n * USDC)).toEqual([]);
    expect(sent()).toEqual([]);
    expect(
      (await screen.findAllByText(/does not match the vault on the chain/i)).length,
    ).toBeGreaterThan(0);
  });
});

describe('review: a gateway that tells the truth (control)', () => {
  it('lets the principal revoke, and the transaction goes to the vault', async () => {
    const user = userEvent.setup();
    await open('#/mandates', [world.h.world.principal]);
    const mandate = await screen.findByRole('region', { name: 'Mandate 1' });

    await waitFor(() => {
      expect(within(mandate).getByRole('button', { name: 'Revoke' })).toBeEnabled();
    });
    await user.click(within(mandate).getByRole('button', { name: 'Revoke' }));
    await user.click(within(mandate).getByRole('button', { name: 'Yes, revoke mandate 1' }));
    await waitFor(() => {
      expect(sent()).toHaveLength(1);
    });
    expect(sent()[0]?.to.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(screen.queryByText(/not the vault this console was started for/i)).toBeNull();
  });
});
