import { parseAbi } from 'viem';

export { mandateVaultAbi } from '@agent-gateway/contracts/abi';

/** The parts of the ERC-8004 Identity Registry this project uses. */
export const identityRegistryAbi = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
  'function register() returns (uint256 agentId)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

/** EIP-712 type the new wallet signs so that the agent's owner can register it. */
export const AGENT_WALLET_SET_TYPES = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export function identityRegistryDomain(chainId: number, registry: `0x${string}`) {
  return {
    name: 'ERC8004IdentityRegistry',
    version: '1',
    chainId,
    verifyingContract: registry,
  } as const;
}
