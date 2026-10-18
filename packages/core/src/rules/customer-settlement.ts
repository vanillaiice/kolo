import { integer, RuleError, sumAmounts } from "./amounts.ts";

/** How an amount posted to a customer's account uses prepaid credit and adds debt. */
export interface CustomerSettlement {
  readonly balanceBeforeMinor: number;
  readonly balanceAfterMinor: number;
  readonly creditAppliedMinor: number;
  readonly debtAddedMinor: number;
}

/** Positive balances are owed by the customer; negative balances are credit held by the shop. */
export function customerSettlement(balanceBeforeMinor: number, onAccountMinor: number): CustomerSettlement {
  integer(balanceBeforeMinor);
  if (integer(onAccountMinor) < 0n) throw new RuleError("invalid_amount");
  const creditAppliedMinor = Math.min(Math.max(0, -balanceBeforeMinor), onAccountMinor);
  return { balanceBeforeMinor, balanceAfterMinor: sumAmounts([balanceBeforeMinor, onAccountMinor]),
    creditAppliedMinor, debtAddedMinor: onAccountMinor - creditAppliedMinor };
}

/**
 * The change a named customer can leave on their account: cash handed over beyond the cash due, on a sale with nothing
 * left owing. Zero when there is nothing to keep: no customer, nothing tendered or too little, or a sale left on account.
 */
export function keepableChange(input: { readonly hasCustomer: boolean; readonly cashDueMinor: number; readonly tenderedMinor: number | undefined; readonly outstandingMinor: number }): number {
  integer(input.cashDueMinor); integer(input.outstandingMinor);
  if (!input.hasCustomer || input.tenderedMinor === undefined || input.outstandingMinor !== 0 || input.cashDueMinor <= 0) return 0;
  integer(input.tenderedMinor);
  return Math.max(0, input.tenderedMinor - input.cashDueMinor);
}
