/** A JSON value. Evidence records and intent contexts are made of these and nothing else. */
export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

/**
 * Canonical JSON as defined by RFC 8785 (JSON Canonicalization Scheme): no whitespace, object keys
 * sorted by UTF-16 code units, and numbers and strings written the way ECMAScript writes them.
 * Two parties that canonicalize the same value always get the same bytes, so they get the same hash.
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);

  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new TypeError('String contains a lone surrogate');
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Number is not finite');
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const members = Object.keys(value)
      .sort() // the default order compares UTF-16 code units, as RFC 8785 requires
      .map((key) => `${canonicalize(key)}:${canonicalize(value[key] as Json)}`);
    return `{${members.join(',')}}`;
  }

  throw new TypeError(`Not a JSON value: ${typeof value}`);
}

/** Whether a value read from outside is plain JSON. */
export function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.isWellFormed();
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).every(
      ([key, item]) => key.isWellFormed() && isJson(item, depth + 1),
    );
  }
  return false;
}
