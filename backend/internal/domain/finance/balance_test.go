package finance_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

var countedAt = time.Date(2026, 8, 14, 18, 0, 0, 0, time.UTC)

func aBalance(account finance.AccountID, minor int64, movements int) finance.Balance {
	return finance.Balance{
		AccountID:   account,
		OnHand:      money.FromXAF(minor),
		Movements:   movements,
		LastMovedAt: movedAt,
	}
}

// §18's worked example: expected 245,500, counted 240,500, the drawer is 5,000
// short.
func TestTheWorkedCashCount(t *testing.T) {
	d := newDrawer()

	reconciliation, err := finance.Reconcile(
		aBalance(d.account, 245_500, 12), money.FromXAF(240_500), countedAt)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	if got := reconciliation.Difference.Amount(); got != -5_000 {
		t.Errorf("difference = %d, want -5000", got)
	}
	if !reconciliation.IsShort() {
		t.Error("a drawer 5,000 down does not read as short")
	}
	if reconciliation.Balances() || reconciliation.IsOver() {
		t.Error("a short drawer read as balanced or over")
	}
	if reconciliation.Expected.Amount() != 245_500 || reconciliation.Counted.Amount() != 240_500 {
		t.Errorf("kept %s expected and %s counted", reconciliation.Expected, reconciliation.Counted)
	}
}

func TestACountThatAgreesNeedsNoCorrection(t *testing.T) {
	d := newDrawer()

	reconciliation, err := finance.Reconcile(
		aBalance(d.account, 245_500, 12), money.FromXAF(245_500), countedAt)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if !reconciliation.Balances() {
		t.Errorf("difference = %s, want nothing", reconciliation.Difference)
	}

	correction, err := reconciliation.Correction(d.snapshot(finance.Adjustment, 1), "compté")
	if err != nil {
		t.Fatalf("Correction: %v", err)
	}
	if correction != nil {
		// The ordinary outcome, and not an error: there is nothing to record.
		t.Errorf("a count that agreed produced a correction of %s", correction.Amount())
	}
}

// The correction is a new record of what was found, never an edit to what was
// believed (§41).
func TestACorrectionMovesTheAccountToWhatWasCounted(t *testing.T) {
	d := newDrawer()

	reconciliation, err := finance.Reconcile(
		aBalance(d.account, 245_500, 12), money.FromXAF(240_500), countedAt)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	correction, err := reconciliation.Correction(
		d.snapshot(finance.Adjustment, 1), "manque constaté au comptage du soir")
	if err != nil {
		t.Fatalf("Correction: %v", err)
	}
	if correction == nil {
		t.Fatal("a drawer 5,000 short produced no correction")
	}
	if got := correction.Amount().Amount(); got != -5_000 {
		t.Errorf("correction = %d, want -5000", got)
	}
	if correction.Type() != finance.Adjustment {
		t.Errorf("type = %s, want an adjustment", correction.Type())
	}
	if correction.AccountID() != d.account {
		t.Errorf("correction is against %s, want %s", correction.AccountID(), d.account)
	}
	// Months later the only thing that explains it is what the person wrote.
	if correction.Reason() != "manque constaté au comptage du soir" {
		t.Errorf("reason = %q", correction.Reason())
	}
	// And applying it makes the books agree with the drawer.
	after, err := money.FromXAF(245_500).Add(correction.Amount())
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if after.Amount() != 240_500 {
		t.Errorf("after the correction the account holds %s, want what was counted", after)
	}
}

// A drawer holding more than the system knows about is corrected upward, and is
// just as much worth recording: it usually means a sale nobody rang up.
func TestACountFindingMoreIsCorrectedUpward(t *testing.T) {
	d := newDrawer()

	reconciliation, err := finance.Reconcile(
		aBalance(d.account, 240_500, 12), money.FromXAF(245_500), countedAt)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if !reconciliation.IsOver() {
		t.Errorf("difference = %s, want a surplus", reconciliation.Difference)
	}

	correction, err := reconciliation.Correction(d.snapshot(finance.Adjustment, 1), "excédent")
	if err != nil {
		t.Fatalf("Correction: %v", err)
	}
	if correction == nil || correction.Amount().Amount() != 5_000 {
		t.Errorf("correction = %v, want +5000", correction)
	}
}

