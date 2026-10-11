/**
 * The rules of the login form, with no React in them (ADR-004).
 *
 * A form being filled is transient UI state and belongs in the screen's own
 * `useState`. What does not belong there is what counts as fillable-in: these
 * are pure functions from what someone has typed to what the screen shows, so
 * they can be tested under Node and so a second screen cannot grow a second
 * answer to the same question.
 *
 * Nothing here checks a credential. The PIN is verified by the server and
 * nowhere else (ADR-012); what this prevents is spending a round trip (over a
 * link §45 assumes is slow and expensive) on something that cannot possibly be
 * right, such as an empty PIN or a business identifier missing half its digits.
 */

/**
 * Why a login form cannot be submitted yet.
 *
 * A code rather than a sentence, for the reason the cart's problems are: the
 * till speaks French and English (§44), and a message built here would be in
 * whichever language this file was written in.
 */
export type LoginProblem =
  | "BUSINESS_REQUIRED"
  | "BUSINESS_MALFORMED"
  | "PHONE_REQUIRED"
  | "PHONE_MALFORMED"
  | "PIN_REQUIRED"
  | "PIN_LENGTH"
  | "PIN_NOT_DIGITS";

/** What someone has typed. */
export interface LoginFormState {
  readonly business: string;
  readonly phone: string;
  readonly pin: string;
}

/** An untouched form. */
export const emptyLoginForm: LoginFormState = { business: "", phone: "", pin: "" };

/** What the screen shows, and what it would send. */
export interface LoginFormView {
  /** The business identifier in the form the server expects, when it is one. */
  readonly businessId: string | undefined;
  /** The number with its spacing removed, which is how it goes on the wire. */
  readonly phone: string;
  /**
   * Everything standing between this form and an attempt.
   *
   * Reported rather than thrown, because a form is *supposed* to be incomplete
   * while it is being filled — this never throws at somebody mid-way through
   * typing their number.
   */
  readonly problems: readonly LoginProblem[];
}

/**
 * PIN length, matching the server's `auth.ValidatePIN` (4 to 8 digits).
 *
 * Deliberately *not* matching its weak-PIN rules. Those exist for the moment a
 * PIN is chosen; applying them at login would tell somebody their PIN is too
 * simple when what they need to be told is that it is wrong, and would lock
 * out anyone whose PIN was set before the rule existed.
 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

/** Whether the form can be submitted as it stands. */
export function canSubmit(view: LoginFormView): boolean {
  return view.problems.length === 0;
}

/** Reads a filled-in form, saying what it would send and what is missing. */
export function viewLoginForm(form: LoginFormState): LoginFormView {
  const problems: LoginProblem[] = [];

  const businessId = normaliseBusinessId(form.business);
  if (form.business.trim() === "") {
    problems.push("BUSINESS_REQUIRED");
  } else if (businessId === undefined) {
    problems.push("BUSINESS_MALFORMED");
  }

  const phone = form.phone.replaceAll(/[\s .-]/gu, "");
  if (phone === "") {
    problems.push("PHONE_REQUIRED");
  } else if (!/^\+?\d{6,15}$/u.test(phone)) {
    // The shape only. Which numbers actually exist is libphonenumber's
    // question, and the server asks it (ADR-012) — a second answer here would
    // refuse a number the server would have accepted.
    problems.push("PHONE_MALFORMED");
  }

  if (form.pin === "") {
    problems.push("PIN_REQUIRED");
  } else if (!/^\d+$/u.test(form.pin)) {
    problems.push("PIN_NOT_DIGITS");
  } else if (form.pin.length < MIN_PIN_LENGTH || form.pin.length > MAX_PIN_LENGTH) {
    problems.push("PIN_LENGTH");
  }

  return { businessId, phone, problems };
}

/**
 * Reads a business identifier as the server will, or undefined if it is not one.
 *
 * Forgiving about how it was typed and strict about what it is. Every
 * identifier is a UUID (ADR-011), and the one place a person ever types one is
 * here: copied from a message, an email or a slip of paper, so it arrives with
 * stray spaces, in capitals, sometimes with the dashes rubbed out. All of those
 * name the same shop. Anything else is refused rather than sent, because the
 * server would refuse it after a round trip on a link that may cost the shop
 * money (§45).
 */
export function normaliseBusinessId(typed: string): string | undefined {
  const bare = typed.trim().replaceAll(/[\s -]/gu, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(bare)) {
    return undefined;
  }
  return [
    bare.slice(0, 8),
    bare.slice(8, 12),
    bare.slice(12, 16),
    bare.slice(16, 20),
    bare.slice(20),
  ].join("-");
}
