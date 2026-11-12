import { ChevronDown } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useGatewayConfig, useMandates } from '@/lib/data';
import { short } from '@/lib/format';
import { chain } from '@/lib/wallet';

/** What the connected wallet can do here: it is the vault's principal, a mandate's approver, or neither. */
export function useRole(): {
  address: string | null;
  principal: boolean;
  approver: boolean;
  /** Connected, but to another network than the vault's. */
  wrongNetwork: boolean;
} {
  const { address, chainId } = useConnection();
  const config = useGatewayConfig();
  const mandates = useMandates();
  const lower = address?.toLowerCase() ?? null;
  return {
    address: address ?? null,
    principal: lower !== null && config.data?.principal.toLowerCase() === lower,
    approver:
      lower !== null &&
      (mandates.data ?? []).some((mandate) => mandate.approver.toLowerCase() === lower),
    wrongNetwork: lower !== null && chainId !== undefined && chainId !== chain.id,
  };
}

/** What a screen says when the wallet has to change network before it can sign or send. */
export const WRONG_NETWORK =
  'The wallet is on another network. Switch it to Arbitrum Sepolia in the wallet menu at the top right.';

/** The menu opens from its trigger in 200 ms on the brand's curve, as the brand's motion rules say. */
const MENU = 'min-w-64 rounded-none duration-200 ease-(--ease-brand)';

/**
 * The wallets to offer, each once. A browser wallet that announces itself (EIP-6963) is listed by its
 * name. "Browser wallet" is the entry for one that does not; next to an announced wallet it would be a
 * second way to the same wallet, so it is left out then.
 */
export function offered<T extends { id: string; type: string }>(connectors: readonly T[]): T[] {
  const announced = connectors.some(
    (connector) => connector.type === 'injected' && connector.id !== 'injected',
  );
  return connectors.filter((connector) => !(announced && connector.id === 'injected'));
}

/** The wallet's place in the top strip: connect, see who is connected and as what, disconnect. */
export function WalletCell() {
  const { address, chainId, isConnected } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const role = useRole();

  // Connecting or disconnecting from the menu replaces the button the menu hangs on. The focus goes
  // to the new button, or it would be left on nothing. A wallet that reconnects by itself when the
  // page loads does not move the focus.
  const trigger = useRef<HTMLButtonElement>(null);
  const fromMenu = useRef(false);
  useEffect(() => {
    if (!fromMenu.current) return;
    fromMenu.current = false;
    trigger.current?.focus();
  }, [isConnected]);

  // Two separate menus, told apart by their keys. If they were one, the menu that is closing after a
  // wallet was picked would show "Disconnect" for a moment, right where the next click may land.
  if (!isConnected || address === undefined) {
    return (
      <DropdownMenu key="connect">
        <DropdownMenuTrigger ref={trigger} className="quiet-action h-full w-full justify-between">
          <span>{connect.isPending ? 'Connecting…' : 'Connect wallet'}</span>
          <ChevronDown aria-hidden className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU}>
          <DropdownMenuLabel className="label">Sign with</DropdownMenuLabel>
          {offered(connectors).map((connector) => (
            <DropdownMenuItem
              key={connector.uid}
              className="rounded-none"
              onSelect={() => {
                fromMenu.current = true;
                connect.mutate({ connector, chainId: chain.id });
              }}
            >
              {connector.id === 'injected' ? 'Browser wallet' : connector.name}
            </DropdownMenuItem>
          ))}
          {connect.error ? (
            <p className="text-stop max-w-64 px-2 py-1.5 text-xs">
              {connect.error.message.split('\n')[0]}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const wrongChain = chainId !== chain.id;
  const roleName = role.principal
    ? 'Principal'
    : role.approver
      ? 'Approver'
      : 'No role in this vault';
  return (
    <DropdownMenu key="connected">
      <DropdownMenuTrigger
        ref={trigger}
        className="quiet-action h-full w-full justify-between gap-3"
      >
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="label">{wrongChain ? 'Wrong network' : roleName}</span>
          <span className="num text-foreground text-xs">{short(address)}</span>
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU}>
        <DropdownMenuLabel className="num text-xs font-normal break-all">
          {address}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {wrongChain ? (
          <DropdownMenuItem
            className="rounded-none"
            onSelect={() => {
              switchChain.mutate({ chainId: chain.id });
            }}
          >
            Switch to Arbitrum Sepolia
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="rounded-none"
          onSelect={() => {
            fromMenu.current = true;
            disconnect.mutate();
          }}
        >
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
