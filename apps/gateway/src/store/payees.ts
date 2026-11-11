import { readFile } from 'node:fs/promises';

import { type Address, getAddress, isAddress } from 'viem';
import { z } from 'zod';

/**
 * The principal's own lists: the vendor registry (payees the principal knows) and the denylist
 * (payees that must never be paid). These files are the trusted source for "who is this payee".
 * Text an agent has read, such as a tool response or an invoice, is never one.
 */

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), 'must be an address')
  .transform((value) => getAddress(value));

export const payeesSchema = z.strictObject({
  vendors: z.array(
    z.strictObject({
      name: z.string().min(1).max(80),
      address,
      note: z.string().max(200).optional(),
    }),
  ),
  denylist: z.array(z.strictObject({ address, reason: z.string().min(1).max(200) })).default([]),
});

export type PayeesFile = z.infer<typeof payeesSchema>;

export class PayeeDirectory {
  private readonly vendors = new Map<Address, { name: string }>();
  private readonly denied = new Map<Address, { reason: string }>();

  constructor(file: PayeesFile) {
    for (const vendor of file.vendors) this.vendors.set(vendor.address, { name: vendor.name });
    for (const entry of file.denylist) this.denied.set(entry.address, { reason: entry.reason });
  }

  static async load(path: string): Promise<PayeeDirectory> {
    return new PayeeDirectory(payeesSchema.parse(JSON.parse(await readFile(path, 'utf8'))));
  }

  vendor(payee: Address): { name: string } | null {
    return this.vendors.get(getAddress(payee)) ?? null;
  }

  denial(payee: Address): { reason: string } | null {
    return this.denied.get(getAddress(payee)) ?? null;
  }
}
