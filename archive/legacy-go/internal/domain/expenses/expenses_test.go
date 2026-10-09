package expenses_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/expenses"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

var (
	spentAt    = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	recordedAt = time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)
)

// books is a business with somewhere for money to come out of.
type books struct {
	businessID business.ID
	accountID  finance.AccountID
	userID     users.ID
	deviceID   devices.ID
}

func newBooks() *books {
	return &books{
		businessID: business.NewID(),
		accountID:  finance.NewAccountID(),
		userID:     users.NewID(),
		deviceID:   devices.NewID(),
	}
}

func (b *books) snapshot(category expenses.Category, minor int64) expenses.Snapshot {
	snapshot := expenses.Snapshot{
		ID:         expenses.NewID(),
		BusinessID: b.businessID,
		Category:   category,
		AccountID:  b.accountID,
		Amount:     money.FromXAF(minor),
		UserID:     b.userID,
		DeviceID:   b.deviceID,
		OccurredAt: spentAt,
		RecordedAt: recordedAt,
	}
	if category.NeedsDescription() {
		snapshot.Description = "réparation du congélateur"
	}
	return snapshot
}

func (b *books) expense(
	t *testing.T, category expenses.Category, minor int64,
	mutate ...func(*expenses.Snapshot),
) *expenses.Expense {
	t.Helper()

	snapshot := b.snapshot(category, minor)
	for _, change := range mutate {
		change(&snapshot)
	}

	expense, err := expenses.Record(snapshot)
	if err != nil {
		t.Fatalf("Record(%s): %v", category, err)
	}
	return expense
}

