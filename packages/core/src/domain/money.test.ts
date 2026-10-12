import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CURRENCY_LABEL,
  formatAmount,
  formatMoney,
  formatQuantity,
  formatRate,
  formatQuantityWithUnit,
  pluralUnit,
  parseAmount,
  parseQuantity,
} from "./money.ts";

/** The narrow no-break space French grouping uses. */
const NBSP = "\u202F";
/** The no-break space that keeps an amount and FCFA on one line. */
const NBSP_WIDE = "\u00A0";

describe("showing an amount", () => {
  it("groups in threes, with a space in French and a comma in English", () => {
    assert.equal(formatAmount(12_500, "fr"), `12${NBSP}500`);
    assert.equal(formatAmount(12_500, "en"), "12,500");
    assert.equal(formatAmount(1_234_567, "fr"), `1${NBSP}234${NBSP}567`);
  });

  it("leaves short amounts alone", () => {
    assert.equal(formatAmount(0), "0");
    assert.equal(formatAmount(5), "5");
    assert.equal(formatAmount(999), "999");
    assert.equal(formatAmount(1_000, "en"), "1,000");
  });

  it("keeps a negative sign, because a short drawer is a real number", () => {
    // Rounding it away would hide the one figure worth looking at (§18).
    assert.equal(formatAmount(-2_500, "en"), "-2,500");
    assert.equal(formatAmount(-500), "-500");
  });

  it("puts the currency after the number, as people here write it", () => {
    assert.equal(formatMoney(12_500, "fr"), `12${NBSP}500${NBSP_WIDE}${CURRENCY_LABEL}`);
    // A no-break space, so a price never splits across two lines with FCFA
    // stranded on the second.
    assert.equal(formatMoney(500, "en"), `500${NBSP_WIDE}${CURRENCY_LABEL}`);
    assert.equal(CURRENCY_LABEL, "FCFA");
  });

  it("shows a dash rather than crashing the till on a bad number", () => {
    // A screen that threw would take the till with it.
    assert.equal(formatAmount(Number.NaN), "—");
    assert.equal(formatAmount(Number.POSITIVE_INFINITY), "—");
  });

  it("never shows a decimal, because XAF has no subunit", () => {
    for (const amount of [1, 500, 12_500, 1_000_000]) {
      assert.equal(formatAmount(amount).includes("."), false);
      assert.equal(formatAmount(amount).includes(","), false);
    }
  });
});

describe("showing a quantity", () => {
  it("shows a whole amount whole", () => {
    // A shop selling by the sack should never see "3.000 sacs".
    assert.equal(formatQuantity(3_000), "3");
    assert.equal(formatQuantity(0), "0");
    assert.equal(formatQuantity(20_000, "en"), "20");
  });

  it("shows a fraction only when there is one", () => {
    assert.equal(formatQuantity(1_500, "fr"), "1,5");
    assert.equal(formatQuantity(1_500, "en"), "1.5");
    assert.equal(formatQuantity(500, "en"), "0.5");
    assert.equal(formatQuantity(1_250, "en"), "1.25");
  });

  it("drops trailing zeroes rather than padding to three places", () => {
    assert.equal(formatQuantity(1_100, "en"), "1.1");
    assert.equal(formatQuantity(1_010, "en"), "1.01");
  });

  it("groups a large quantity too", () => {
    assert.equal(formatQuantity(12_500_000, "en"), "12,500");
  });

  it("keeps a negative sign, because stock can be below zero", () => {
    // Two devices each selling the last unit offline is expected (§29).
    assert.equal(formatQuantity(-1_000), "-1");
    assert.equal(formatQuantity(-1_500, "en"), "-1.5");
  });
});

