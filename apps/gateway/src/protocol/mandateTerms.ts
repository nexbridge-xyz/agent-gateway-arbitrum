import { type Address, type Hex, keccak256, stringToHex } from 'viem';

/**
 * A mandate's terms in plain text: what the principal reads and approves. The vault stores only the
 * hash of this text (`termsHash`), so anyone holding the text can check it against the chain.
 */

export type MandateTermsInput = {
  /** What the mandate is for, such as "VENDOR INVOICES". */
  title: string;
  principal: { name: string; address: Address };
  agent: { name: string; id: bigint; identityRegistry: Address };
  executor: Address;
  approver: Address;
  /** The line above the list of payees. */
  payeesIntro: string;
  payees: { name: string; address: Address }[];
  /** Whole tokens as text, such as "0.5". */
  caps: { perPayment: string; daily: string; hardCeiling: string };
  /** Further paragraphs, one entry per line. */
  notes: string[];
  /** Last second (Unix time) at which the mandate can pay. */
  validUntil: bigint;
  vault: Address;
  chainId: number;
  token: { symbol: string; address: Address };
};

export function mandateTerms(input: MandateTermsInput): string {
  const { caps, token } = input;
  const until = new Date(Number(input.validUntil) * 1000).toISOString().replace('.000Z', 'Z');
  return [
    `AGENT PAYMENT MANDATE: ${input.title}`,
    '',
    `Principal: ${input.principal.name} (${input.principal.address})`,
    `Agent: ${input.agent.name}, ERC-8004 agent ${input.agent.id} in eip155:${input.chainId}:${input.agent.identityRegistry}`,
    `Executor (gateway): ${input.executor}`,
    `Approver: ${input.approver}`,
    '',
    input.payeesIntro,
    ...input.payees.map((payee) => `  - ${payee.name} (${payee.address})`),
    `up to ${caps.perPayment} ${token.symbol} per payment and ${caps.daily} ${token.symbol} per UTC day.`,
    '',
    ...(input.notes.length === 0 ? [] : [...input.notes, '']),
    `No more than ${caps.hardCeiling} ${token.symbol} may leave under this mandate in one UTC day, payments with the`,
    "approver's signature included.",
    '',
    `Valid until ${until}. The principal may revoke this mandate at any time.`,
    `Vault: ${input.vault} on Arbitrum Sepolia (${input.chainId}). Token: ${token.symbol} (${token.address}).`,
    '',
  ].join('\n');
}

/** The hash the vault stores for a mandate's text. */
export function mandateTermsHash(text: string): Hex {
  return keccak256(stringToHex(text));
}
