import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletCell, offered } from '@/components/WalletCell';
import { setDataMode } from '@/lib/data';
import { sample } from '@/lib/sample';

import { bridge, fakeNode, show, testConfig } from './helpers';

// Connecting and disconnecting a wallet, and what the console says the wallet is in this vault. The
// made-up data set supplies the vault's principal and approver.

beforeEach(() => {
  setDataMode('worst');
  bridge({ node: fakeNode({}) });
});
afterEach(() => {
  setDataMode('live');
  vi.unstubAllGlobals();
});

const connectWith = async (address: string) => {
  const user = userEvent.setup();
  show(<WalletCell />, testConfig([getAddress(address)]));
  await user.click(screen.getByRole('button', { name: /Connect wallet/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Mock Connector' }));
  return user;
};

describe('the wallet in the top strip', () => {
  it('offers to connect, and says which role the connected wallet has', async () => {
    await connectWith(sample.config().principal);
    expect(await screen.findByText('Principal')).toBeInTheDocument();
    // The button the menu hung on is gone. The focus is on the one that took its place.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Principal/ })).toHaveFocus();
    });
  });

  it("knows a mandate's approver", async () => {
    const approver = sample.mandates()[0]?.approver ?? '';
    await connectWith(approver);
    expect(await screen.findByText('Approver')).toBeInTheDocument();
  });

  it('says so when the wallet has no role, and lets it disconnect', async () => {
    const user = await connectWith('0x00000000000000000000000000000000000000aa');
    const connected = await screen.findByRole('button', { name: /No role in this vault/ });
    await user.click(connected);
    await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Connect wallet/ })).toHaveFocus();
    });
  });
});

describe('the wallets the menu offers', () => {
  const generic = { id: 'injected', type: 'injected', name: 'Injected' };
  const named = { id: 'test.standin.wallet', type: 'injected', name: 'Stand-in Wallet' };
  const test = { id: 'test-approver', type: 'mock', name: 'Test wallet: approver' };

  it('lists a wallet that announces itself by its name, and only once', () => {
    expect(offered([generic, named])).toEqual([named]);
    expect(offered([generic, named, test])).toEqual([named, test]);
  });

  it('keeps "Browser wallet" for a wallet that does not announce itself', () => {
    expect(offered([generic])).toEqual([generic]);
    expect(offered([generic, test])).toEqual([generic, test]);
  });
});
