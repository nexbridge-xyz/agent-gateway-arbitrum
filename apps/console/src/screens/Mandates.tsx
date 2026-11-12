import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { type Address, BaseError, getAddress, isAddress, parseUnits } from 'viem';
import { usePublicClient, useWriteContract } from 'wagmi';

import { mandateVaultAbi } from '@agent-gateway/contracts/abi';
import { mandateTerms, mandateTermsHash } from '@agent-gateway/gateway/protocol';

import { LimitRail } from '@/components/LimitRail';
import { Field, HashValue, Mark, Note, ScreenHead } from '@/components/parts';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRole } from '@/components/WalletCell';
import { type GatewayConfig, api } from '@/lib/api';
import {
  useDataMode,
  useGatewayConfig,
  useMandates,
  useNames,
  useNow,
  usePayees,
  useTerms,
} from '@/lib/data';
import { day, short, until } from '@/lib/format';
import { type Mandate, stateOf } from '@/lib/vault';
import { cn } from '@/lib/utils';

/** Names used in the text of a new mandate. They are the demo's fictional company and agent. */
const DEMO = { principal: 'Kirenami Trading', agent: 'Kirenami research and procurement agent' };

const explain = (error: unknown) =>
  error instanceof BaseError
    ? error.shortMessage
    : error instanceof Error
      ? (error.message.split('\n')[0] ?? 'Something went wrong')
      : 'Something went wrong';

