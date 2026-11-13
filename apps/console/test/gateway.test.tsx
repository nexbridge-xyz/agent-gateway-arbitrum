import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type Address,
  type Hex,
  decodeFunctionData,
  keccak256,
  numberToHex,
  stringToHex,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, switchChain } from 'wagmi/actions';

import { mandateVaultAbi } from '@agent-gateway/contracts/abi';
import { MandateTermsStore, createApp, verifyEvidence } from '@agent-gateway/gateway';
import { signIntent } from '@agent-gateway/gateway/protocol';

import { App } from '@/App';
import type { Mandate } from '@/lib/vault';

import { type FakeMandate, type Harness, createHarness } from '../../gateway/test/fakes';
import { DOMAIN, NOW, USDC, VAULT, makeIntent } from '../../gateway/test/helpers';
import { OTHER_CHAIN, bridge, fakeNode, show, testConfig } from './helpers';

// The console against the gateway's real code. The gateway runs in this process on its test chain, the
// console talks to it over HTTP as it does in a browser, and a stand-in node plays the wallet's part:
// it signs with the test's throwaway keys and takes the transactions the console sends.
//
// What this pins down: the console and the gateway agree on every route and shape, the approval the
// console asks a wallet to sign is the one the gateway and the vault accept, and a new mandate goes to
// the vault with the limits typed into the form and the hash of the text that was stored.

// Mandates are read from the chain. Here they are read from the gateway's test chain instead.
// So is what the vault and its token say of themselves, which the console compares with the gateway's
// description before it sends or signs anything.
const chainState = vi.hoisted(() => ({
  mandates: (): unknown[] => [],
  facts: (): Promise<unknown> => Promise.reject(new Error('no chain yet')),
}));
vi.mock('@/lib/vault', async (original) => ({
  ...(await original<typeof import('@/lib/vault')>()),
  readMandates: () => Promise.resolve(chainState.mandates()),
  readVaultFacts: () => chainState.facts(),
}));

const TERMS_HASH: Hex = `0x${'11'.repeat(32)}`;
const TX_HASH: Hex = `0x${'ab'.repeat(32)}`;

/** The receipt of the one transaction the console sends in these tests. */
const RECEIPT = () => ({
  transactionHash: TX_HASH,
  transactionIndex: '0x0',
  blockHash: `0x${'cd'.repeat(32)}`,
  blockNumber: '0x3e9',
  from: h.world.principal,
  to: VAULT,
  cumulativeGasUsed: '0x5208',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x1',
  contractAddress: null,
  logs: [],
  logsBloom: `0x${'00'.repeat(256)}`,
  status: '0x1',
  type: '0x2',
});

let h: Harness;
let server: Server;
let node: ReturnType<typeof fakeNode>;
/** Runs just before the node hands out a transaction's receipt. */
let beforeReceipt: () => Promise<void>;
/** No mandate of the test chain refers to a stored text, so every text here is a waiting one. */
const noTermsInUse = () => Promise.resolve(new Set<Hex>());

const asMandate = (mandate: FakeMandate): Mandate => ({
  id: mandate.id,
  agentId: mandate.agentId,
  executor: mandate.executor,
  approver: h.world.approver,
  validUntil: mandate.validUntil,
  revoked: mandate.revoked,
  perPaymentCap: mandate.perPaymentCap,
  dailyCap: mandate.dailyCap,
  hardCeiling: mandate.hardCeiling,
  approvalNonce: mandate.approvalNonce,
  termsHash: TERMS_HASH,
  payees: [...mandate.payees],
  spentToday: mandate.spentToday,
  active: !mandate.revoked && NOW <= mandate.validUntil,
});