func TestAnExpenseRoundTrips(t *testing.T) {
	b := newBooks()

	expense := b.expense(t, expenses.Rent, 50_000, func(s *expenses.Snapshot) {
		s.BranchID = business.NewBranchID()
		s.Description = "loyer d'août"
		s.Reference = "REC-0012"
	})

	restored, err := expenses.Restore(expense.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Snapshot() != expense.Snapshot() {
		t.Errorf("restored %+v, want %+v", restored.Snapshot(), expense.Snapshot())
	}
	if restored.Scope() != expense.Scope() {
		t.Errorf("Scope = %v, want %v", restored.Scope(), expense.Scope())
	}
	if expense.IsReversal() {
		t.Error("a cost read as a reversal")
	}
	if expense.AccountID() != b.accountID {
		t.Errorf("came out of %s, want %s", expense.AccountID(), b.accountID)
	}
	if expense.Reference() != "REC-0012" || expense.Description() != "loyer d'août" {
		t.Errorf("kept %q and %q", expense.Reference(), expense.Description())
	}
	if expense.UserID() != b.userID || expense.DeviceID() != b.deviceID {
		t.Error("the expense lost who recorded it")
	}
	if !expense.OccurredAt().Equal(spentAt) || !expense.RecordedAt().Equal(recordedAt) {
		t.Error("the expense lost when it happened")
	}
	if expense.BusinessID() != b.businessID {
		t.Errorf("BusinessID = %s", expense.BusinessID())
	}
	if expense.BranchID() != expense.Snapshot().BranchID || expense.BranchID().IsZero() {
		t.Errorf("BranchID = %s, want the branch it was spent at", expense.BranchID())
	}
}

// "OTHER, 15,000" is the line an owner stares at in a month's report with no way
// to find out what it was.
func TestOtherNeedsToSayWhatItWas(t *testing.T) {
	b := newBooks()

	snapshot := b.snapshot(expenses.Other, 15_000)
	snapshot.Description = "   "
	if _, err := expenses.Record(snapshot); !errors.Is(err, expenses.ErrMissingDescription) {
		t.Errorf("got %v, want ErrMissingDescription", err)
	}

	// Every other category says it on its own.
	for _, category := range expenses.Categories() {
		if category.NeedsDescription() {
			continue
		}
		if _, err := expenses.Record(b.snapshot(category, 5_000)); err != nil {
			t.Errorf("%s was refused for want of a description: %v", category, err)
		}
	}
}

// A correction is another row, so the day's cash still shows the mistake was
// made and put right (§41).
func TestAnExpenseIsUndoneByAReversal(t *testing.T) {
	b := newBooks()

	original := b.expense(t, expenses.Transport, 15_000, func(s *expenses.Snapshot) {
		s.Description = "moto pour la livraison"
	})

	reversal, err := original.Reverse(expenses.Snapshot{
		ID:         expenses.NewID(),
		UserID:     b.userID,
		DeviceID:   b.deviceID,
		RecordedAt: recordedAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("Reverse: %v", err)
	}

	if !reversal.IsReversal() {
		t.Error("a reversal does not read as one")
	}
	if undone, _ := reversal.Reverses(); undone != original.ID() {
		t.Errorf("it undoes %s, want %s", undone, original.ID())
	}
	if got := reversal.Amount().Amount(); got != -15_000 {
		t.Errorf("reversal = %d, want -15000", got)
	}
	// It has to land back where the money came from to be worth anything.
	if reversal.AccountID() != original.AccountID() || reversal.Category() != original.Category() {
		t.Error("the reversal went somewhere other than where the money did")
	}
	// And it inherits what the original said, so a report reads as a pair.
	if reversal.Description() != original.Description() {
		t.Errorf("description = %q, want the original's", reversal.Description())
	}
	if !reversal.OccurredAt().Equal(original.OccurredAt()) {
		t.Error("the reversal happened at a different time from what it undoes")
	}

	// Together they cost nothing, by plain addition.
	total, err := expenses.Total([]*expenses.Expense{original, reversal})
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if !total.IsZero() {
		t.Errorf("a reversed expense still costs %s", total)
	}
}

func TestAReversalCannotBeReversed(t *testing.T) {
	b := newBooks()

	original := b.expense(t, expenses.Rent, 50_000)
	reversal, err := original.Reverse(expenses.Snapshot{
		ID: expenses.NewID(), UserID: b.userID, DeviceID: b.deviceID, RecordedAt: recordedAt,
	})
	if err != nil {
		t.Fatalf("Reverse: %v", err)
	}

	// Undoing an undoing is a way of recording the same cost twice with nothing
	// naming it a cost.
	if _, err := reversal.Reverse(expenses.Snapshot{
		ID: expenses.NewID(), UserID: b.userID, DeviceID: b.deviceID, RecordedAt: recordedAt,
	}); !errors.Is(err, expenses.ErrInvalidReversal) {
		t.Errorf("got %v, want ErrInvalidReversal", err)
	}
}

// Money appearing in the accounts with no explanation is the shape of a mistake
// nobody can trace.
func TestANegativeExpenseMustSayWhatItUndoes(t *testing.T) {
	b := newBooks()

	if _, err := expenses.Record(b.snapshot(expenses.Rent, -50_000)); !errors.Is(err, expenses.ErrInvalidReversal) {
		t.Errorf("got %v, want ErrInvalidReversal", err)
	}

	// And a cost cannot also claim to be a reversal.
	claiming := b.snapshot(expenses.Rent, 50_000)
	claiming.Reverses = expenses.NewID()
	if _, err := expenses.Record(claiming); !errors.Is(err, expenses.ErrInvalidReversal) {
		t.Errorf("got %v, want ErrInvalidReversal", err)
	}

	itself := b.snapshot(expenses.Rent, -50_000)
	itself.Reverses = itself.ID
	if _, err := expenses.Record(itself); !errors.Is(err, expenses.ErrInvalidReversal) {
		t.Errorf("an expense reversed itself: %v", err)
	}
}

func TestAnExpenseThatCannotExistIsRefused(t *testing.T) {
	b := newBooks()

	for _, testCase := range []struct {
		name   string
		change func(*expenses.Snapshot)
		want   error
	}{
		{"no identifier", func(s *expenses.Snapshot) { s.ID = expenses.ID{} }, expenses.ErrInvalidID},
		{"no business", func(s *expenses.Snapshot) { s.BusinessID = business.ID{} }, expenses.ErrInvalidID},
		{"no account", func(s *expenses.Snapshot) { s.AccountID = finance.AccountID{} }, expenses.ErrInvalidID},
		{"no user", func(s *expenses.Snapshot) { s.UserID = users.ID{} }, expenses.ErrInvalidID},
		{"no device", func(s *expenses.Snapshot) { s.DeviceID = devices.ID{} }, expenses.ErrInvalidID},
		{"no category", func(s *expenses.Snapshot) { s.Category = "" }, expenses.ErrInvalidCategory},
		{"a category this build does not know", func(s *expenses.Snapshot) { s.Category = "BRIBE" }, expenses.ErrInvalidCategory},
		{"no amount", func(s *expenses.Snapshot) { s.Amount = money.Money{} }, expenses.ErrInvalidAmount},
		{"an expense of nothing", func(s *expenses.Snapshot) { s.Amount = money.FromXAF(0) }, expenses.ErrInvalidAmount},
		{"recorded before it happened", func(s *expenses.Snapshot) {
			s.RecordedAt = s.OccurredAt.Add(-time.Second)
		}, validate.ErrInvalidTime},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := b.snapshot(expenses.Rent, 50_000)
			testCase.change(&snapshot)
			if _, err := expenses.Record(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("got %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestTotallingExpenses(t *testing.T) {
	b := newBooks()

	if total, err := expenses.Total(nil); err != nil || total.Valid() {
		t.Errorf("Total of nothing = %s, %v: want no answer at all", total, err)
	}

	spent := []*expenses.Expense{
		b.expense(t, expenses.Rent, 50_000),
		b.expense(t, expenses.Transport, 15_000),
		b.expense(t, expenses.Electricity, 8_500),
	}
	total, err := expenses.Total(spent)
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if got := total.Amount(); got != 73_500 {
		t.Errorf("total = %d, want 73500", got)
	}

	if _, err := expenses.Total([]*expenses.Expense{nil}); !errors.Is(err, expenses.ErrInvalidID) {
		t.Errorf("got %v, want ErrInvalidID", err)
	}

	// A ledger that mixed currencies could not be totalled, and there is nothing
	// sensible to do with one but refuse it (ADR-010).
	euros := b.snapshot(expenses.Rent, 0)
	amount, err := money.New(50_000, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	euros.Amount = amount
	foreign, err := expenses.Record(euros)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if _, err := expenses.Total([]*expenses.Expense{spent[0], foreign}); !errors.Is(err, expenses.ErrInvalidAmount) {
		t.Errorf("got %v, want ErrInvalidAmount", err)
	}
}

func TestParsingACategory(t *testing.T) {
	for _, category := range expenses.Categories() {
		parsed, err := expenses.ParseCategory(category.String())
		if err != nil || parsed != category {
			t.Errorf("ParseCategory(%s) = %s, %v", category, parsed, err)
		}
	}
	if _, err := expenses.ParseCategory("BRIBE"); !errors.Is(err, expenses.ErrInvalidCategory) {
		t.Errorf("got %v, want ErrInvalidCategory", err)
	}
}

func TestExpenseIdentifiers(t *testing.T) {
	raw := expenses.NewID()
	parsed, err := expenses.ParseID(raw.String())
	if err != nil || parsed != raw {
		t.Errorf("ParseID round trip: %s, %v", parsed, err)
	}
	if expenses.IDFrom(raw.ID()) != raw {
		t.Error("IDFrom did not return the same identifier")
	}
	if _, err := expenses.ParseID("not-an-identifier"); err == nil {
		t.Error("a malformed identifier parsed")
	}
}

// The boundary the arithmetic actually has: the most negative amount has no
// positive counterpart, so a reversal of it cannot be made rather than wrapping
// round into a cost.
func TestReversingAtTheEdgeOfTheArithmetic(t *testing.T) {
	b := newBooks()

	// Recorded through Restore, since no ordinary path produces it.
	snapshot := b.snapshot(expenses.Rent, 0)
	snapshot.Amount = money.FromXAF(-9_223_372_036_854_775_808)
	snapshot.Reverses = expenses.NewID()
	extreme, err := expenses.Restore(snapshot)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	// The arithmetic refuses it before any rule does: there is no positive
	// counterpart to negate it into.
	if _, err := extreme.Reverse(expenses.Snapshot{
		ID: expenses.NewID(), UserID: b.userID, DeviceID: b.deviceID, RecordedAt: recordedAt,
	}); !errors.Is(err, expenses.ErrInvalidAmount) {
		t.Errorf("got %v, want ErrInvalidAmount", err)
	}

	// A cost of the most negative amount cannot exist at all, which is what
	// keeps Reverse's arithmetic from ever meeting it.
	cost := b.snapshot(expenses.Rent, -9_223_372_036_854_775_808)
	if _, err := expenses.Record(cost); !errors.Is(err, expenses.ErrInvalidReversal) {
		t.Errorf("got %v, want a refusal", err)
	}
}
