import { ChevronDown } from 'lucide-react';
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
export function useRole(): { address: string | null; principal: boolean; approver: boolean } {
  const { address } = useConnection();
  const config = useGatewayConfig();
  const mandates = useMandates();
  const lower = address?.toLowerCase() ?? null;
  return {
    address: address ?? null,
    principal: lower !== null && config.data?.principal.toLowerCase() === lower,
    approver:
      lower !== null &&
      (mandates.data ?? []).some((mandate) => mandate.approver.toLowerCase() === lower),
  };
}

/** The wallet's place in the top strip: connect, see who is connected and as what, disconnect. */
export function WalletCell() {
  const { address, chainId, isConnected } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const role = useRole();

  // Two separate menus, told apart by their keys. If they were one, the menu that is closing after a
  // wallet was picked would show "Disconnect" for a moment, right where the next click may land.
  if (!isConnected || address === undefined) {
    return (
      <DropdownMenu key="connect">
        <DropdownMenuTrigger className="quiet-action h-full w-full justify-between">
          <span>{connect.isPending ? 'Connecting…' : 'Connect wallet'}</span>
          <ChevronDown aria-hidden className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64 rounded-none">
          <DropdownMenuLabel className="label">Sign with</DropdownMenuLabel>
          {connectors.map((connector) => (
            <DropdownMenuItem
              key={connector.uid}
              className="rounded-none"
              onSelect={() => {
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
      <DropdownMenuTrigger className="quiet-action h-full w-full justify-between gap-3">
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="label">{wrongChain ? 'Wrong network' : roleName}</span>
          <span className="num text-foreground text-xs">{short(address)}</span>
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 rounded-none">
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
            disconnect.mutate();
          }}
        >
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