beforeEach(async () => {
  // The test chain's clock stands at NOW. The page's clock is set to the same moment.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);

  h = await createHarness();
  beforeReceipt = () => Promise.resolve();
  chainState.mandates = () =>
    [h.world.spendMandate, h.world.mandate].filter((mandate) => mandate !== null).map(asMandate);
  chainState.facts = async () => {
    const info = await h.world.info();
    return {
      principal: info.principal,
      identityRegistry: info.identityRegistry,
      token: { address: info.token, symbol: info.tokenSymbol, decimals: info.tokenDecimals },
    };
  };

  server = createApp({
    gateway: h.gateway,
    chain: h.world,
    ledger: h.ledger,
    explorerTx: (hash) => `https://explorer.example/tx/${hash}`,
    explorerUrl: 'https://explorer.example',
    mandateTerms: new MandateTermsStore(join(h.dir, 'mandates'), noTermsInUse),
    verify: (file) => verifyEvidence(file, { chain: null, ledger: h.ledger.entries }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  node = fakeNode({
    // A wallet signs typed data with the key of the account that is asked. Only the approver's is here.
    eth_signTypedData_v4: ([address, typedData]) => {
      if ((address as string).toLowerCase() !== h.world.approver.toLowerCase()) {
        throw new Error('the test node holds no key for this account');
      }
      return h.world.approverAccount.signTypedData(
        JSON.parse(typedData as string) as Parameters<
          typeof h.world.approverAccount.signTypedData
        >[0],
      );
    },
    eth_sendTransaction: () => TX_HASH,
    eth_getTransactionReceipt: async () => {
      await beforeReceipt();
      return RECEIPT();
    },
    eth_getBlockByNumber: () => ({
      number: '0x3e8',
      hash: `0x${'cd'.repeat(32)}`,
      parentHash: `0x${'00'.repeat(32)}`,
      timestamp: numberToHex(NOW),
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      baseFeePerGas: '0x1',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      size: '0x0',
      nonce: '0x0000000000000000',
      transactions: [],
      uncles: [],
    }),
    eth_blockNumber: () => '0x3e9',
    eth_chainId: () => numberToHex(DOMAIN.chainId),
  });
  bridge({ gatewayUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, node });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await new Promise((resolve) => server.close(resolve));
  await h.cleanup();
});

/** The agent asks the gateway for a payment, as it does over HTTP. */
const ask = async (overrides: Parameters<typeof makeIntent>[0]) =>
  h.gateway.submit(
    await signIntent(
      h.world.agent,
      DOMAIN,
      makeIntent({ agentId: h.world.agentId.toString(), ...overrides }),
    ),
  );

/** Opens a screen with the given wallets on offer, and connects the first of them. */
async function open(hash: string, wallets: Address[] = []) {
  const config = testConfig(wallets);
  window.location.hash = hash;
  const view = show(<App />, config);
  const [first] = config.connectors;
  if (first !== undefined) {
    await act(async () => {
      await connect(config, { connector: first });
    });
  }
  return view;
}

/**
 * A button that sends or signs is offered once the console has compared what the gateway says about
 * the vault with the chain. That takes a moment after the page opens.
 */
async function ready(button: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  return button;
}

describe('live feed', () => {
  it('lists what the gateway decided, with the reasons and a link for each payment', async () => {
    const paid = await ask({ payee: h.world.vendorA });
    await ask({
      payee: h.world.vendorB,
      amount: (6n * USDC).toString(),
      purpose: 'Invoice NR-2026-0042: quarterly sector report',
    });
    await ask({
      payee: h.world.unlistedVendor,
      amount: (25n * USDC).toString(),
      purpose: 'Above the ceiling',
    });

    await open('#/feed');
    const list = await screen.findByRole('list', { name: 'Requests, newest first' });
    const rows = within(list)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement === list);
    expect(rows).toHaveLength(3);

    // Newest first: the refusal, the payment that waits, the payment that went through.
    const [refused, waiting, done] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(refused).getByText('Refused')).toBeInTheDocument();
    expect(within(refused).getByText('no transaction')).toBeInTheDocument();
    expect(within(refused).getAllByRole('listitem').length).toBeGreaterThan(0);

    expect(within(waiting).getByText('Needs approval')).toBeInTheDocument();
    expect(within(waiting).getByText('Nagikumo Research')).toBeInTheDocument();
    expect(within(waiting).getByText('6.00')).toBeInTheDocument();
    expect(within(waiting).getByText('900')).toBeInTheDocument();

    expect(within(done).getByText('Paid')).toBeInTheDocument();
    expect(within(done).getByText('Koishi Supply')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: /transaction/ })).toHaveAttribute(
      'href',
      `https://explorer.example/tx/${paid.transactionHash ?? ''}`,
    );
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Approvals/ })).toHaveTextContent('1 waiting');
    });
  });

  it('says so when the gateway cannot be reached', async () => {
    vi.unstubAllGlobals();
    bridge({});
    await open('#/feed');
    expect(await screen.findByRole('alert')).toHaveTextContent('The gateway cannot be reached');
  });
});

