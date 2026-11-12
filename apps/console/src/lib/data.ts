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
import { type Mandate, readMandates } from './vault';

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
  const config = useGatewayConfig();
  const vault = config.data?.vault;
  return useQuery({
    queryKey: ['mandates', mode, vault],
    enabled: mode !== 'live' || (vault !== undefined && client !== undefined),
    queryFn: async () => {
      if (mode !== 'live') return (await madeUp(mode)).mandates();
      if (vault === undefined || client === undefined) return [];
      return readMandates(client, vault);
    },
    refetchInterval: every(mode, 5000),
  });
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