/** What each agent may do on its own, drawn to scale, with today's spending. Read from the vault. */
export function Mandates() {
  const mandates = useMandates();
  const config = useGatewayConfig();
  const role = useRole();
  const mode = useDataMode();
  const [creating, setCreating] = useState(false);
  const list = mandates.data ?? [];

  const cannot =
    mode !== 'live'
      ? 'This is made-up data. Creating and revoking are switched off.'
      : !role.principal
        ? `Connect the principal's wallet${config.data ? `, ${short(config.data.principal)},` : ''} to create or revoke a mandate.`
        : null;

  return (
    <div className="sheet content-start">
      <ScreenHead
        title="Mandates"
        about="A mandate says whom an agent may pay, how much per payment and per day, and until when. The vault on Arbitrum holds these limits and enforces them on every payment, whatever the gateway does."
        action={
          <button
            type="button"
            className="action-cell h-full min-w-48"
            disabled={cannot !== null || config.data === undefined}
            onClick={() => {
              setCreating(true);
            }}
          >
            <span>New mandate</span>
            <Plus aria-hidden className="size-4" />
          </button>
        }
      />
      {cannot !== null ? (
        <p className="cell text-text-2 py-2.5 text-xs" role="status">
          {cannot}
        </p>
      ) : null}

      {mandates.isError ? (
        <Note tone="stop" title="The mandates could not be read from the vault">
          {mandates.error.message.split('\n')[0]}
        </Note>
      ) : mandates.isPending ? (
        <Note title="Reading the vault…" />
      ) : list.length === 0 ? (
        <Note title="This vault has no mandates yet">
          Without a mandate an agent can ask, and every request is refused. Create one to let an
          agent pay within limits.
        </Note>
      ) : (
        list.map((mandate) => (
          <MandateBlock
            key={mandate.id.toString()}
            mandate={mandate}
            config={config.data}
            cannot={cannot}
          />
        ))
      )}

      {config.data && creating ? (
        <CreateMandate
          config={config.data}
          approver={list[0]?.approver ?? null}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
    </div>
  );
}

function MandateBlock({
  mandate,
  config,
  cannot,
}: {
  mandate: Mandate;
  config: GatewayConfig | undefined;
  cannot: string | null;
}) {
  const names = useNames();
  const now = useNow();
  const client = usePublicClient();
  const write = useWriteContract();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const terms = useTerms(showTerms ? mandate.termsHash : null);

  const state = stateOf(mandate);
  const decimals = config?.token.decimals ?? 6;
  const symbol = config?.token.symbol ?? 'USDC';
  const explorer = config?.explorerUrl ?? null;

  const revoke = async () => {
    if (config === undefined || client === undefined) return;
    setProblem(null);
    setBusy(true);
    try {
      const hash = await write.mutateAsync({
        address: config.vault,
        abi: mandateVaultAbi,
        functionName: 'revokeMandate',
        args: [mandate.id],
      });
      await client.waitForTransactionReceipt({ hash });
      await queryClient.invalidateQueries({ queryKey: ['mandates'] });
      setConfirming(false);
    } catch (error) {
      setProblem(explain(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="sheet grid-cols-1 xl:grid-cols-[17rem_minmax(0,1fr)_13rem]"
      aria-label={`Mandate ${mandate.id}`}
    >
      <div className="cell space-y-3 py-5">
        <div className="flex items-center gap-3">
          <h2 className="text-xl">
            Mandate <span className="num">{mandate.id.toString()}</span>
          </h2>
          {state === 'active' ? (
            <Mark tone="ok">Active</Mark>
          ) : state === 'revoked' ? (
            <Mark tone="stop">Revoked</Mark>
          ) : (
            <Mark tone="plain">Expired</Mark>
          )}
        </div>
        <Field label="Agent (ERC-8004)">
          <span className="num text-sm break-all">{mandate.agentId.toString()}</span>
        </Field>
        <Field label={state === 'expired' ? 'Was valid until' : 'Valid until'}>
          <span className="text-sm">{day(mandate.validUntil)}</span>
          {state === 'active' ? (
            <span className="text-text-3 ml-2 text-xs">{until(mandate.validUntil, now)}</span>
          ) : null}
        </Field>
        <Field label="Approver">
          <HashValue
            value={mandate.approver}
            href={explorer ? `${explorer}/address/${mandate.approver}` : null}
            lead={6}
            tail={4}
            label="approver address"
          />
        </Field>
      </div>

      <div className="sheet content-start">
        <div className="cell py-5">
          <LimitRail
            perPaymentCap={mandate.perPaymentCap}
            dailyCap={mandate.dailyCap}
            hardCeiling={mandate.hardCeiling}
            spentToday={mandate.spentToday}
            decimals={decimals}
            symbol={symbol}
            inactive={state !== 'active'}
          />
        </div>
        <div className="cell">
          <div className="label mb-2">
            May be paid without asking ({mandate.payees.length}{' '}
            {mandate.payees.length === 1 ? 'payee' : 'payees'})
          </div>
          {mandate.payees.length === 0 ? (
            <p className="text-text-2 text-sm">
              Nobody. Every payment under this mandate needs the approver.
            </p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-1.5 p-0 md:grid-cols-2">
              {mandate.payees.map((payee) => (
                <li key={payee} className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 truncate text-sm">
                    {names(payee) ?? 'Not in the vendor registry'}
                  </span>
                  <span className="num text-text-3 shrink-0 text-xs">{short(payee)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="cell">
          <button
            type="button"
            className="label hover:text-foreground cursor-pointer border-0 bg-transparent p-0"
            aria-expanded={showTerms}
            onClick={() => {
              setShowTerms((shown) => !shown);
            }}
          >
            <span aria-hidden className="text-ice mr-2">
              {showTerms ? '−' : '+'}
            </span>
            {showTerms ? 'Hide' : 'Read'} the text the principal approved
          </button>
          {showTerms ? (
            <div className="mt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="label">Terms hash, stored in the vault</span>
                <HashValue value={mandate.termsHash} label="terms hash" />
              </div>
              {terms.isPending ? (
                <p className="text-text-3 text-sm">Reading…</p>
              ) : terms.isError ? (
                <p className="text-stop text-sm">The text could not be read.</p>
              ) : terms.data === null || terms.data === undefined ? (
                <p className="text-text-2 text-sm">
                  The gateway holds no text that hashes to this value.
                </p>
              ) : (
                <pre className="num text-text-2 m-0 max-h-80 overflow-auto text-xs leading-relaxed break-words whitespace-pre-wrap">
                  {terms.data}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col justify-start">
        {state !== 'active' ? (
          <p className="cell text-text-3 text-xs">
            {state === 'revoked'
              ? 'Revoked. It cannot pay again.'
              : 'Expired. It cannot pay again.'}
          </p>
        ) : confirming ? (
          <>
            <button
              type="button"
              data-tone="stop"
              className="quiet-action text-stop w-full"
              disabled={busy}
              onClick={() => {
                void revoke();
              }}
            >
              {busy ? 'Revoking…' : `Yes, revoke mandate ${mandate.id}`}
            </button>
            <button
              type="button"
              className="quiet-action w-full border-t"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </button>
            <p className="text-text-3 border-t px-5 py-3 text-xs">
              Revoking takes effect at once and cannot be undone.
            </p>
          </>
        ) : (
          <button
            type="button"
            data-tone="stop"
            className="quiet-action w-full"
            disabled={cannot !== null}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Revoke
          </button>
        )}
        {problem !== null ? (
          <p className="text-stop border-t px-5 py-3 text-xs" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </section>
  );
}

type Kind = 'vendors' | 'spend';
const PRESETS: Record<
  Kind,
  {
    title: string;
    perPayment: string;
    daily: string;
    ceiling: string;
    intro: string;
    notes: string[];
  }
> = {
  vendors: {
    title: 'VENDOR INVOICES',
    perPayment: '2',
    daily: '8',
    ceiling: '20',
    intro: 'The agent may pay these payees without asking:',
    notes: ["Any other payment needs the approver's signature."],
  },
  spend: {
    title: 'PER-CALL PURCHASES',
    perPayment: '0.5',
    daily: '1',
    ceiling: '1',
    intro: 'The gateway may fund this wallet without asking:',
    notes: [
      'The spend wallet pays for single API calls. It is funded one call at a time, with exactly the price of that call.',
    ],
  },
};

function CreateMandate({
  config,
  approver,
  onClose,
}: {
  config: GatewayConfig;
  approver: Address | null;
  onClose: () => void;
}) {
  const payees = usePayees();
  const client = usePublicClient();
  const write = useWriteContract();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<Kind>('vendors');
  const [agentId, setAgentId] = useState('');
  const [approverText, setApproverText] = useState<string>(approver ?? '');
  const [caps, setCaps] = useState({ perPayment: '2', daily: '8', ceiling: '20' });
  const [days, setDays] = useState('30');
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<'store' | 'sign' | 'wait' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The registry, with the spend wallet first known to the gateway. A merchant is paid through the
  // spend wallet, so it is not offered as a payee.
  const options = useMemo(() => {
    const spend = config.spendWallet?.toLowerCase();
    return (payees.data?.vendors ?? []).filter(
      (vendor) => vendor.origin === undefined || vendor.address.toLowerCase() === spend,
    );
  }, [payees.data, config.spendWallet]);
  const preset = (which: Kind) =>
    new Set(
      options
        .filter(
          (vendor) =>
            (vendor.address.toLowerCase() === config.spendWallet?.toLowerCase()) ===
            (which === 'spend'),
        )
        .map((vendor) => vendor.address),
    );
  const selected = chosen ?? preset(kind);

  const amount = (text: string) =>
    /^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(text.trim())
      ? parseUnits(text.trim(), config.token.decimals)
      : null;
  const perPayment = amount(caps.perPayment);
  const daily = amount(caps.daily);
  const ceiling = amount(caps.ceiling);
  const validDays = /^[0-9]{1,3}$/.test(days) ? Number(days) : 0;
  const invalid = !/^[0-9]{1,30}$/.test(agentId.trim())
    ? "Enter the agent's id in the ERC-8004 Identity Registry."
    : !isAddress(approverText.trim())
      ? "Enter the approver's address."
      : getAddress(approverText.trim()) === config.executor
        ? 'The approver must not be the gateway itself.'
        : perPayment === null || daily === null || ceiling === null
          ? 'Enter the three limits as amounts, such as 2 or 0.50.'
          : ceiling === 0n || perPayment > daily || daily > ceiling
            ? 'The limits must rise: per payment, then per day, then the ceiling, which cannot be zero.'
            : validDays < 1 || validDays > 365
              ? 'Enter how many days the mandate is valid: 1 to 365.'
              : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      invalid !== null ||
      client === undefined ||
      perPayment === null ||
      daily === null ||
      ceiling === null
    )
      return;
    setProblem(null);
    try {
      const block = await client.getBlock({ blockTag: 'latest' });
      const validUntil = block.timestamp + BigInt(validDays * 86_400);
      const text = mandateTerms({
        title: PRESETS[kind].title,
        principal: { name: DEMO.principal, address: config.principal },
        agent: {
          name: DEMO.agent,
          id: BigInt(agentId.trim()),
          identityRegistry: config.identityRegistry,
        },
        executor: config.executor,
        approver: getAddress(approverText.trim()),
        payeesIntro: PRESETS[kind].intro,
        payees: options
          .filter((vendor) => selected.has(vendor.address))
          .map(({ name, address }) => ({ name, address })),
        caps: {
          perPayment: caps.perPayment.trim(),
          daily: caps.daily.trim(),
          hardCeiling: caps.ceiling.trim(),
        },
        notes: PRESETS[kind].notes,
        validUntil,
        vault: config.vault,
        chainId: config.chainId,
        token: { symbol: config.token.symbol, address: config.token.address },
      });
      const termsHash = mandateTermsHash(text);

      // The text is stored first, under its own hash, so it is there the moment the mandate exists.
      setBusy('store');
      await api.storeTerms(termsHash, text);
      setBusy('sign');
      const hash = await write.mutateAsync({
        address: config.vault,
        abi: mandateVaultAbi,
        functionName: 'createMandate',
        args: [
          BigInt(agentId.trim()),
          config.executor,
          getAddress(approverText.trim()),
          options.filter((vendor) => selected.has(vendor.address)).map((vendor) => vendor.address),
          perPayment,
          daily,
          ceiling,
          validUntil,
          termsHash,
        ],
      });
      setBusy('wait');
      await client.waitForTransactionReceipt({ hash });
      await queryClient.invalidateQueries({ queryKey: ['mandates'] });
      onClose();
    } catch (error) {
      setProblem(explain(error));
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busy === null) onClose();
      }}
    >
      <DialogContent className="bg-background max-h-[92vh] gap-0 overflow-y-auto rounded-none p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5 text-left">
          <DialogTitle className="text-xl tracking-tight">New mandate</DialogTitle>
          <DialogDescription className="text-text-2">
            The limits go into the vault and cannot be changed afterwards. To change them, revoke
            the mandate and create a new one.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <fieldset className="grid grid-cols-2 border-b" disabled={busy !== null}>
            <legend className="sr-only">What the mandate is for</legend>
            {(['vendors', 'spend'] as const).map((which) => (
              <button
                key={which}
                type="button"
                aria-pressed={kind === which}
                onClick={() => {
                  setKind(which);
                  setChosen(null);
                  setCaps({
                    perPayment: PRESETS[which].perPayment,
                    daily: PRESETS[which].daily,
                    ceiling: PRESETS[which].ceiling,
                  });
                }}
                className={cn(
                  'h-12 cursor-pointer border-0 px-6 text-left text-sm transition-colors duration-[120ms]',
                  which === 'spend' && 'border-l',
                  kind === which
                    ? 'bg-surface-2 text-foreground font-medium'
                    : 'text-text-2 hover:text-foreground bg-transparent',
                )}
              >
                {which === 'vendors' ? 'Vendor invoices' : 'Spend wallet, for per-call purchases'}
              </button>
            ))}
          </fieldset>

          <div className="grid grid-cols-1 gap-5 px-6 py-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent" className="label">
                Agent id (ERC-8004)
              </Label>
              <Input
                id="agent"
                inputMode="numeric"
                className="num rounded-none"
                value={agentId}
                placeholder="354"
                onChange={(event) => {
                  setAgentId(event.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="approver" className="label">
                Approver
              </Label>
              <Input
                id="approver"
                className="num rounded-none text-xs"
                value={approverText}
                placeholder="0x…"
                spellCheck={false}
                onChange={(event) => {
                  setApproverText(event.target.value);
                }}
              />
            </div>
            {(
              [
                ['perPayment', 'Per payment'],
                ['daily', 'Per UTC day'],
                ['ceiling', 'Hard ceiling per day'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={key} className="label">
                  {label}, {config.token.symbol}
                </Label>
                <Input
                  id={key}
                  inputMode="decimal"
                  className="num rounded-none"
                  value={caps[key]}
                  onChange={(event) => {
                    setCaps((current) => ({ ...current, [key]: event.target.value }));
                  }}
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="days" className="label">
                Valid for, days
              </Label>
              <Input
                id="days"
                inputMode="numeric"
                className="num rounded-none"
                value={days}
                onChange={(event) => {
                  setDays(event.target.value);
                }}
              />
            </div>
          </div>

          <fieldset className="border-t px-6 py-5" disabled={busy !== null}>
            <legend className="label float-left mb-3 w-full">May be paid without asking</legend>
            {options.length === 0 ? (
              <p className="text-text-2 clear-both text-sm">
                The vendor registry is empty, so the mandate will list nobody. Every payment will
                need the approver.
              </p>
            ) : (
              <ul className="clear-both m-0 list-none space-y-2.5 p-0">
                {options.map((vendor) => (
                  <li key={vendor.address} className="flex items-start gap-3">
                    <Checkbox
                      id={`payee-${vendor.address}`}
                      className="data-[state=checked]:border-ice data-[state=checked]:bg-ice data-[state=checked]:text-ink mt-0.5 rounded-none"
                      checked={selected.has(vendor.address)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected);
                        if (checked === true) next.add(vendor.address);
                        else next.delete(vendor.address);
                        setChosen(next);
                      }}
                    />
                    <Label
                      htmlFor={`payee-${vendor.address}`}
                      className="flex min-w-0 flex-col items-start gap-0.5 font-normal"
                    >
                      <span className="text-sm break-words">{vendor.name}</span>
                      <span className="num text-text-3 text-xs break-all">{vendor.address}</span>
                    </Label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-stretch border-t">
            <p
              className={cn('px-6 py-4 text-xs', problem !== null ? 'text-stop' : 'text-text-2')}
              role={problem !== null ? 'alert' : 'status'}
            >
              {problem ??
                invalid ??
                (busy === 'store'
                  ? 'Storing the mandate text…'
                  : busy === 'sign'
                    ? 'Confirm the transaction in your wallet…'
                    : busy === 'wait'
                      ? 'Waiting for Arbitrum to confirm…'
                      : 'Your wallet will ask you to confirm one transaction to the vault.')}
            </p>
            <button
              type="submit"
              className="action-cell min-w-52"
              disabled={invalid !== null || busy !== null}
            >
              <span>Create mandate</span>
              <ArrowRight aria-hidden className="size-4" />
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
