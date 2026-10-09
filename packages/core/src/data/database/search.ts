/**
 * Accent- and case-insensitive search that works on every SQLite driver (Expo cannot register
 * SQL functions). The typed term is folded in JavaScript; the searched column is folded in SQL
 * by a fixed chain of `replace()` calls, so "cafe", "Café" and "CAFÉ" all find "Café Nescafé".
 * `LIKE` already ignores ASCII case once accents are gone.
 */

/** Accented letters and ligatures as written in French/English shop data, with their plain form. */
const FOLDS: readonly (readonly [string, string])[] = [
  ..."àáâãäåÀÁÂÃÄÅ".split("").map(letter => [letter, "a"] as const),
  ..."èéêëÈÉÊË".split("").map(letter => [letter, "e"] as const),
  ..."ìíîïÌÍÎÏ".split("").map(letter => [letter, "i"] as const),
  ..."òóôõöÒÓÔÕÖ".split("").map(letter => [letter, "o"] as const),
  ..."ùúûüÙÚÛÜ".split("").map(letter => [letter, "u"] as const),
  ..."ýÿÝŸ".split("").map(letter => [letter, "y"] as const),
  ["ç", "c"], ["Ç", "c"], ["ñ", "n"], ["Ñ", "n"], ["œ", "oe"], ["Œ", "oe"], ["æ", "ae"], ["Æ", "ae"],
  [String.fromCodePoint(0x2018), "'"], [String.fromCodePoint(0x2019), "'"],
];

/** Left and right single quotation marks, as typed by phones and word processors. */
const CURLY_QUOTES = new RegExp(`[${String.fromCodePoint(0x2018)}${String.fromCodePoint(0x2019)}]`, "g");

/** SQL expression for `column` with the same folding as {@link foldSearchTerm}. `column` must be a trusted identifier. */
export function foldedColumn(column: string): string {
  if (!/^[a-z_]+(\.[a-z_]+)?$/.test(column)) throw new Error("folded column must be an identifier");
  const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;
  return FOLDS.reduce((expression, [from, to]) => `replace(${expression},${literal(from)},${literal(to)})`, column);
}

/** Lower-cases and removes accents from a typed search term. */
export function foldSearchTerm(term: string): string {
  // NFD splits accented letters into base + combining mark; ligatures and quotes have no decomposition.
  return term.normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[œŒ]/g, "oe").replace(/[æÆ]/g, "ae").replace(CURLY_QUOTES, "'").toLowerCase();
}

/** A folded term escaped for `LIKE ... ESCAPE '\'`: a prefix by default, or a match anywhere. */
export function likePattern(term: string, { anywhere = false }: { readonly anywhere?: boolean } = {}): string {
  const escaped = foldSearchTerm(term).replace(/[\\%_]/g, character => "\\" + character);
  return `${anywhere ? "%" : ""}${escaped}%`;
}
