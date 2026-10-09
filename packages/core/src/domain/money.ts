/**
 * Turning amounts into the text a shopkeeper reads (§46).
 *
 * Everything in this system is XAF, and **XAF has no subunit** — there is no
 * centime, and the smallest coin is five francs. So a "minor unit" here is a
 * whole franc, and formatting is grouping digits rather than placing a decimal
 * point. A currency with cents would need a different function; writing one
 * that pretended to handle both is how a franc becomes a centime somewhere.
 *
 * ## Why the grouping is done by hand
 *
 * `Intl.NumberFormat` would do this, and on a desktop browser it would be the
 * right answer. On the cheap Android hardware this targets, the JavaScript
 * engine may ship without full ICU data, and the failure mode is not a crash —
 * it is a number that groups differently on one device than another. Prices
 * that read differently on the owner's phone and the till are worse than plain
 * ones, so the separator is applied here and is the same everywhere.
 *
 * Parsing is here too, and is the more dangerous direction: what a cashier
 * types becomes money that gets written down.
 */

/** The languages the app speaks (§46). */
export type Language = "fr" | "en";

/**
 * How francs are grouped, per language.
 *
 * French groups with a space — 12 500, not 12,500 — and that is the convention
 * in Cameroon. English uses a comma. The space is a **narrow no-break space**
 * so a price never wraps across two lines on a receipt or a small screen.
 */
const SEPARATOR: Record<Language, string> = { fr: " ", en: "," };

/** What the currency is called on a receipt. Locally it is FCFA, not XAF. */
export const CURRENCY_LABEL = "FCFA";

/**
 * Formats a whole-franc amount, without the currency name.
 *
 * Negative amounts keep their sign: a drawer that is short, or a customer in
 * credit, is a real number and rounding it to nothing would hide the one figure
 * worth looking at.
 */
export function formatAmount(minor: number, language: Language = "fr"): string {
  if (!Number.isFinite(minor)) {
    // Not a throw: a screen that crashed on a bad number would take the till
    // with it. An em dash reads as "no figure" to anyone.
    return "—";
  }

  const whole = Math.trunc(minor);
  const negative = whole < 0;
  const digits = Math.abs(whole).toString();

  const separator = SEPARATOR[language];
  let grouped = "";
  for (let index = 0; index < digits.length; index++) {
    // Counted from the right, a separator every three digits.
    const fromEnd = digits.length - index;
    if (index > 0 && fromEnd % 3 === 0) {
      grouped += separator;
    }
    grouped += digits[index];
  }

  return negative ? `-${grouped}` : grouped;
}

/**
 * Formats an amount with the currency, as it appears on a receipt.
 *
 * The name follows the number in both languages, which is what people here
 * write: "12 500 FCFA". The space before it is a no-break space, so a price
 * never breaks across two lines with the currency stranded on the second.
 */
export function formatMoney(minor: number, language: Language = "fr"): string {
  return `${formatAmount(minor, language)} ${CURRENCY_LABEL}`;
}

/**
 * Formats a quantity held in thousandths.
 *
 * Whole amounts print whole: "3 sacs", never "3.000 sacs". A shop selling by
 * the sack should never see a decimal point, and a shop selling by the kilo
 * needs one only when there is a fraction to show. Trailing zeroes are dropped
 * for the same reason.
 */
