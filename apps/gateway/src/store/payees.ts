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
      /**
       * For a merchant that sells per call: the origin of its API, such as https://data.example.
       * The gateway buys only from this origin on the merchant's behalf.
       */
      origin: z
        .url()
        .refine(
          (value) => new URL(value).origin === value,
          'must be an origin: scheme, host and port only',
        )
        .optional(),
    }),
  ),
  denylist: z.array(z.strictObject({ address, reason: z.string().min(1).max(200) })).default([]),
});

export type PayeesFile = z.infer<typeof payeesSchema>;

export class PayeeDirectory {
  private readonly vendors = new Map<Address, { name: string; origin: string | null }>();
  private readonly denied = new Map<Address, { reason: string }>();

  /** The lists as the principal wrote them. */
  readonly file: PayeesFile;

  constructor(file: PayeesFile) {
    this.file = file;
    for (const vendor of file.vendors) {
      this.vendors.set(vendor.address, { name: vendor.name, origin: vendor.origin ?? null });
    }
    for (const entry of file.denylist) this.denied.set(entry.address, { reason: entry.reason });
  }

  /**
   * Reads the lists from a file. A missing file is an empty registry: then no payee is known, and
   * every request is refused.
   */
  static async load(path: string): Promise<PayeeDirectory> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new PayeeDirectory({ vendors: [], denylist: [] });
    }
    return new PayeeDirectory(payeesSchema.parse(JSON.parse(text)));
  }

  vendor(payee: Address): { name: string; origin: string | null } | null {
    return this.vendors.get(getAddress(payee)) ?? null;
  }

  denial(payee: Address): { reason: string } | null {
    return this.denied.get(getAddress(payee)) ?? null;
  }
}
