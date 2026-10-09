package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/expenses"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// expenseFixture is a business with somewhere for money to come out of.
type expenseFixture struct {
	*cashFixture
	repo *postgres.ExpenseRepository
}

func newExpenseFixture(t *testing.T) *expenseFixture {
	t.Helper()

	base := newCashFixture(t)
	return &expenseFixture{cashFixture: base, repo: postgres.NewExpenseRepository(base.pool)}
}

func (f *expenseFixture) expense(
	t *testing.T, category expenses.Category, minor int64,
	mutate ...func(*expenses.Snapshot),
) *expenses.Expense {
	t.Helper()

	snapshot := expenses.Snapshot{
		ID:         expenses.NewID(),
		BusinessID: f.tenant,
		Category:   category,
		AccountID:  f.account,
		Amount:     money.FromXAF(minor),
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	}
	if category.NeedsDescription() {
		snapshot.Description = "réparation du congélateur"
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	expense, err := expenses.Record(snapshot)
	if err != nil {
		t.Fatalf("expenses.Record(%s): %v", category, err)
	}
	return expense
}

func (f *expenseFixture) spend(
	t *testing.T, category expenses.Category, minor int64,
	mutate ...func(*expenses.Snapshot),
) *expenses.Expense {
	t.Helper()

	expense := f.expense(t, category, minor, mutate...)
	if err := f.repo.Record(f.ctx, f.scope, expense); err != nil {
		t.Fatalf("Record: %v", err)
	}
	return expense
}

func TestAnExpenseTakesMoneyOutOfItsAccount(t *testing.T) {
	f := newExpenseFixture(t)

	f.record(t, finance.OpeningBalance, 100_000)
	f.spend(t, expenses.Rent, 50_000, func(s *expenses.Snapshot) { s.Description = "loyer d'août" })

	// The fourth arm of the balance: money the business spent is money the
	// account no longer holds.
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(50_000)) {
		t.Errorf("on hand = %s, want 50000 after the rent", got)
	}
}

func TestAnExpenseRoundTripsThroughStorage(t *testing.T) {
	f := newExpenseFixture(t)

	recorded := f.spend(t, expenses.Transport, 15_000, func(s *expenses.Snapshot) {
		s.Description = "moto pour la livraison"
		s.Reference = "REC-0012"
	})

	loaded, err := f.repo.Get(f.ctx, f.scope, recorded.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != recorded.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), recorded.Snapshot())
	}
}

