import type { JsonObject } from '../protocol/json';

/**
 * ERC-8004 agent registration files. The gateway only reads files stored onchain as `data:` URIs.
 * It does not fetch remote URIs: a URL in a registry is untrusted input.
 */

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

const MAX_URI_LENGTH = 64 * 1024;

export type AgentRegistration = {
  name: string;
  description: string;
  agentId: bigint;
  chainId: number;
  identityRegistry: string;
};

/** Builds the registration file and returns it as a base64 `data:` URI, so it lives fully onchain. */
export function registrationDataUri(registration: AgentRegistration): string {
  const file: JsonObject = {
    type: REGISTRATION_TYPE,
    name: registration.name,
    description: registration.description,
    image: '',
    services: [],
    x402Support: false,
    active: true,
    registrations: [
      {
        agentId: Number(registration.agentId),
        agentRegistry: `eip155:${registration.chainId}:${registration.identityRegistry}`,
      },
    ],
    supportedTrust: [],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file), 'utf8').toString('base64')}`;
}

/**
 * The `active` flag of an onchain registration file: true or false when the file states it, null when
 * there is no onchain file to read or it does not say.
 */
export function activeFlagFromUri(uri: string | null): boolean | null {
  if (uri === null || uri.length > MAX_URI_LENGTH) return null;

  const base64 = /^data:application\/json;base64,(.*)$/s.exec(uri);
  const plain = /^data:application\/json(?:;charset=[^,;]+)?,(.*)$/s.exec(uri);

  let text: string;
  try {
    if (base64?.[1] !== undefined) text = Buffer.from(base64[1], 'base64').toString('utf8');
    else if (plain?.[1] !== undefined) text = decodeURIComponent(plain[1]);
    else return null;
  } catch {
    return null;
  }

  try {
    const file: unknown = JSON.parse(text);
    if (
      typeof file === 'object' &&
      file !== null &&
      'active' in file &&
      typeof file.active === 'boolean'
    ) {
      return file.active;
    }
  } catch {
    // Not JSON: nothing to read.
  }
  return null;
}
