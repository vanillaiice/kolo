package finance

import (
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// Balance is what an account holds, worked out from what moved through it.
//
// Never stored. §18's whole job is comparing what the system says is in the
// drawer against what is actually in it, and a stored balance would be both the
// number being checked and the number checking (§59).
//
// It is summed from every source that moves money — the payments taken into the
// account, the customers settling their debts into it, and the movements a
// person made by hand — because each of those is recorded once, where it
// happened. A second ledger repeating them would be a copy that could disagree.
type Balance struct {
	AccountID AccountID
	// OnHand is what the account should contain.
	OnHand money.Money
	// Movements is how many facts the sum came from, so a caller can tell "empty
	// because nothing has happened" from "empty because it was emptied".
	Movements int
	// LastMovedAt is when money last moved, or the zero time if it never has.
	LastMovedAt time.Time
}

// IsEmpty reports whether the account holds nothing.
func (b Balance) IsEmpty() bool { return !b.OnHand.Valid() || b.OnHand.IsZero() }

// IsOverdrawn reports whether more has left the account than entered it.
//
// Not an error, and deliberately not prevented. A till that reads below zero is
// a real thing — a payment recorded that never happened, cash taken without a
// movement written — and the honest answer is the negative number, which is
// what makes someone go and look. Refusing to record the movement that caused
// it would hide the problem rather than fix it.
func (b Balance) IsOverdrawn() bool { return b.OnHand.IsNegative() }

// Reconciliation is a cash count set against what the system believes (§18).
//
// The worked example: expected 245,500, counted 240,500, so the drawer is 5,000
// short. Nothing here changes a balance — it only says what the difference is.
// Correcting it is an Adjustment movement, which is a new record of what was
// found rather than an edit to what was believed.
type Reconciliation struct {
	AccountID AccountID
	// Expected is what the movements say should be there.
	Expected money.Money
	// Counted is what the person counting actually found.
	Counted money.Money
	// Difference is Counted less Expected: negative for a drawer that is short,
	// positive for one holding more than the system knows about.
	Difference money.Money
	CountedAt  time.Time
}

// Balances reports whether the count agrees with the system.
func (r Reconciliation) Balances() bool { return r.Difference.IsZero() }

// IsShort reports whether less was found than expected.
func (r Reconciliation) IsShort() bool { return r.Difference.IsNegative() }

// IsOver reports whether more was found than expected.
func (r Reconciliation) IsOver() bool { return r.Difference.IsPositive() }

// Reconcile sets a count against a derived balance.
//
// The difference is counted less expected, in that order, so a shortfall reads
// negative — the direction an adjustment would have to move the account to make
// the books agree with the drawer.
func Reconcile(balance Balance, counted money.Money, countedAt time.Time) (Reconciliation, error) {
	if balance.AccountID.IsZero() {
		return Reconciliation{}, fmt.Errorf("%w: account", ErrInvalidID)
	}
	if !counted.Valid() {
		return Reconciliation{}, fmt.Errorf("%w: the count has no currency", ErrInvalidAmount)
	}
	if counted.IsNegative() {
		return Reconciliation{}, fmt.Errorf("%w: a count of %s", ErrInvalidAmount, counted)
	}
	if countedAt.IsZero() {
		return Reconciliation{}, fmt.Errorf("%w: no moment given", ErrInvalidAmount)
	}

	// An account nothing has moved through holds nothing, which is a balance of
	// zero in the currency counted rather than no answer at all.
	expected := balance.OnHand
	if !expected.Valid() {
		expected = counted.Currency().Zero()
	}

	difference, err := counted.Sub(expected)
	if err != nil {
		return Reconciliation{}, fmt.Errorf("%w: %w", ErrInvalidCurrency, err)
	}

	return Reconciliation{
		AccountID:  balance.AccountID,
		Expected:   expected,
		Counted:    counted,
		Difference: difference,
		CountedAt:  countedAt.UTC(),
	}, nil
}

// Correction builds the adjustment that makes an account agree with a count.
//
// The reason is required and carried through: an adjustment is money appearing
// or vanishing with no business event behind it, and months later the only
// thing that explains it is what the person wrote down (§39).
//
// A count that agrees needs no correction, which is not an error — it is the
// ordinary outcome, and the caller is told by the nil movement.
func (r Reconciliation) Correction(
	snapshot MovementSnapshot, reason string,
) (*Movement, error) {
	if r.Balances() {
		return nil, nil
	}

	snapshot.AccountID = r.AccountID
	snapshot.Type = Adjustment
	snapshot.Amount = r.Difference
	snapshot.Reason = reason
	if snapshot.OccurredAt.IsZero() {
		snapshot.OccurredAt = r.CountedAt
	}

	movement, err := RecordMovement(snapshot)
	if err != nil {
		return nil, err
	}
	return movement, nil
}