// A correction is another row, so the day's cash still shows the mistake was
// made and put right (§41).
func TestAnExpenseIsUndoneByAReversal(t *testing.T) {
	f := newExpenseFixture(t)

	f.record(t, finance.OpeningBalance, 100_000)
	original := f.spend(t, expenses.Transport, 15_000)

	reversal, err := original.Reverse(expenses.Snapshot{
		ID:         expenses.NewID(),
		UserID:     f.user,
		DeviceID:   f.till,
		RecordedAt: soldAt.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatalf("Reverse: %v", err)
	}
	if err := f.repo.Record(f.ctx, f.scope, reversal); err != nil {
		t.Fatalf("recording the reversal: %v", err)
	}

	// The money is back where it came from.
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(100_000)) {
		t.Errorf("on hand = %s, want the money back", got)
	}

	// And both rows are still there, which is what shows the mistake happened.
	spent, err := f.repo.Between(f.ctx, f.scope, soldAt.Add(-time.Hour), soldAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(spent) != 2 {
		t.Fatalf("the period holds %d expenses, want the cost and its reversal", len(spent))
	}
	total, err := expenses.Total(spent)
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if !total.IsZero() {
		t.Errorf("a reversed expense still cost %s", total)
	}
}

// An expense is undone once. A second reversal would take the money off the
// books twice.
func TestAnExpenseIsReversedOnlyOnce(t *testing.T) {
	f := newExpenseFixture(t)

	original := f.spend(t, expenses.Rent, 50_000)
	first, err := original.Reverse(expenses.Snapshot{
		ID: expenses.NewID(), UserID: f.user, DeviceID: f.till, RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("Reverse: %v", err)
	}
	if err := f.repo.Record(f.ctx, f.scope, first); err != nil {
		t.Fatalf("recording the reversal: %v", err)
	}

	second, err := original.Reverse(expenses.Snapshot{
		ID: expenses.NewID(), UserID: f.user, DeviceID: f.till, RecordedAt: soldAt.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatalf("Reverse: %v", err)
	}
	if err := f.repo.Record(f.ctx, f.scope, second); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// A reversal of an expense nobody recorded is money coming back from nowhere.
func TestAReversalMustNameAnExpenseThatExists(t *testing.T) {
	f := newExpenseFixture(t)

	stray := f.expense(t, expenses.Rent, -50_000, func(s *expenses.Snapshot) {
		s.Reverses = expenses.NewID()
	})
	if err := f.repo.Record(f.ctx, f.scope, stray); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// §19's report: what a month cost, by category, with the reversals cancelling
// what they undid.
func TestWhatAPeriodCostByCategory(t *testing.T) {
	f := newExpenseFixture(t)

	f.spend(t, expenses.Rent, 50_000)
	f.spend(t, expenses.Transport, 15_000)
	f.spend(t, expenses.Transport, 5_000)
	mistake := f.spend(t, expenses.Marketing, 30_000)

	reversal, err := mistake.Reverse(expenses.Snapshot{
		ID: expenses.NewID(), UserID: f.user, DeviceID: f.till, RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("Reverse: %v", err)
	}
	if err := f.repo.Record(f.ctx, f.scope, reversal); err != nil {
		t.Fatalf("recording the reversal: %v", err)
	}

	totals, err := f.repo.TotalsByCategory(
		f.ctx, f.scope, soldAt.Add(-time.Hour), soldAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("TotalsByCategory: %v", err)
	}
	if len(totals) != 3 {
		t.Fatalf("got %d categories, want rent, transport and marketing: %+v", len(totals), totals)
	}

	// Largest first, which is the order an owner reads.
	if totals[0].Category != expenses.Rent || totals[0].Total.Amount() != 50_000 {
		t.Errorf("first = %+v, want rent at 50000", totals[0])
	}
	if totals[1].Category != expenses.Transport || totals[1].Total.Amount() != 20_000 {
		t.Errorf("second = %+v, want transport at 20000", totals[1])
	}
	// The reversed one nets to nothing but is still listed: two entries that
	// cancel are not the same as a category nobody used.
	if totals[2].Category != expenses.Marketing || !totals[2].Total.IsZero() {
		t.Errorf("third = %+v, want marketing at nothing", totals[2])
	}
	if totals[2].Count != 2 {
		t.Errorf("marketing came from %d entries, want the cost and its reversal", totals[2].Count)
	}
}

// A phone that recorded Monday's transport on Friday still spent it on Monday,
// and a month's costs must not move because a device was slow to sync.
func TestAPeriodCountsWhenTheMoneyWasSpent(t *testing.T) {
	f := newExpenseFixture(t)

	f.spend(t, expenses.Transport, 15_000, func(s *expenses.Snapshot) {
		s.OccurredAt = soldAt.Add(-48 * time.Hour)
		s.RecordedAt = soldAt.Add(time.Hour)
	})

	inside, err := f.repo.Between(f.ctx, f.scope, soldAt.Add(-72*time.Hour), soldAt.Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(inside) != 1 {
		t.Errorf("the period it was spent in holds %d expenses, want 1", len(inside))
	}

	outside, err := f.repo.Between(f.ctx, f.scope, soldAt, soldAt.Add(24*time.Hour))
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(outside) != 0 {
		t.Errorf("the period it was recorded in holds %d expenses, want none", len(outside))
	}
}

func TestExpensesAreAppendOnlyEvenInRawSQL(t *testing.T) {
	f := newExpenseFixture(t)

	expense := f.spend(t, expenses.Rent, 50_000)

	if _, err := f.pool.Exec(f.ctx,
		`UPDATE expenses SET amount_minor = 1 WHERE id = $1`, expense.ID().ID()); err == nil {
		t.Error("an expense was edited in place")
	}
	if _, err := f.pool.Exec(f.ctx,
		`DELETE FROM expenses WHERE id = $1`, expense.ID().ID()); err == nil {
		t.Error("an expense was deleted")
	}
}

func TestAnotherBusinessesExpensesAreInvisible(t *testing.T) {
	f, other := newExpenseFixture(t), newExpenseFixture(t)

	theirs := other.spend(t, expenses.Rent, 50_000)

	if _, err := f.repo.Get(f.ctx, f.scope, theirs.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	mine, err := f.repo.Between(f.ctx, f.scope, soldAt.Add(-time.Hour), soldAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(mine) != 0 {
		t.Errorf("read %d of another business's expenses", len(mine))
	}

	stray := other.expense(t, expenses.Rent, 5_000)
	if err := f.repo.Record(f.ctx, f.scope, stray); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

// An expense naming an account nobody opened would leave the business poorer
// with no drawer any lighter.
func TestAnExpenseCannotNameAnAccountThatDoesNotExist(t *testing.T) {
	f := newExpenseFixture(t)

	stray := f.expense(t, expenses.Rent, 50_000, func(s *expenses.Snapshot) {
		s.AccountID = finance.NewAccountID()
	})
	if err := f.repo.Record(f.ctx, f.scope, stray); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

func TestExpenseOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newExpenseFixture(t)
	expense := f.expense(t, expenses.Rent, 50_000)
	var none business.Scope

	operations := map[string]func() error{
		"Record": func() error { return f.repo.Record(f.ctx, none, expense) },
		"Get":    func() error { _, err := f.repo.Get(f.ctx, none, expense.ID()); return err },
		"Between": func() error {
			_, err := f.repo.Between(f.ctx, none, soldAt, soldAt.Add(time.Hour))
			return err
		},
		"TotalsByCategory": func() error {
			_, err := f.repo.TotalsByCategory(f.ctx, none, soldAt, soldAt.Add(time.Hour))
			return err
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestExpenseLookupsThatCannotBeAnsweredFail(t *testing.T) {
	f := newExpenseFixture(t)

	if err := f.repo.Record(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Record: got %v, want ErrQuery", err)
	}
	if _, err := f.repo.Get(f.ctx, f.scope, expenses.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("Get: got %v, want ErrNotFound", err)
	}
	if _, err := f.repo.Between(f.ctx, f.scope, time.Time{}, soldAt); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Between with no start: got %v, want ErrQuery", err)
	}
	if _, err := f.repo.Between(f.ctx, f.scope, soldAt, soldAt.Add(-time.Hour)); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("a period that ends before it starts: got %v, want ErrQuery", err)
	}
	if _, err := f.repo.TotalsByCategory(f.ctx, f.scope, time.Time{}, soldAt); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("TotalsByCategory with no start: got %v, want ErrQuery", err)
	}
}

// ADR-013: a row the schema allows but the domain does not is refused on the
// way in.
func TestReadingAnExpenseWithAnUnknownCurrencyFails(t *testing.T) {
	f := newExpenseFixture(t)

	expenseID := expenses.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO expenses
			(id, business_id, category, account_id, amount_minor, currency,
			 user_id, device_id, occurred_at, recorded_at)
		VALUES ($1, $2, 'RENT', $3, 50000, 'ZZZ', $4, $5, $6, $6)`,
		expenseID.ID(), f.tenant.ID(), f.account.ID(), f.user.ID(), f.till.ID(), soldAt)
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, expenseID); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Get: got %v, want ErrQuery", err)
	}
	if _, err := f.repo.Between(f.ctx, f.scope, soldAt.Add(-24*time.Hour), soldAt.Add(24*time.Hour)); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Between: got %v, want ErrQuery", err)
	}
	if _, err := f.repo.TotalsByCategory(f.ctx, f.scope, soldAt.Add(-24*time.Hour), soldAt.Add(24*time.Hour)); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("TotalsByCategory: got %v, want ErrQuery", err)
	}
}

func TestExpenseOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewExpenseRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	expense, err := expenses.Record(expenses.Snapshot{
		ID:         expenses.NewID(),
		BusinessID: tenant,
		Category:   expenses.Rent,
		AccountID:  finance.NewAccountID(),
		Amount:     money.FromXAF(50_000),
		UserID:     users.NewID(),
		DeviceID:   devices.NewID(),
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("expenses.Record: %v", err)
	}

	operations := map[string]func() error{
		"Record":  func() error { return repo.Record(ctx, scope, expense) },
		"Get":     func() error { _, err := repo.Get(ctx, scope, expense.ID()); return err },
		"Between": func() error { _, err := repo.Between(ctx, scope, createdAt, createdAt.Add(time.Hour)); return err },
		"TotalsByCategory": func() error {
			_, err := repo.TotalsByCategory(ctx, scope, createdAt, createdAt.Add(time.Hour))
			return err
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}