describe("reading an amount a cashier typed", () => {
  it("reads whole francs", () => {
    assert.deepEqual(parseAmount("12500"), { ok: true, minor: 12_500 });
    assert.deepEqual(parseAmount("  500 "), { ok: true, minor: 500 });
    assert.deepEqual(parseAmount("0"), { ok: true, minor: 0 });
  });

  it("accepts the grouping a person types, and the one this file prints", () => {
    // So text read off a screen and typed back in reads the same.
    assert.deepEqual(parseAmount("12 500"), { ok: true, minor: 12_500 });
    assert.deepEqual(parseAmount(`12${NBSP}500`), { ok: true, minor: 12_500 });
  });

  it("reads a grouping comma as grouping, not as a decimal point", () => {
    // "1,000" is a thousand in English. Reading the comma as a decimal point
    // would refuse a number a cashier had just read off the screen.
    assert.deepEqual(parseAmount("1,000"), { ok: true, minor: 1_000 });
    assert.deepEqual(parseAmount("12,500"), { ok: true, minor: 12_500 });
    assert.deepEqual(parseAmount("1.234.567"), { ok: true, minor: 1_234_567 });
  });

  it("still refuses a separator that is not in a grouping position", () => {
    // "100.5" is somebody meaning half a franc, and must not become 1,005.
    assert.deepEqual(parseAmount("100.5"), { ok: false, failure: "FRACTIONAL" });
    assert.deepEqual(parseAmount("1,50"), { ok: false, failure: "FRACTIONAL" });
    assert.deepEqual(parseAmount("1,0000"), { ok: false, failure: "FRACTIONAL" });
  });

  it("refuses grouping that mixes a dot and a comma rather than guessing", () => {
    // "1.000,500" is a European one thousand and a half, not 1,000,500 francs.
    assert.deepEqual(parseAmount("1.000,500"), { ok: false, failure: "NOT_A_NUMBER" });
    assert.deepEqual(parseAmount("1,000.000"), { ok: false, failure: "NOT_A_NUMBER" });
    assert.deepEqual(parseAmount("1.000.000"), { ok: true, minor: 1_000_000 });
    assert.deepEqual(parseAmount("1,000,000"), { ok: true, minor: 1_000_000 });
  });

  it("refuses a fraction rather than rounding it", () => {
    // There is no half franc, and a till that rounded would be deciding which
    // way the shopkeeper's money went.
    assert.deepEqual(parseAmount("100.5"), { ok: false, failure: "FRACTIONAL" });
    assert.deepEqual(parseAmount("100,5"), { ok: false, failure: "FRACTIONAL" });
  });

  it("refuses a negative price", () => {
    // A refund is its own transaction, not a minus sign on this screen.
    assert.deepEqual(parseAmount("-500"), { ok: false, failure: "NEGATIVE" });
  });

  it("refuses what is not a number rather than guessing", () => {
    for (const text of ["abc", "12a", "1.2.3", "--5", "1e5", "+5"]) {
      assert.deepEqual(parseAmount(text), { ok: false, failure: "NOT_A_NUMBER" }, text);
    }
  });

  it("says empty is empty, which is what a blank box is", () => {
    assert.deepEqual(parseAmount(""), { ok: false, failure: "EMPTY" });
    assert.deepEqual(parseAmount("   "), { ok: false, failure: "EMPTY" });
  });

  it("refuses an amount too large to be exact", () => {
    // Beyond a safe integer money stops being exact (ADR-010).
    assert.deepEqual(parseAmount("99999999999999999999"), { ok: false, failure: "TOO_LARGE" });
  });

  it("round-trips what it printed", () => {
    for (const amount of [0, 5, 999, 1_000, 12_500, 1_234_567]) {
      for (const language of ["fr", "en"] as const) {
        assert.deepEqual(
          parseAmount(formatAmount(amount, language)),
          { ok: true, minor: amount },
          `${amount} ${language}`,
        );
      }
    }
  });
});

describe("reading a quantity a cashier typed", () => {
  it("reads whole units as thousandths", () => {
    assert.deepEqual(parseQuantity("3"), { ok: true, minor: 3_000 });
    assert.deepEqual(parseQuantity("20"), { ok: true, minor: 20_000 });
  });

  it("allows a fraction, because half a kilo is an ordinary sale", () => {
    // The difference from an amount, and the reason these are two functions.
    assert.deepEqual(parseQuantity("1.5"), { ok: true, minor: 1_500 });
    assert.deepEqual(parseQuantity("1,5"), { ok: true, minor: 1_500 });
    assert.deepEqual(parseQuantity("0.25"), { ok: true, minor: 250 });
    assert.deepEqual(parseQuantity("0.125"), { ok: true, minor: 125 });
  });

  it("refuses finer than the ledger stores rather than rounding", () => {
    // A quietly rounded quantity would not match what was weighed.
    assert.deepEqual(parseQuantity("1.2345"), { ok: false, failure: "FRACTIONAL" });
  });

  it("refuses a negative quantity", () => {
    assert.deepEqual(parseQuantity("-1"), { ok: false, failure: "NEGATIVE" });
  });

  it("refuses what is not a number", () => {
    for (const text of ["", "abc", "1.2.3"]) {
      assert.equal(parseQuantity(text).ok, false, text);
    }
  });

  it("round-trips what it printed", () => {
    for (const thousandths of [0, 500, 1_000, 1_250, 3_000, 20_000]) {
      for (const language of ["fr", "en"] as const) {
        assert.deepEqual(
          parseQuantity(formatQuantity(thousandths, language)),
          { ok: true, minor: thousandths },
          `${thousandths} ${language}`,
        );
      }
    }
  });
});

