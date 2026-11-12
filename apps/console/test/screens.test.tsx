import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { setDataMode } from '@/lib/data';
import { sample } from '@/lib/sample';

import { bridge, show } from './helpers';

// The screens under strain and with nothing in them, on the console's own made-up data. No gateway
// and no chain are involved: a request to either fails the test.

const open = (hash: string) => {
  window.location.hash = hash;
  return show(<App />);
};

beforeEach(() => {
  bridge({});
});
afterEach(() => {
  setDataMode('live');
  vi.unstubAllGlobals();
});

describe('worst case: a thousand requests, awkward names, huge amounts', () => {
  beforeEach(() => {
    setDataMode('worst');
  });

  it('says on every screen that the data is made up', async () => {
    open('#/feed');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Showing made-up worst-case data, not the gateway',
    );
  });

  it('feed: shows the newest 200 of 1,000 and counts all of them', async () => {
    open('#/feed');
    expect(
      await screen.findByText('Showing the newest 200 of 1,000 requests.'),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Requests, newest first' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .filter((item) => item.parentElement === list),
    ).toHaveLength(200);

    // 1,000 requests cycle through eight outcomes: two of them paid on their own, one each of the rest
    // (waiting, refused, paid with approval, declined, failed, still paying).
    const tally = (label: string) => screen.getByText(label).nextElementSibling;
    expect(tally('Paid on its own')).toHaveTextContent('250');
    expect(tally('Paid with approval')).toHaveTextContent('125');
    expect(tally('Waiting for the approver')).toHaveTextContent('125');
    expect(tally('Refused, declined or failed')).toHaveTextContent('375');
  });

  it('feed: keeps long, one-letter and non-Latin names, and says when a payee is unknown', async () => {
    open('#/feed');
    await screen.findByText('Showing the newest 200 of 1,000 requests.');
    expect(
      screen.getAllByText(/Hoshizora Logistics and Warehousing Holdings/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('月見データ株式会社').length).toBeGreaterThan(0);
    expect(screen.getAllByText('محل البيانات').length).toBeGreaterThan(0);
    expect(screen.getAllByText('K').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not in the vendor registry').length).toBeGreaterThan(0);
    // An amount with eighteen digits is written out in full, with its yen figure.
    expect(screen.getAllByText('999,999,999,999.999999').length).toBeGreaterThan(0);
    expect(screen.getAllByText('150,000,000,000,000').length).toBeGreaterThan(0);
  });

  it('approvals: shows one payment at a time, lists the rest, and does not let anyone sign', async () => {
    open('#/approvals');
    const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
    expect(within(waiting).getByText(/^1 of 3/)).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: /Sign approval/ })).toBeDisabled();
    expect(within(waiting).getByRole('button', { name: 'Decline' })).toBeDisabled();
    expect(within(waiting).getByRole('status')).toHaveTextContent(
      'This is made-up data. Signing is switched off.',
    );

    const others = screen.getByRole('region', { name: 'Also waiting' });
    expect(within(others).getAllByRole('button', { name: /Review/ })).toHaveLength(2);
    // The approvals count sits next to the screen's name in the rail.
    expect(screen.getByRole('link', { name: /Approvals/ })).toHaveTextContent('3 waiting');
  });

  it('mandates: draws every state, and switches creating and revoking off', async () => {
    open('#/mandates');
    expect(await screen.findByRole('region', { name: 'Mandate 9' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: /^Mandate \d+$/ })).toHaveLength(
      sample.mandates().length,
    );
    expect(
      within(screen.getByRole('region', { name: 'Mandate 5' })).getByText('Revoked'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Mandate 4' })).getByText('Expired'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New mandate/ })).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: 'Revoke' }))
      expect(button).toBeDisabled();

    // Mandate 9 has paid 13.70 of a daily cap of 8: the rest went through with approvals.
    const rail = within(screen.getByRole('region', { name: 'Mandate 9' })).getByRole('img');
    expect(rail).toHaveAccessibleName(
      'Paid today 13.70 USDC. Per payment up to 2.00, per day up to 8.00, hard ceiling 20.00 with approvals included.',
    );
    expect(
      within(screen.getByRole('region', { name: 'Mandate 9' })).getByText(
        'further payments need approval',
      ),
    ).toBeInTheDocument();
  });

  it('ledger: says where the chain of hashes breaks', async () => {
    open('#/ledger');
    expect(await screen.findByText('Chain broken')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The chain breaks at entry 3: previous hash does not match.',
    );
    expect(screen.getByText('Showing the newest 300 of 400 entries.')).toBeInTheDocument();
  });

  it('evidence: lists the latest records to pick from, and opens one', async () => {
    open('#/evidence');
    const latest = await screen.findByRole('region', { name: 'Latest records' });
    expect(within(latest).getAllByRole('link')).toHaveLength(30);
  });

  it('evidence: shows a paid record with its transaction, and a refused one with nothing onchain', async () => {
    const [paid, , , refused] = sample.intents();
    if (paid === undefined || refused === undefined) throw new Error('the sample data is short');

    const first = open(`#/evidence/${paid.intentId}`);
    expect(await screen.findByText(paid.evidenceHash)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /payment transaction/ })).toHaveAttribute(
      'href',
      `https://sepolia.arbiscan.io/tx/${paid.transactionHash ?? ''}`,
    );
    first.unmount();

    open(`#/evidence/${refused.intentId}`);
    expect(await screen.findByText(refused.evidenceHash)).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing was paid on this record, so nothing about it is onchain/),
    ).toBeInTheDocument();
  });

  it('evidence: says so when the address bar holds something that is not an intent id', async () => {
    open('#/evidence/not-an-id');
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not an intent id');
  });
});

describe('empty: a gateway that has seen no request', () => {
  beforeEach(() => {
    setDataMode('empty');
  });

  it.each([
    ['#/feed', 'No requests yet'],
    ['#/approvals', 'Nothing is waiting for approval'],
    ['#/mandates', 'This vault has no mandates yet'],
    ['#/ledger', 'The ledger is empty'],
    ['#/evidence', 'No records yet'],
  ])('%s says what will appear there', async (hash, text) => {
    open(hash);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});