export function formatQuantity(thousandths: number, language: Language = "fr"): string {
  if (!Number.isFinite(thousandths)) {
    return "—";
  }

  const negative = thousandths < 0;
  const absolute = Math.abs(Math.trunc(thousandths));
  const whole = Math.floor(absolute / 1000);
  const fraction = absolute % 1000;

  const point = language === "fr" ? "," : ".";
  const shown =
    fraction === 0
      ? formatAmount(whole, language)
      : `${formatAmount(whole, language)}${point}${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;

  return negative ? `-${shown}` : shown;
}

/** Unit symbols and abbreviations never take a plural: 3 kg, 2 L, 5 m². */
const UNIT_SYMBOLS = new Set(["g", "kg", "mg", "t", "l", "ml", "cl", "dl", "m", "cm", "mm", "km", "m2", "m²", "m3", "m³", "lb", "oz", "pcs", "pc", "u"]);

/**
 * The plural of a shop-entered unit name, in the interface language. Symbols, abbreviations
 * (two letters or fewer, all capitals, a full stop or a digit) and words already ending in
 * s/x/z are kept. Only the first word changes, so "sac de 50 kg" becomes "sacs de 50 kg".
 * French: -au/-eau/-eu take x, -al becomes -aux. English: consonant + y becomes -ies,
 * -ch/-sh/-s/-x/-z take es.
 */
export function pluralUnit(unit: string, language: Language = "fr"): string {
  const trimmed = unit.trim(), space = trimmed.search(/\s/);
  const word = space < 0 ? trimmed : trimmed.slice(0, space), rest = space < 0 ? "" : trimmed.slice(space);
  if (word.length <= 2 || UNIT_SYMBOLS.has(word.toLowerCase()) || /[.\d]/.test(word) || word === word.toUpperCase()) return trimmed;
  const lower = word.toLowerCase();
  let plural: string;
  if (language === "fr") {
    if (/[sxz]$/.test(lower)) plural = word;
    else if (/(au|eu)$/.test(lower)) plural = `${word}x`;
    else if (/al$/.test(lower)) plural = `${word.slice(0, -1)}ux`;
    else plural = `${word}s`;
  } else if (/[^aeiou]y$/.test(lower)) plural = `${word.slice(0, -1)}ies`;
  else if (/(ch|sh|s|x|z)$/.test(lower)) plural = `${word}es`;
  else plural = `${word}s`;
  return plural + rest;
}

/**
 * A quantity followed by its unit, singular or plural by the language's own rules
 * (`Intl.PluralRules`): French keeps 0, 1 and 1,5 singular, English only 1.
 */
export function formatQuantityWithUnit(thousandths: number, unit: string, language: Language = "fr"): string {
  const shown = formatQuantity(thousandths, language);
  if (!Number.isFinite(thousandths) || unit.trim() === "") return `${shown} ${unit}`.trim();
  const count = new Intl.PluralRules(language).select(Math.abs(thousandths) / 1000);
  return `${shown} ${count === "one" ? unit.trim() : pluralUnit(unit, language)}`;
}

/** What went wrong with something a cashier typed. */
export type ParseFailure = "EMPTY" | "NOT_A_NUMBER" | "NEGATIVE" | "TOO_LARGE" | "FRACTIONAL";

/** Either the amount, or why it could not be read. */
export type ParsedAmount =
  | { readonly ok: true; readonly minor: number }
  | { readonly ok: false; readonly failure: ParseFailure };

/**
 * Reads an amount a cashier typed into whole francs.
 *
 * Deliberately strict, because this is the direction that writes money down.
 * It accepts the separators a person actually types — spaces, and the comma or
 * dot they use for grouping — and refuses anything else rather than guessing.
 *
 * A fraction is refused rather than rounded. There is no half franc, and a till
 * that silently rounded 100.5 would be deciding on the shopkeeper's behalf
 * which way their money went.
 */
export function parseAmount(text: string): ParsedAmount {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, failure: "EMPTY" };
  }

  // Grouping separators a person might type, in either language, plus the
  // narrow no-break space this file emits — so text copied off a screen and
  // typed back in reads the same.
  const stripped = trimmed.replace(/[\s  ]/g, "");
  // A well-formed negative only. Something like "--5" is not a negative price,
  // it is a typo, and telling a cashier "no negative prices" would send them
  // looking for a rule instead of a stray keystroke.
  if (/^-\d/.test(stripped)) {
    // A cashier does not enter a negative price. A refund is its own
    // transaction with its own screen, not a minus sign on this one.
    return { ok: false, failure: "NEGATIVE" };
  }

  // A comma or dot is ambiguous: "1,000" is a thousand in English and "1,5" is
  // one and a half in French. Since there is no fractional franc, the only
  // reading that can be correct here is grouping — but only when the digits
  // fall where grouping puts them. So the three shapes are told apart rather
  // than guessed between, and anything that is none of them is not a number
  // rather than a fraction.
  let digits: string;
  if (/^\d+$/.test(stripped)) {
    digits = stripped;
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(stripped)) {
    digits = stripped.replace(/[.,]/g, "");
  } else if (/^\d+[.,]\d+$/.test(stripped)) {
    // Somebody meaning half a franc. Refused rather than read as 1,005.
    return { ok: false, failure: "FRACTIONAL" };
  } else {
    return { ok: false, failure: "NOT_A_NUMBER" };
  }

  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) {
    // Beyond this, money stops being exact in a double (ADR-010).
    return { ok: false, failure: "TOO_LARGE" };
  }
  return { ok: true, minor };
}

/**
 * Reads a quantity a cashier typed into thousandths.
 *
 * Fractions are allowed here and refused above, and the difference is the
 * point: half a kilo is an ordinary thing to sell, and half a franc does not
 * exist. Beyond three decimal places is refused rather than rounded, because
 * that is the resolution the ledger stores and a quietly rounded quantity would
 * not match what was weighed.
 */
export function parseQuantity(text: string): ParsedAmount {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, failure: "EMPTY" };
  }

  const stripped = trimmed.replace(/[\s  ]/g, "");
  const match = /^(-?)(\d+)(?:[.,](\d+))?$/.exec(stripped);
  if (match === null) {
    return { ok: false, failure: "NOT_A_NUMBER" };
  }
  if (match[1] === "-") {
    return { ok: false, failure: "NEGATIVE" };
  }

  const fraction = match[3] ?? "";
  if (fraction.length > 3) {
    return { ok: false, failure: "FRACTIONAL" };
  }

  const whole = Number(match[2]);
  const thousandths = whole * 1000 + Number(fraction.padEnd(3, "0") || "0");
  if (!Number.isSafeInteger(thousandths)) {
    return { ok: false, failure: "TOO_LARGE" };
  }
  return { ok: true, minor: thousandths };
}
