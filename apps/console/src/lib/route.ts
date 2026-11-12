import { useSyncExternalStore } from 'react';

/** Which screen is shown. The address bar carries it after the #, so a screen can be linked to. */

export const SCREENS = ['feed', 'approvals', 'mandates', 'evidence', 'ledger'] as const;
export type Screen = (typeof SCREENS)[number];
export type Route = { screen: Screen; param: string | null };

export function parseRoute(hash: string): Route {
  const [name = '', param = ''] = hash.replace(/^#\/?/, '').split('/');
  const screen = (SCREENS as readonly string[]).includes(name) ? (name as Screen) : 'feed';
  return { screen, param: param === '' ? null : decodeURIComponent(param) };
}

export const href = (screen: Screen, param?: string) =>
  `#/${screen}${param === undefined ? '' : `/${encodeURIComponent(param)}`}`;

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  );
  return parseRoute(hash);
}
