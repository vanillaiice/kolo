/** Stable JSON representation of the bounded, safe-integer-only event format. */
export class CanonicalError extends Error {
  constructor() { super("invalid_canonical_value"); this.name = "CanonicalError"; }
}
/** Number of bytes when a valid Unicode string is encoded as UTF-8, without Buffer. */
export function utf8Length(value: string): number {
  let size = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new CanonicalError();
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}
/**
 * RFC 8785 ordering/string serialization restricted to safe integer numbers.
 * Rejects non-JSON/prototype values, cycles, excessive depth/bytes and invalid
 * Unicode. Property names sort by UTF-16 code units; arrays retain order.
 * This determines signed bytes, not trust, a content digest or a signature.
 */
export function canonicalJson(value: unknown, maximumBytes = 1024 * 1024): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new CanonicalError();
  const seen = new Set<object>();
  function encode(input: unknown, depth: number): string {
    if (depth > 32) throw new CanonicalError();
    if (input === null || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "string") { utf8Length(input); return JSON.stringify(input); }
    if (typeof input === "number") { if (!Number.isSafeInteger(input)) throw new CanonicalError(); return JSON.stringify(input); }
    if (typeof input !== "object" || seen.has(input) || (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))) throw new CanonicalError();
    seen.add(input);
    let encoded: string;
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || Object.keys(input).length !== input.length || Object.getOwnPropertySymbols(input).length !== 0) throw new CanonicalError();
      const entries: string[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) throw new CanonicalError();
        entries.push(encode(descriptor.value, depth + 1));
      }
      encoded = `[${entries.join(",")}]`;
    } else {
      if (Object.getOwnPropertySymbols(input).length !== 0) throw new CanonicalError();
      encoded = `{${Object.keys(input).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!Object.hasOwn(descriptor, "value")) throw new CanonicalError();
        return `${encode(key, depth + 1)}:${encode(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    }
    seen.delete(input);
    if (encoded.length > maximumBytes) throw new CanonicalError();
    return encoded;
  }
  const encoded = encode(value, 0);
  if (utf8Length(encoded) > maximumBytes) throw new CanonicalError();
  return encoded;
}
