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
