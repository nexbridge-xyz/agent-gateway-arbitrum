import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Hex } from 'viem';
import { usePublicClient } from 'wagmi';

import {
  type EvidenceFile,
  type GatewayConfig,
  type IntentSummary,
  type Ledger,
  type Payees,
  type PendingApproval,
  type Verification,
  api,
} from './api';
import { MADE_UP_NOW } from './clock';
import { VAULT, type Mandate, type VaultFacts, readMandates, readVaultFacts } from './vault';
import { chain } from './wallet';

/**
 * Where the screens get their data: the gateway and the chain, or one of the made-up sets for looking
 * at the screens under strain ("worst case"), with exactly one of everything ("one") and with nothing
 * in them ("empty").
 *
 * The made-up sets are a tool for building the console. They exist in a development build only: a
 * production build always shows the gateway and the chain, and never loads the made-up data.
 */

export const DATA_MODES = ['live', 'worst', 'one', 'empty'] as const;
export type DataMode = (typeof DATA_MODES)[number];
type MadeUp = Exclude<DataMode, 'live'>;

/** Whether the made-up sets can be chosen at all. */
export const MADE_UP_DATA = import.meta.env.DEV;

const KEY = 'agent-gateway-console:data';
const listeners = new Set<() => void>();
const isMode = (value: unknown): value is DataMode =>
  (DATA_MODES as readonly unknown[]).includes(value);

function currentMode(): DataMode {
  if (!MADE_UP_DATA) return 'live';
  const fromUrl = new URLSearchParams(window.location.search).get('data');
  if (isMode(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(KEY);
    return isMode(stored) ? stored : 'live';
  } catch {
    return 'live';
  }
}

export function setDataMode(mode: DataMode): void {
  if (!MADE_UP_DATA) return;
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    // Storage can be blocked. The mode then lasts until the page is reloaded.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete('data');
  window.history.replaceState(null, '', url);
  memory = mode;
  for (const listener of listeners) listener();
}

let memory: DataMode | null = null;

export function useDataMode(): DataMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (memory ??= currentMode()),
    () => 'live' as const,
  );
}

/** The current time in whole seconds. In the made-up sets it stands still, so the screens do too. */
export function useNow(): number {
  const mode = useDataMode();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (mode !== 'live') return undefined;
    const timer = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [mode]);
  return mode === 'live' ? now : Math.floor(MADE_UP_NOW / 1000);
}

const every = (mode: DataMode, milliseconds: number) => (mode === 'live' ? milliseconds : false);
const EMPTY_HEAD: Hex = `0x${'0'.repeat(64)}`;

/** The made-up data, fetched only when one of its sets is chosen. */
const sampleData = async () => (await import('./sample')).sample;

/** What a made-up set shows where the live console shows lists. */
async function madeUp(mode: MadeUp) {
  if (mode === 'empty') {
    return {
      intents: (): IntentSummary[] => [],
      approvals: (): PendingApproval[] => [],
      mandates: (): Mandate[] => [],
      payees: (): Payees => ({ vendors: [], denylist: [] }),
      ledger: (): Ledger => ({
        check: { ok: true, count: 0, head: EMPTY_HEAD },
        head: EMPTY_HEAD,
        entries: [],
      }),
    };
  }
  const sample = await sampleData();
  return mode === 'one' ? sample.one : sample;
}

export function useGatewayConfig(): UseQueryResult<GatewayConfig> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['config', mode],
    queryFn: async () => (mode === 'live' ? api.config() : (await sampleData()).config()),
    staleTime: 60_000,
  });
}

export function useIntents(): UseQueryResult<IntentSummary[]> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['intents', mode],
    queryFn: async () =>
      mode === 'live' ? (await api.intents()).intents : (await madeUp(mode)).intents(),
    refetchInterval: every(mode, 2000),
  });
}

export function useApprovals(): UseQueryResult<PendingApproval[]> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['approvals', mode],
    queryFn: async () =>
      mode === 'live' ? (await api.approvals()).approvals : (await madeUp(mode)).approvals(),
    refetchInterval: every(mode, 2000),
  });
}

export function useLedger(): UseQueryResult<Ledger> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['ledger', mode],
    queryFn: async () => (mode === 'live' ? api.ledger() : (await madeUp(mode)).ledger()),
    refetchInterval: every(mode, 4000),
  });
}

export function usePayees(): UseQueryResult<Payees> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['payees', mode],
    queryFn: async () => (mode === 'live' ? api.payees() : (await madeUp(mode)).payees()),
    staleTime: 10_000,
  });
}