describe('approvals', () => {
  const waitingPayment = () =>
    ask({
      payee: h.world.vendorB,
      amount: (6n * USDC).toString(),
      purpose: 'Invoice NR-2026-0042: quarterly sector report',
      invoiceId: 'NR-2026-0042',
    });

  it('the approver signs one exact payment, and the gateway pays it through the vault', async () => {
    const asked = await waitingPayment();
    expect(asked.status).toBe('pending_approval');
    const user = userEvent.setup();
    await open('#/approvals', [h.world.approver]);

    const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
    expect(within(waiting).getByText('Nagikumo Research')).toBeInTheDocument();
    expect(
      within(waiting).getByText('Invoice NR-2026-0042: quarterly sector report'),
    ).toBeInTheDocument();
    // The message the wallet will show, field by field.
    expect(within(waiting).getAllByText(h.world.vendorB).length).toBeGreaterThan(0);
    expect(within(waiting).getByText(asked.evidenceHash)).toBeInTheDocument();
    expect(within(waiting).getByText('= in 10 min')).toBeInTheDocument();

    await user.click(within(waiting).getByRole('button', { name: /Sign approval/ }));

    const decided = await screen.findByRole('region', { name: 'Decided in this session' });
    expect(within(decided).getByText('Paid, approved')).toBeInTheDocument();
    expect(await screen.findByText('Nothing is waiting for approval')).toBeInTheDocument();
    // The button that was pressed is gone. The focus is on the result.
    expect(within(decided).getByRole('heading', { name: 'Decided in this session' })).toHaveFocus();

    // The wallet was asked for one signature, over exactly this payment.
    const [signing] = node.sent('eth_signTypedData_v4');
    expect(node.sent('eth_signTypedData_v4')).toHaveLength(1);
    const typed = JSON.parse(signing?.params[1] as string) as {
      primaryType: string;
      domain: { name: string; verifyingContract: string; chainId: number | string };
      message: Record<string, string>;
    };
    expect(typed.primaryType).toBe('PaymentApproval');
    expect(typed.domain.name).toBe('MandateVault');
    expect(typed.domain.verifyingContract.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(Number(typed.domain.chainId)).toBe(421_614);
    // A wallet gets addresses in lowercase and numbers as text.
    expect(typed.message).toMatchObject({
      mandateId: '1',
      payee: h.world.vendorB.toLowerCase(),
      amount: (6n * USDC).toString(),
      evidenceHash: asked.evidenceHash,
      nonce: '0',
      deadline: String(NOW + 600),
    });

    // The vault paid it as an approved payment, once.
    expect(h.world.payments).toHaveLength(1);
    expect(h.world.payments[0]).toMatchObject({
      payee: h.world.vendorB,
      amount: 6n * USDC,
      event: 'ApprovedPayment',
    });
    expect((await h.gateway.evidenceFor(asked.intentId))?.result.status).toBe('paid');
  });

  it('the approver declines with a signature, and nothing is paid', async () => {
    const asked = await waitingPayment();
    const user = userEvent.setup();
    await open('#/approvals', [h.world.approver]);

    const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
    await user.click(within(waiting).getByRole('button', { name: 'Decline' }));

    const decided = await screen.findByRole('region', { name: 'Decided in this session' });
    expect(within(decided).getByText('Declined')).toBeInTheDocument();
    expect(h.world.payments).toHaveLength(0);
    const file = await h.gateway.evidenceFor(asked.intentId);
    expect(file?.result).toMatchObject({ status: 'declined', approver: h.world.approver });
    const typed = JSON.parse(node.sent('eth_signTypedData_v4')[0]?.params[1] as string) as {
      primaryType: string;
    };
    expect(typed.primaryType).toBe('ApprovalDecline');
  });

  it('does not let a wallet that is not the approver sign', async () => {
    await waitingPayment();
    await open('#/approvals', [h.world.principal]);

    const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
    expect(within(waiting).getByRole('status')).toHaveTextContent(
      "The connected wallet is not this mandate's approver",
    );
    expect(within(waiting).getByRole('button', { name: /Sign approval/ })).toBeDisabled();
    expect(within(waiting).getByRole('button', { name: 'Decline' })).toBeDisabled();
  });

  it("asks to switch network when the approver's wallet is on another one", async () => {
    await waitingPayment();
    const view = await open('#/approvals', [h.world.approver]);
    const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
    await waitFor(() => {
      expect(within(waiting).getByRole('button', { name: /Sign approval/ })).toBeEnabled();
    });

    await act(async () => {
      await switchChain(view.config, { chainId: OTHER_CHAIN.id });
    });
    expect(within(waiting).getByRole('status')).toHaveTextContent(
      'The wallet is on another network',
    );
    expect(within(waiting).getByRole('button', { name: /Sign approval/ })).toBeDisabled();
    expect(within(waiting).getByRole('button', { name: 'Decline' })).toBeDisabled();
  });

  it('asks for the approver when no wallet is connected', async () => {
    await waitingPayment();
    await open('#/approvals');
    const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
    expect(within(waiting).getByRole('status')).toHaveTextContent(
      "Connect the approver's wallet to sign.",
    );
  });

  it('says what happened when the wallet does not sign', async () => {
    await waitingPayment();
    const user = userEvent.setup();
    // The connected wallet is the approver's address, but the node holds no key for it this time.
    node.calls.length = 0;
    const original = h.world.approverAccount.signTypedData;
    h.world.approverAccount.signTypedData = () =>
      Promise.reject(new Error('User rejected the request.'));
    try {
      await open('#/approvals', [h.world.approver]);
      const waiting = await screen.findByRole('region', { name: 'Waiting for your approval' });
      await user.click(within(waiting).getByRole('button', { name: /Sign approval/ }));
      expect(await within(waiting).findByRole('alert')).toHaveTextContent(
        'The wallet did not sign. Nothing was sent.',
      );
      expect(within(waiting).getByRole('button', { name: /Sign approval/ })).toBeEnabled();
      expect(h.world.payments).toHaveLength(0);
    } finally {
      h.world.approverAccount.signTypedData = original;
    }
  });
});

describe('evidence and ledger', () => {
  it("shows a record with its checks, its hash and the gateway's own verification", async () => {
    const paid = await ask({ payee: h.world.vendorA });
    await open(`#/evidence/${paid.intentId}`);

    expect(await screen.findByText(paid.evidenceHash)).toBeInTheDocument();
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /payment transaction/ })).toHaveAttribute(
      'href',
      `https://explorer.example/tx/${paid.transactionHash ?? ''}`,
    );
    const why = screen.getByRole('region', { name: 'Why' });
    expect(within(why).getAllByText('Passed').length).toBeGreaterThan(5);
  });

  it('shows the ledger newest first and says that its chain of hashes holds', async () => {
    await ask({ payee: h.world.vendorA });
    await open('#/ledger');

    expect(await screen.findByText('Chain intact')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Ledger entries, newest first' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(h.ledger.entries.length);
    expect(rows[0]).toHaveTextContent(String(h.ledger.entries.length));
    expect(rows[0]).toHaveTextContent('PAYMENT EXECUTED');
    expect(rows.at(-1)).toHaveTextContent('INTENT DECIDED');
  });
});

