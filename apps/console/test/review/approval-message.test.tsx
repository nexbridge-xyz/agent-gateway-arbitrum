import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { signIntent } from '@agent-gateway/gateway/protocol';

import { DOMAIN, USDC, makeIntent } from '../../../gateway/test/helpers';
import { DECOY, THIEF, json, lie, open, useLyingGateway } from './harness';

/**
 * Review finding: the Approvals screen describes a payment on the left (the payee's name, the amount,
 * the purpose) and hands the wallet the typed message the gateway sent. The two come from different
 * fields of the gateway's answer, and nothing compares them. A gateway that somebody else controls can
 * describe the vendor's invoice and ask the wallet to sign a payment to its own address, for the
 * mandate's whole hard ceiling, or for another vault.
 *
 * The screen does tell the approver to compare. This is the one check the page itself can make.
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

type Approvals = {
  approvals: {
    tokenDecimals: number;
    approval: {
      domain: { verifyingContract: Address; chainId: number };
      message: { payee: Address; amount: string };
    };
  }[];
};

const waitingPayment = async () =>
  world.h.gateway.submit(
    await signIntent(
      world.h.world.agent,
      DOMAIN,
      makeIntent({
        agentId: world.h.world.agentId.toString(),
        payee: world.h.world.vendorB,
        amount: (6n * USDC).toString(),
        purpose: 'Invoice NR-2026-0042: quarterly sector report',
        invoiceId: 'NR-2026-0042',
      }),
    ),
  );

/** Presses "Sign approval" if the console offers it, and says what the wallet was asked to sign. */
async function pressSign() {
  const user = userEvent.setup();
  await open('#/approvals', [world.h.world.approver]);
  const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
  // The description on the left is the real one: Nagikumo Research, 6 USDC.
  expect(within(waiting).getByText('Nagikumo Research')).toBeInTheDocument();
  const sign = within(waiting).getByRole('button', { name: /Sign approval/ });
  // Give the page a moment to decide whether it offers the button.
  await waitFor(() => {
    expect(
      !(sign as HTMLButtonElement).disabled || within(waiting).queryByRole('alert') !== null,
    ).toBe(true);
  });
  if (!(sign as HTMLButtonElement).disabled) {
    await user.click(sign);
    await waitFor(() => {
      expect(
        world.node.sent('eth_signTypedData_v4').length + screen.queryAllByRole('alert').length,
      ).toBeGreaterThan(0);
    });
  }
  return world.node.sent('eth_signTypedData_v4').map(
    (call) =>
      JSON.parse(call.params[1] as string) as {
        domain: { verifyingContract: string };
        message: { payee: string; amount: string };
      },
  );
}

describe('review: the gateway asks the approver’s wallet for something else', () => {
  it('a typed message for another payee than the one shown must not reach the wallet', async () => {
    await waitingPayment();
    lie('/v1/approvals', (real) =>
      json<Approvals>(real, (body) => {
        for (const item of body.approvals) item.approval.message.payee = THIEF;
        return body;
      }),
    );

    // On main the wallet is asked to sign 6 USDC to THIEF under the heading "Nagikumo Research".
    expect(await pressSign()).toEqual([]);
    expect(await screen.findByText(/another payment than the one shown/i)).toBeInTheDocument();
  });

  it('a typed message for another amount than the one shown must not reach the wallet', async () => {
    await waitingPayment();
    lie('/v1/approvals', (real) =>
      json<Approvals>(real, (body) => {
        for (const item of body.approvals) item.approval.message.amount = (20n * USDC).toString();
        return body;
      }),
    );

    expect(await pressSign()).toEqual([]);
    expect(await screen.findByText(/another payment than the one shown/i)).toBeInTheDocument();
  });

  it('a typed message for another vault must not reach the wallet', async () => {
    await waitingPayment();
    lie('/v1/approvals', (real) =>
      json<Approvals>(real, (body) => {
        for (const item of body.approvals) item.approval.domain.verifyingContract = DECOY;
        return body;
      }),
    );

    expect(await pressSign()).toEqual([]);
    expect(await screen.findByText(/another vault or network/i)).toBeInTheDocument();
  });

  it('an amount shown in other units than the token has must not reach the wallet', async () => {
    await waitingPayment();
    // Seven decimals instead of six: the page reads "0.60 USDC" for a message that pays 6 USDC.
    lie('/v1/approvals', (real) =>
      json<Approvals>(real, (body) => {
        for (const item of body.approvals) item.tokenDecimals = 7;
        return body;
      }),
    );

    expect(await pressSign()).toEqual([]);
    expect(await screen.findByText(/other units than the token has/i)).toBeInTheDocument();
  });

  it('an honest message is signed, and the payment is made (control)', async () => {
    await waitingPayment();
    const asked = await pressSign();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message.payee.toLowerCase()).toBe(world.h.world.vendorB.toLowerCase());
    await waitFor(() => {
      expect(world.h.world.payments).toHaveLength(1);
    });
  });
});