export function useMandates(): UseQueryResult<Mandate[]> {
  const mode = useDataMode();
  const client = usePublicClient();
  return useQuery({
    queryKey: ['mandates', mode, VAULT],
    enabled: mode !== 'live' || client !== undefined,
    queryFn: async () => {
      if (mode !== 'live') return (await madeUp(mode)).mandates();
      if (client === undefined) return [];
      // The console's own vault, whatever the gateway says its vault is.
      return readMandates(client, VAULT);
    },
    refetchInterval: every(mode, 5000),
  });
}

/** What the console's vault and its token say of themselves, read from the chain. */
export function useVaultFacts(): UseQueryResult<VaultFacts | null> {
  const mode = useDataMode();
  const client = usePublicClient();
  return useQuery({
    queryKey: ['vault-facts', mode, VAULT],
    enabled: mode === 'live' && client !== undefined,
    queryFn: async () =>
      mode === 'live' && client !== undefined ? readVaultFacts(client, VAULT) : null,
    staleTime: 60_000,
  });
}

/**
 * What stands between the console and the gateway it is talking to, in words for the person at the
 * screen, or null when the two agree.
 *
 * The gateway describes its vault in /v1/config, and the console builds what it asks a wallet for from
 * that description: where a transaction goes, how many decimals an amount has. A gateway that somebody
 * else controls can describe another contract, or another token. So every part of the description is
 * compared with the console's own vault address and with the chain, and while they differ the console
 * sends nothing and asks for no signature.
 */
export function useGatewayProblem(): string | null {
  const mode = useDataMode();
  const config = useGatewayConfig();
  const facts = useVaultFacts();
  if (mode !== 'live' || config.data === undefined) return null;

  const said = config.data;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(said.vault, VAULT) || said.chainId !== chain.id) {
    return (
      `The gateway serves vault ${said.vault} on chain ${said.chainId}. That is not the vault this console was started for, ` +
      `${VAULT} on chain ${chain.id}. Nothing is sent or signed until they agree. If the gateway's vault is yours, ` +
      `start the console with MANDATE_VAULT_ADDRESS=${said.vault}.`
    );
  }
  if (facts.isError) {
    return 'The vault could not be read from the chain, so what the gateway says about it cannot be checked. Nothing is sent or signed.';
  }
  if (facts.data === undefined || facts.data === null) {
    return 'Checking what the gateway says about the vault against the chain…';
  }

  const real = facts.data;
  const differs = [
    same(said.principal, real.principal) ? null : 'the principal',
    same(said.identityRegistry, real.identityRegistry) ? null : 'the identity registry',
    same(said.token.address, real.token.address) ? null : 'the token',
    said.token.decimals === real.token.decimals ? null : "the token's decimals",
    said.token.symbol === real.token.symbol ? null : "the token's symbol",
  ].filter((part) => part !== null);
  return differs.length === 0
    ? null
    : `What the gateway says about the vault does not match the vault on the chain: ${differs.join(', ')}. Nothing is sent or signed until they agree.`;
}

export function useEvidence(intentId: Hex | null): UseQueryResult<EvidenceFile | null> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['evidence', mode, intentId],
    enabled: intentId !== null,
    queryFn: async () => {
      if (intentId === null) return null;
      return mode === 'live' ? api.evidence(intentId) : (await sampleData()).evidence(intentId);
    },
    refetchInterval: every(mode, 4000),
  });
}

export function useVerification(intentId: Hex | null): UseQueryResult<Verification | null> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['verification', mode, intentId],
    enabled: intentId !== null,
    queryFn: async () => {
      if (intentId === null) return null;
      return mode === 'live'
        ? api.verification(intentId)
        : (await sampleData()).verification(intentId);
    },
    refetchInterval: every(mode, 8000),
  });
}

export function useTerms(termsHash: Hex | null): UseQueryResult<string | null> {
  const mode = useDataMode();
  return useQuery({
    queryKey: ['terms', mode, termsHash],
    enabled: termsHash !== null,
    queryFn: async () => {
      if (termsHash === null) return null;
      return mode === 'live' ? api.terms(termsHash) : (await sampleData()).terms(termsHash);
    },
    staleTime: 60_000,
  });
}

/** The name the principal gave an address, if it is in the vendor registry. */
export function useNames(): (address: string) => string | null {
  const payees = usePayees();
  const config = useGatewayConfig();
  return (address) => {
    const lower = address.toLowerCase();
    const vendor = payees.data?.vendors.find((item) => item.address.toLowerCase() === lower);
    if (vendor !== undefined) return vendor.name;
    if (config.data?.spendWallet?.toLowerCase() === lower) return 'Gateway spend wallet';
    return null;
  };
}