describe('mandates', () => {
  it("shows a mandate drawn to scale with today's spending and its payees by name", async () => {
    await ask({ payee: h.world.vendorA });
    await open('#/mandates');

    const mandate = await screen.findByRole('region', { name: 'Mandate 1' });
    expect(within(mandate).getByText('Active')).toBeInTheDocument();
    expect(within(mandate).getByRole('img')).toHaveAccessibleName(
      'Paid today 1.50 USDC. Per payment up to 2.00, per day up to 8.00, hard ceiling 20.00 with approvals included.',
    );
    expect(await within(mandate).findByText('Koishi Supply')).toBeInTheDocument();
    expect(within(mandate).getByText('Nagikumo Research')).toBeInTheDocument();
    // Only the principal may create or revoke.
    expect(screen.getByRole('button', { name: /New mandate/ })).toBeDisabled();
    expect(within(mandate).getByRole('button', { name: 'Revoke' })).toBeDisabled();
  });

  it('the principal creates a mandate: the text is stored, and its hash and the limits go to the vault', async () => {
    const user = userEvent.setup();
    await open('#/mandates', [h.world.principal]);
    await screen.findByRole('region', { name: 'Mandate 1' });

    await user.click(await ready(screen.getByRole('button', { name: /New mandate/ })));
    const dialog = await screen.findByRole('dialog', { name: 'New mandate' });
    const create = within(dialog).getByRole('button', { name: /Create mandate/ });
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Agent id (ERC-8004)'), '354');
    // The approver is taken from the newest mandate; vendors are ticked, the spend wallet and the
    // per-call merchant are not offered for this kind.
    expect(within(dialog).getByLabelText('Approver')).toHaveValue(h.world.approver);
    expect(within(dialog).queryByText('Tsukimi Data')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: /Hatsuka Research/ }));
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // The dialog is gone, and the focus is back on the button that opened it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New mandate/ })).toHaveFocus();
    });

    const [sent] = node.sent('eth_sendTransaction');
    const transaction = sent?.params[0] as { from: string; to: string; data: Hex };
    expect(transaction.from.toLowerCase()).toBe(h.world.principal.toLowerCase());
    expect(transaction.to.toLowerCase()).toBe(VAULT.toLowerCase());
    const call = decodeFunctionData({ abi: mandateVaultAbi, data: transaction.data });
    expect(call.functionName).toBe('createMandate');
    const [agentId, executor, approver, payees, perPayment, daily, ceiling, validUntil, termsHash] =
      call.args as [bigint, Address, Address, Address[], bigint, bigint, bigint, bigint, Hex];
    expect(agentId).toBe(354n);
    expect(executor).toBe(h.world.address);
    expect(approver).toBe(h.world.approver);
    expect(payees).toEqual([h.world.vendorA, h.world.vendorB]);
    expect([perPayment, daily, ceiling]).toEqual([2n * USDC, 8n * USDC, 20n * USDC]);
    expect(validUntil).toBe(BigInt(NOW + 30 * 86_400));

    // The gateway holds the text the principal approved, under the hash that went to the vault.
    const stored = await h.gateway
      .payees()
      .then(() => new MandateTermsStore(join(h.dir, 'mandates'), noTermsInUse).get(termsHash));
    expect(stored).not.toBeNull();
    expect(keccak256(stringToHex(stored ?? ''))).toBe(termsHash);
    expect(stored).toContain('AGENT PAYMENT MANDATE: VENDOR INVOICES');
    expect(stored).toContain(`  - Koishi Supply (${h.world.vendorA})`);
    expect(stored).toContain(`  - Nagikumo Research (${h.world.vendorB})`);
    expect(stored).not.toContain('Hatsuka Research');
    expect(stored).toContain('up to 2 USDC per payment and 8 USDC per UTC day.');
    expect(stored).toContain(`Approver: ${h.world.approver}`);
  });

  it('stores the text once more when the mandate exists, in case it was pushed out meanwhile', async () => {
    // Before the mandate exists its text only waits at the gateway, and the gateway makes room among
    // waiting texts when too many arrive. Here every stored text is gone by the time the transaction is
    // confirmed, as if 2000 others had arrived in between.
    let pushedOut = false;
    beforeReceipt = async () => {
      if (pushedOut) return;
      pushedOut = true;
      await rm(join(h.dir, 'mandates'), { recursive: true, force: true });
    };
    const user = userEvent.setup();
    await open('#/mandates', [h.world.principal]);
    await screen.findByRole('region', { name: 'Mandate 1' });
    await user.click(await ready(screen.getByRole('button', { name: /New mandate/ })));
    const dialog = await screen.findByRole('dialog', { name: 'New mandate' });
    await user.type(within(dialog).getByLabelText('Agent id (ERC-8004)'), '354');
    await user.click(within(dialog).getByRole('button', { name: /Create mandate/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(pushedOut).toBe(true);

    const [sent] = node.sent('eth_sendTransaction');
    const { data } = sent?.params[0] as { data: Hex };
    const termsHash = decodeFunctionData({ abi: mandateVaultAbi, data }).args?.[8] as Hex;
    const stored = await new MandateTermsStore(join(h.dir, 'mandates'), noTermsInUse).get(
      termsHash,
    );
    expect(keccak256(stringToHex(stored ?? ''))).toBe(termsHash);
  });

  it('checks the form before anything is sent', async () => {
    const user = userEvent.setup();
    await open('#/mandates', [h.world.principal]);
    await screen.findByRole('region', { name: 'Mandate 1' });
    await user.click(await ready(screen.getByRole('button', { name: /New mandate/ })));
    const dialog = await screen.findByRole('dialog', { name: 'New mandate' });
    const says = (text: string | RegExp) => {
      expect(within(dialog).getByRole('status')).toHaveTextContent(text);
      expect(within(dialog).getByRole('button', { name: /Create mandate/ })).toBeDisabled();
    };

    says("Enter the agent's id in the ERC-8004 Identity Registry.");
    await user.type(within(dialog).getByLabelText('Agent id (ERC-8004)'), '354');

    const perPayment = within(dialog).getByLabelText('Per payment, USDC');
    await user.clear(perPayment);
    await user.type(perPayment, '9');
    says('The limits must rise');
    await user.clear(perPayment);
    await user.type(perPayment, '1e3');
    says('Enter the three limits as amounts');
    await user.clear(perPayment);
    await user.type(perPayment, '0.50');

    const approver = within(dialog).getByLabelText('Approver');
    await user.clear(approver);
    await user.type(approver, h.world.address);
    says('The approver must not be the gateway itself.');

    expect(node.sent('eth_sendTransaction')).toHaveLength(0);
  });

  it('the principal revokes a mandate after saying yes twice', async () => {
    const user = userEvent.setup();
    await open('#/mandates', [h.world.principal]);
    const mandate = await screen.findByRole('region', { name: 'Mandate 1' });

    await user.click(await ready(within(mandate).getByRole('button', { name: 'Revoke' })));
    expect(node.sent('eth_sendTransaction')).toHaveLength(0);
    expect(
      within(mandate).getByText('Revoking takes effect at once and cannot be undone.'),
    ).toBeInTheDocument();
    await user.click(within(mandate).getByRole('button', { name: 'Yes, revoke mandate 1' }));

    await waitFor(() => {
      expect(node.sent('eth_sendTransaction')).toHaveLength(1);
    });
    const transaction = node.sent('eth_sendTransaction')[0]?.params[0] as { to: string; data: Hex };
    expect(transaction.to.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(decodeFunctionData({ abi: mandateVaultAbi, data: transaction.data })).toMatchObject({
      functionName: 'revokeMandate',
      args: [1n],
    });
  });

  it('keeps the mandate when the principal changes their mind', async () => {
    const user = userEvent.setup();
    await open('#/mandates', [h.world.principal]);
    const mandate = await screen.findByRole('region', { name: 'Mandate 1' });
    await user.click(await ready(within(mandate).getByRole('button', { name: 'Revoke' })));
    // The question appears with the focus on the safe answer.
    expect(within(mandate).getByRole('button', { name: 'Keep it' })).toHaveFocus();
    await user.click(within(mandate).getByRole('button', { name: 'Keep it' }));
    expect(within(mandate).getByRole('button', { name: 'Revoke' })).toBeEnabled();
    expect(within(mandate).getByRole('button', { name: 'Revoke' })).toHaveFocus();
    expect(node.sent('eth_sendTransaction')).toHaveLength(0);
  });
});