describe("units follow the quantity's grammatical number", () => {
  it("French: 0, 1 and fractions below 2 stay singular; 2 and more are plural", () => {
    assert.equal(formatQuantityWithUnit(24_000, "sachet"), "24 sachets");
    assert.equal(formatQuantityWithUnit(1_000, "sachet"), "1 sachet");
    assert.equal(formatQuantityWithUnit(0, "sachet"), "0 sachet");
    assert.equal(formatQuantityWithUnit(1_500, "litre"), "1,5 litre");
    assert.equal(formatQuantityWithUnit(2_000, "litre"), "2 litres");
    assert.equal(formatQuantityWithUnit(-3_000, "boîte"), "-3 boîtes");
    assert.equal(formatQuantityWithUnit(12_000, "morceau"), "12 morceaux");
    assert.equal(formatQuantityWithUnit(4_000, "bocal"), "4 bocaux");
    assert.equal(formatQuantityWithUnit(1_200_000, "pièce"), `${formatQuantity(1_200_000)} pièces`);
  });
  it("English: only exactly one is singular", () => {
    assert.equal(formatQuantityWithUnit(1_000, "bag", "en"), "1 bag");
    assert.equal(formatQuantityWithUnit(1_500, "bag", "en"), "1.5 bags");
    assert.equal(formatQuantityWithUnit(0, "box", "en"), "0 boxes");
    assert.equal(formatQuantityWithUnit(3_000, "battery", "en"), "3 batteries");
    assert.equal(formatQuantityWithUnit(3_000, "tray", "en"), "3 trays");
  });
  it("symbols, abbreviations and already-plural words are unchanged", () => {
    for (const unit of ["kg", "g", "L", "ml", "m²", "PCS", "cs.", "50kg", "u", "pcs", "Kg", "prix", "colis", "gaz"]) assert.equal(pluralUnit(unit), unit.trim(), unit);
    assert.equal(formatQuantityWithUnit(5_000, "kg"), "5 kg");
    assert.equal(formatQuantityWithUnit(5_000, "  sachet "), "5 sachets");
    assert.equal(formatQuantityWithUnit(5_000, ""), "5");
  });
  it("only the first word of a descriptive unit changes", () => {
    assert.equal(pluralUnit("sac de 50 kg"), "sacs de 50 kg");
    assert.equal(pluralUnit("bag of rice", "en"), "bags of rice");
  });
  it("matches Intl plural categories at every thousandth around the boundaries", () => {
    for (let thousandths = -3_000; thousandths <= 3_000; thousandths++)
      for (const language of ["fr", "en"] as const) {
        const one = new Intl.PluralRules(language).select(Math.abs(thousandths) / 1000) === "one";
        assert.equal(formatQuantityWithUnit(thousandths, "sachet", language).endsWith(one ? "sachet" : "sachets"), true, `${language} ${thousandths}`);
      }
  });
  it("does not need Intl.PluralRules, which a phone's JavaScript engine may lack", () => {
    const original = Intl.PluralRules;
    Object.defineProperty(Intl, "PluralRules", { value: undefined, configurable: true, writable: true });
    try {
      assert.equal(formatQuantityWithUnit(1_500, "sac"), "1,5 sac");
      assert.equal(formatQuantityWithUnit(2_000, "sac"), "2 sacs");
      assert.equal(formatQuantityWithUnit(1_000, "bag", "en"), "1 bag");
      assert.equal(formatQuantityWithUnit(1_500, "bag", "en"), "1.5 bags");
    } finally {
      Object.defineProperty(Intl, "PluralRules", { value: original, configurable: true, writable: true });
    }
  });
  it("matches Intl plural categories for many quantities", () => {
    for (let thousandths = -5_000; thousandths <= 5_000; thousandths += 250)
      for (const language of ["fr", "en"] as const) {
        const one = new Intl.PluralRules(language).select(Math.abs(thousandths) / 1000) === "one";
        assert.equal(formatQuantityWithUnit(thousandths, "sachet", language).endsWith(one ? "sachet" : "sachets"), true, `${language} ${thousandths}`);
      }
  });
});

it("formats tax rates the way each language writes them", () => {
  assert.equal(formatRate(1925, "fr"), "19,25 %"); assert.equal(formatRate(1925, "en"), "19.25%");
  assert.equal(formatRate(1000, "fr"), "10 %"); assert.equal(formatRate(550, "en"), "5.5%"); assert.equal(formatRate(0, "en"), "0%");
  assert.equal(formatRate(1, "en"), "0.01%"); assert.equal(formatRate(10000, "fr"), "100 %"); assert.equal(formatRate(1.5, "fr"), "—");
});
