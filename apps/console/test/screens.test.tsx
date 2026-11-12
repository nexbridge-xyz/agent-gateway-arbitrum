import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('feed: shows text as it was sent, never run or formatted, and says when a purpose is blank', async () => {
    open('#/feed');
    await screen.findByText('Showing the newest 200 of 1,000 requests.');
    expect(
      screen.getAllByText('<script>alert(1)</script> &amp; **bold** <b>not bold</b>').length,
    ).toBeGreaterThan(0);
    expect(document.querySelector('main script')).toBeNull();
    expect(screen.getAllByText('(no purpose given)').length).toBeGreaterThan(0);
  });

  it('feed: writes the largest amount the gateway accepts in full, with its yen figure', async () => {
    open('#/feed');
    await screen.findByText('Showing the newest 200 of 1,000 requests.');
    // 2^256 - 1 in a token of six decimals. Nothing is cut and nothing turns into a float.
    expect(
      screen.getAllByText(
        '115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457,584,007,913,129.639935',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        '17,368,813,385,597,429,313,535,647,751,303,186,177,990,497,699,846,084,605,918,637,601,186,969,446',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('feed: shows three lines of a long error and keeps the whole of it within reach', async () => {
    open('#/feed');
    await screen.findByText('Showing the newest 200 of 1,000 requests.');
    const [error] = screen.getAllByText(/^HTTP request failed\./);
    expect(error).toHaveClass('line-clamp-3');
    expect(error).toHaveAttribute('title', expect.stringContaining('Version: viem@2.57.15'));
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

  it('approvals: the payment picked from the list takes the focus', async () => {
    const user = userEvent.setup();
    open('#/approvals');
    const others = await screen.findByRole('region', { name: 'Also waiting' });
    const [review] = within(others).getAllByRole('button', { name: /Review/ });
    if (review === undefined) throw new Error('nothing else is waiting');
    await user.click(review);

    const waiting = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(within(waiting).getByText(/^2 of 3/)).toBeInTheDocument();
    // The button that was pressed is gone. The focus must not be left on nothing.
    expect(waiting).toHaveFocus();
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

  it('mandates: draws one that pays nothing on its own, lists forty payees and has no end date', async () => {
    open('#/mandates');
    const mandate = await screen.findByRole('region', { name: 'Mandate 10' });
    expect(within(mandate).getByRole('img')).toHaveAccessibleName(
      'Paid today 0.00 USDC. Per payment up to 0.00, per day up to 0.00, hard ceiling 20.00 with approvals included.',
    );
    expect(within(mandate).getByText('further payments need approval')).toBeInTheDocument();
    expect(within(mandate).getByText(/\(40 payees\)/)).toBeInTheDocument();
    expect(within(mandate).getByText('no end date')).toBeInTheDocument();
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

describe('moving between screens', () => {
  beforeEach(() => {
    setDataMode('empty');
  });

  it('leaves the focus alone on the first screen, and moves it to the title after a change', async () => {
    open('#/feed');
    expect(await screen.findByRole('heading', { level: 1, name: 'Live feed' })).not.toHaveFocus();

    act(() => {
      window.location.hash = '#/ledger';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Ledger' })).toHaveFocus();
  });

  it('has a first stop that skips to the content without changing the screen', async () => {
    const user = userEvent.setup();
    open('#/ledger');
    await screen.findByRole('heading', { level: 1, name: 'Ledger' });
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to the content' });
    expect(skip).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.location.hash).toBe('#/ledger');
  });
});

describe('one: exactly one of everything', () => {
  beforeEach(() => {
    setDataMode('one');
  });

  it('counts in the singular', async () => {
    const feed = open('#/feed');
    const list = await screen.findByRole('list', { name: 'Requests, newest first' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .filter((item) => item.parentElement === list),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Approvals/ })).toHaveTextContent('1 waiting');
    });
    feed.unmount();

    const approvals = open('#/approvals');
    const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
    expect(within(waiting).getByText(/^1 of 1/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Also waiting' })).not.toBeInTheDocument();
    approvals.unmount();

    const mandates = open('#/mandates');
    const mandate = await screen.findByRole('region', { name: 'Mandate 9' });
    expect(within(mandate).getByText(/\(1 payee\)/)).toBeInTheDocument();
    mandates.unmount();

    open('#/ledger');
    expect(await screen.findByText(/^1 entry, each one following/)).toBeInTheDocument();
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