// A correction with nothing written on it is refused, because an adjustment is
// money appearing or vanishing with no event behind it (§39).
func TestACorrectionNeedsAReason(t *testing.T) {
	d := newDrawer()

	reconciliation, err := finance.Reconcile(
		aBalance(d.account, 245_500, 12), money.FromXAF(240_500), countedAt)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if _, err := reconciliation.Correction(d.snapshot(finance.Adjustment, 1), "  "); !errors.Is(err, finance.ErrMissingReason) {
		t.Errorf("got %v, want ErrMissingReason", err)
	}
}

// An account nothing has moved through holds nothing, which is a balance of
// zero rather than no answer at all.
func TestCountingAnAccountThatHasNeverMoved(t *testing.T) {
	d := newDrawer()

	empty := finance.Balance{AccountID: d.account}
	if !empty.IsEmpty() {
		t.Error("an account nothing moved through does not read as empty")
	}

	reconciliation, err := finance.Reconcile(empty, money.FromXAF(5_000), countedAt)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if reconciliation.Expected.Amount() != 0 || reconciliation.Expected.Currency() != money.XAF {
		t.Errorf("expected = %s, want zero francs", reconciliation.Expected)
	}
	if reconciliation.Difference.Amount() != 5_000 {
		t.Errorf("difference = %s, want the whole count", reconciliation.Difference)
	}
}

// A till reading below zero is a real thing — a payment recorded that never
// happened, cash taken with no movement written — and the honest answer is the
// negative number, which is what makes someone go and look.
func TestAnOverdrawnAccountSaysSo(t *testing.T) {
	d := newDrawer()

	overdrawn := aBalance(d.account, -5_000, 3)
	if !overdrawn.IsOverdrawn() {
		t.Error("an account 5,000 below zero does not read as overdrawn")
	}
	if overdrawn.IsEmpty() {
		t.Error("an overdrawn account read as empty")
	}

	// And "empty because nothing happened" is not "empty because it was
	// emptied": the count of movements tells them apart.
	untouched := finance.Balance{AccountID: d.account}
	emptied := aBalance(d.account, 0, 4)
	if untouched.Movements != 0 || emptied.Movements == 0 {
		t.Error("the two kinds of empty cannot be told apart")
	}
	if !emptied.IsEmpty() || !untouched.IsEmpty() {
		t.Error("both should read as holding nothing")
	}
}

func TestAnUncountableReconciliationIsRefused(t *testing.T) {
	d := newDrawer()
	balance := aBalance(d.account, 245_500, 12)

	if _, err := finance.Reconcile(finance.Balance{}, money.FromXAF(1), countedAt); !errors.Is(err, finance.ErrInvalidID) {
		t.Errorf("a count of no account was accepted: %v", err)
	}
	if _, err := finance.Reconcile(balance, money.Money{}, countedAt); !errors.Is(err, finance.ErrInvalidAmount) {
		t.Errorf("a count with no currency was accepted: %v", err)
	}
	if _, err := finance.Reconcile(balance, money.FromXAF(-1), countedAt); !errors.Is(err, finance.ErrInvalidAmount) {
		t.Errorf("a count of less than nothing was accepted: %v", err)
	}
	if _, err := finance.Reconcile(balance, money.FromXAF(1), time.Time{}); !errors.Is(err, finance.ErrInvalidAmount) {
		t.Errorf("a count at no moment was accepted: %v", err)
	}

	euros, err := money.New(240_500, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	if _, err := finance.Reconcile(balance, euros, countedAt); !errors.Is(err, finance.ErrInvalidCurrency) {
		t.Errorf("a franc account was counted in euros: %v", err)
	}
}

// The count's own moment is when the correction happened, unless the caller
// says otherwise.
func TestACorrectionHappensWhenTheCountDid(t *testing.T) {
	d := newDrawer()

	reconciliation, err := finance.Reconcile(
		aBalance(d.account, 245_500, 12), money.FromXAF(240_500), countedAt)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	snapshot := d.snapshot(finance.Adjustment, 1)
	snapshot.OccurredAt = time.Time{}
	snapshot.RecordedAt = countedAt.Add(time.Hour)
	correction, err := reconciliation.Correction(snapshot, "manque")
	if err != nil {
		t.Fatalf("Correction: %v", err)
	}
	if !correction.OccurredAt().Equal(countedAt) {
		t.Errorf("the correction happened at %s, want the count's %s",
			correction.OccurredAt(), countedAt)
	}
}
