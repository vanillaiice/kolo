import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canSubmit,
  emptyLoginForm,
  normaliseBusinessId,
  viewLoginForm,
  type LoginFormState,
} from "./login-form.ts";

const BUSINESS = "0190f3a1-4c2b-7e91-8a3d-2f6b5c8d9e01";

function form(overrides: Partial<LoginFormState> = {}): LoginFormState {
  return { business: BUSINESS, phone: "677 12 34 56", pin: "1357", ...overrides };
}

describe("a login form being filled", () => {
  it("does not throw at somebody who has typed nothing yet", () => {
    const view = viewLoginForm(emptyLoginForm);

    assert.equal(canSubmit(view), false);
    assert.deepEqual([...view.problems].sort(), ["BUSINESS_REQUIRED", "PHONE_REQUIRED", "PIN_REQUIRED"]);
  });

  it("says what it would send once it is filled in", () => {
    const view = viewLoginForm(form());

    assert.deepEqual(view.problems, []);
    assert.equal(canSubmit(view), true);
    assert.equal(view.businessId, BUSINESS);
    assert.equal(view.phone, "677123456", "spacing is how people write numbers, not part of one");
  });

  it("keeps a number typed with a country code", () => {
    assert.equal(viewLoginForm(form({ phone: "+237 677-12-34-56" })).phone, "+237677123456");
  });

  it("refuses what could not be a number, and leaves the rest to the server", () => {
    assert.deepEqual(viewLoginForm(form({ phone: "677ABC" })).problems, ["PHONE_MALFORMED"]);
    assert.deepEqual(viewLoginForm(form({ phone: "12345" })).problems, ["PHONE_MALFORMED"]);
    // A number this build has never seen is still sent: which numbers exist is
    // libphonenumber's question, and the server asks it.
    assert.deepEqual(viewLoginForm(form({ phone: "+441632960961" })).problems, []);
  });

  it("holds the PIN to the length the server does, and no further", () => {
    assert.deepEqual(viewLoginForm(form({ pin: "135" })).problems, ["PIN_LENGTH"]);
    assert.deepEqual(viewLoginForm(form({ pin: "135792468" })).problems, ["PIN_LENGTH"]);
    assert.deepEqual(viewLoginForm(form({ pin: "13a7" })).problems, ["PIN_NOT_DIGITS"]);
    assert.deepEqual(viewLoginForm(form({ pin: "13570" })).problems, []);

    // Deliberately accepted here: "1234" is a weak PIN, which matters when a
    // PIN is chosen. At login, somebody whose PIN predates that rule must
    // still be able to get in, and the answer they need is "wrong", not
    // "too simple".
    assert.deepEqual(viewLoginForm(form({ pin: "1234" })).problems, []);
    assert.deepEqual(viewLoginForm(form({ pin: "0000" })).problems, []);
  });

  it("reports every problem at once, rather than one at a time", () => {
    const view = viewLoginForm({ business: "not-a-uuid", phone: "", pin: "12" });

    assert.deepEqual([...view.problems].sort(), ["BUSINESS_MALFORMED", "PHONE_REQUIRED", "PIN_LENGTH"]);
  });
});

describe("the business identifier, which is the one thing a person ever types", () => {
  it("is read however it was copied", () => {
    // From a message, an email, a slip of paper: capitals, stray spaces, and
    // dashes rubbed out all name the same shop.
    for (const typed of [
      BUSINESS,
      BUSINESS.toUpperCase(),
      `  ${BUSINESS}  `,
      BUSINESS.replaceAll("-", ""),
      "0190F3A1 4C2B 7E91 8A3D 2F6B5C8D9E01",
    ]) {
      assert.equal(normaliseBusinessId(typed), BUSINESS, `failed on ${typed}`);
    }
  });

  it("refuses what is not one, rather than spending a round trip on it", () => {
    for (const typed of [
      "",
      "   ",
      "boutique chez jean",
      BUSINESS.slice(0, -1),
      `${BUSINESS}0`,
      "0190f3a1-4c2b-7e91-8a3d-2f6b5c8d9e0g",
      "0190f3a1_4c2b_7e91_8a3d_2f6b5c8d9e01",
    ]) {
      assert.equal(normaliseBusinessId(typed), undefined, `accepted ${typed}`);
    }
  });

  it("gives back something the server will parse, whatever was typed", () => {
    const normalised = normaliseBusinessId(BUSINESS.replaceAll("-", "").toUpperCase());

    assert.match(normalised ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  it("is idempotent, so re-reading what it produced changes nothing", () => {
    const once = normaliseBusinessId(BUSINESS.toUpperCase());
    assert.equal(normaliseBusinessId(once ?? ""), once);
  });
});
