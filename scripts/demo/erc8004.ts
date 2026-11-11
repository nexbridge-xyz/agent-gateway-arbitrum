import { type Address, parseEventLogs } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

import {
  AGENT_WALLET_SET_TYPES,
  identityRegistryAbi,
  identityRegistryDomain,
  registrationDataUri,
} from '@agent-gateway/gateway';

import type { Context } from './context';

/**
 * Registers an agent in the ERC-8004 Identity Registry the way a company would:
 *
 *  1. The principal registers the agent and owns its identity token.
 *  2. The principal stores the registration file onchain, as a data: URI.
 *  3. The agent's request-signing key is set as the agent wallet. The agent proves it holds that key
 *     with an EIP-712 signature; it never sends a transaction and never needs gas.
 */
export async function registerAgent(
  context: Context,
  step: string,
  options: {
    owner: PrivateKeyAccount;
    agent: PrivateKeyAccount;
    name: string;
    description: string;
  },
): Promise<bigint> {
  const { publicClient, info, wallet, confirm } = context;
  const registry = { address: info.identityRegistry, abi: identityRegistryAbi } as const;
  const owner = wallet(options.owner);

  const registered = await confirm(
    step,
    'principal registers the agent in the ERC-8004 Identity Registry',
    await owner.writeContract({ ...registry, functionName: 'register' }),
  );
  const event = parseEventLogs({
    abi: identityRegistryAbi,
    logs: registered.logs,
    eventName: 'Registered',
  })[0];
  if (event === undefined) throw new Error('The registry did not emit Registered');
  const agentId = event.args.agentId;

  await confirm(
    step,
    `principal stores the registration file for agent ${agentId} onchain`,
    await owner.writeContract({
      ...registry,
      functionName: 'setAgentURI',
      args: [
        agentId,
        registrationDataUri({
          name: options.name,
          description: options.description,
          agentId,
          chainId: info.chainId,
          identityRegistry: info.identityRegistry,
        }),
      ],
    }),
  );

  // The registry accepts a deadline at most five minutes ahead.
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const deadline = block.timestamp + 240n;
  const signature = await options.agent.signTypedData({
    domain: identityRegistryDomain(info.chainId, info.identityRegistry),
    types: AGENT_WALLET_SET_TYPES,
    primaryType: 'AgentWalletSet',
    message: { agentId, newWallet: options.agent.address, owner: options.owner.address, deadline },
  });
  await confirm(
    step,
    "principal sets the agent's request-signing key as the agent wallet",
    await owner.writeContract({
      ...registry,
      functionName: 'setAgentWallet',
      args: [agentId, options.agent.address, deadline, signature],
    }),
  );

  return agentId;
}

/** Whether the agent exists, belongs to `owner` and has `agentWallet` as its wallet. */
export async function agentIsReady(
  context: Context,
  agentId: bigint,
  owner: Address,
  agentWallet: Address,
): Promise<boolean> {
  const registry = { address: context.info.identityRegistry, abi: identityRegistryAbi } as const;
  try {
    const [currentOwner, currentWallet] = await Promise.all([
      context.publicClient.readContract({ ...registry, functionName: 'ownerOf', args: [agentId] }),
      context.publicClient.readContract({
        ...registry,
        functionName: 'getAgentWallet',
        args: [agentId],
      }),
    ]);
    return currentOwner === owner && currentWallet === agentWallet;
  } catch {
    return false;
  }
}
