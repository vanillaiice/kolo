package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// cashFixture is a business with a till, a wallet, and everything needed to move
// money between them.
type cashFixture struct {
	*saleFixture
	movements *postgres.AccountMovementRepository
	wallet    finance.AccountID
}

func newCashFixture(t *testing.T) *cashFixture {
	t.Helper()

	base := newSaleFixture(t)
	return &cashFixture{
		saleFixture: base,
		movements:   postgres.NewAccountMovementRepository(base.pool),
		wallet:      openAccount(t, base.pool, base.ctx, base.scope, base.tenant, "MTN Mobile Money"),
	}
}

func (f *cashFixture) movement(
	t *testing.T, kind finance.MovementType, minor int64,
	mutate ...func(*finance.MovementSnapshot),
) *finance.Movement {
	t.Helper()

	snapshot := finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  f.account,
		BusinessID: f.tenant,
		Type:       kind,
		Amount:     money.FromXAF(minor),
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	}
	if kind.RequiresReason() {
		snapshot.Reason = "porté à la banque"
	}
	if kind.IsTransfer() {
		snapshot.CounterpartID = f.wallet
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	movement, err := finance.RecordMovement(snapshot)
	if err != nil {
		t.Fatalf("RecordMovement(%s): %v", kind, err)
	}
	return movement
}

func (f *cashFixture) record(
	t *testing.T, kind finance.MovementType, minor int64,
	mutate ...func(*finance.MovementSnapshot),
) *finance.Movement {
	t.Helper()

	movement := f.movement(t, kind, minor, mutate...)
	if err := f.movements.Record(f.ctx, f.scope, movement); err != nil {
		t.Fatalf("Record: %v", err)
	}
	return movement
}

func (f *cashFixture) balance(t *testing.T, account finance.AccountID) finance.Balance {
	t.Helper()

	balance, err := f.movements.BalanceOf(f.ctx, f.scope, account)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	return balance
}

// The property the whole design turns on: what is in the drawer is the sum of
// every source that moved money, each recorded once where it happened.
func TestABalanceSumsEverySourceOfMoney(t *testing.T) {
	f := newCashFixture(t)

	// The float put in at opening.
	f.record(t, finance.OpeningBalance, 50_000)

	// A sale paid into the till.
	sale := f.sale(t)
	if err := f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{f.payment(t, sale, 13_000)}, nil, nil); err != nil {
		t.Fatalf("recording a sale: %v", err)
	}

	// A customer settling an old debt, in cash.
	customerID := f.customer(t, "Jean Mbarga")
	payment, err := customers.RecordTransaction(customers.TransactionSnapshot{
		ID:         customers.NewTransactionID(),
		CustomerID: customerID,
		BusinessID: f.tenant,
		Type:       customers.Payment,
		Amount:     money.FromXAF(-8_000),
		AccountID:  f.account,
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("RecordTransaction: %v", err)
	}
	if err := postgres.NewCreditRepository(f.pool).Record(f.ctx, f.scope, payment); err != nil {
		t.Fatalf("recording the customer payment: %v", err)
	}

	// And cash carried to the bank.
	f.record(t, finance.CashOut, -20_000)

	// 50,000 + 13,000 + 8,000 − 20,000.
	balance := f.balance(t, f.account)
	if got := balance.OnHand; !got.Equal(money.FromXAF(51_000)) {
		t.Errorf("on hand = %s, want 51000 XAF", got)
	}
	if balance.Movements != 4 {
		t.Errorf("movements = %d, want all four sources counted", balance.Movements)
	}
	if balance.LastMovedAt.IsZero() {
		t.Error("a balance that moved has no last movement")
	}
}

// §18's worked example, against the database: expected 245,500, counted
// 240,500, and the correction that makes the books agree with the drawer.
func TestCountingTheDrawerAndCorrectingIt(t *testing.T) {
	f := newCashFixture(t)

	f.record(t, finance.OpeningBalance, 245_500)

	reconciliation, err := finance.Reconcile(
		f.balance(t, f.account), money.FromXAF(240_500), soldAt.Add(8*time.Hour))
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := reconciliation.Difference.Amount(); got != -5_000 {
		t.Errorf("difference = %d, want -5000", got)
	}

	correction, err := reconciliation.Correction(
		f.movement(t, finance.Adjustment, 1).Snapshot(), "manque constaté au comptage")
	if err != nil {
		t.Fatalf("Correction: %v", err)
	}
	if err := f.movements.Record(f.ctx, f.scope, correction); err != nil {
		t.Fatalf("recording the correction: %v", err)
	}

	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(240_500)) {
		t.Errorf("on hand = %s, want what was counted", got)
	}

	// And the shortfall is still visible: the correction is a record of what was
	// found, not an edit to what was believed (§41).
	movements, err := f.movements.ListForAccount(f.ctx, f.scope, f.account)
	if err != nil {
		t.Fatalf("ListForAccount: %v", err)
	}
	if len(movements) != 2 {
		t.Fatalf("the account holds %d movements, want the float and the correction", len(movements))
	}
	if movements[1].Reason() == "" {
		t.Error("the correction says nothing about why")
	}
}

// A transfer is two rows landing together. Half of one is money genuinely lost.
func TestATransferMovesMoneyBetweenTwoAccounts(t *testing.T) {
	f := newCashFixture(t)

	f.record(t, finance.OpeningBalance, 50_000)

	out, in, err := finance.Transfer(
		f.movement(t, finance.CashOut, -20_000).Snapshot(),
		finance.MovementSnapshot{
			ID:         finance.NewMovementID(),
			AccountID:  f.wallet,
			BusinessID: f.tenant,
			UserID:     f.user,
			DeviceID:   f.till,
			OccurredAt: soldAt,
			RecordedAt: soldAt.Add(time.Hour),
		})
	if err != nil {
		t.Fatalf("Transfer: %v", err)
	}
	if err := f.movements.RecordTransfer(f.ctx, f.scope, out, in); err != nil {
		t.Fatalf("RecordTransfer: %v", err)
	}

	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(30_000)) {
		t.Errorf("the till holds %s, want 30000", got)
	}
	if got := f.balance(t, f.wallet).OnHand; !got.Equal(money.FromXAF(20_000)) {
		t.Errorf("the wallet holds %s, want 20000", got)
	}
}

func TestHalfATransferIsNotRecorded(t *testing.T) {
	f := newCashFixture(t)

	f.record(t, finance.OpeningBalance, 50_000)
	leaving := f.movement(t, finance.TransferOut, -20_000)

	// An arriving half naming an account that does not exist: the database
	// refuses it, and the money must not have left either.
	arriving := f.movement(t, finance.TransferIn, 20_000, func(s *finance.MovementSnapshot) {
		s.AccountID = finance.NewAccountID()
		s.CounterpartID = f.account
	})
	if err := f.movements.RecordTransfer(f.ctx, f.scope, leaving, arriving); err == nil {
		t.Fatal("a transfer into an account that does not exist was recorded")
	}

	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(50_000)) {
		t.Errorf("the till holds %s: half a transfer landed", got)
	}
}

func TestATransferMustNameBothEnds(t *testing.T) {
	f := newCashFixture(t)

	leaving := f.movement(t, finance.TransferOut, -20_000)
	arriving := f.movement(t, finance.TransferIn, 20_000, func(s *finance.MovementSnapshot) {
		s.AccountID = f.wallet
		// Naming a third account rather than where the money came from.
		s.CounterpartID = finance.NewAccountID()
	})

	if err := f.movements.RecordTransfer(f.ctx, f.scope, leaving, arriving); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
	if err := f.movements.RecordTransfer(f.ctx, f.scope, nil, arriving); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("half a transfer was accepted: %v", err)
	}
}

// An account nothing has moved through holds nothing, which is not the same as
// holding zero francs.
func TestAnAccountNothingMovedThroughHasNoBalance(t *testing.T) {
	f := newCashFixture(t)

	balance := f.balance(t, f.wallet)
	if balance.Movements != 0 {
		t.Errorf("movements = %d, want none", balance.Movements)
	}
	if balance.OnHand.Valid() {
		t.Errorf("on hand carries a currency (%s) for an account nothing moved through", balance.OnHand)
	}
	if !balance.IsEmpty() || balance.IsOverdrawn() {
		t.Error("an untouched account does not read as empty")
	}
}

// A till reading below zero is a real condition and the honest answer, which is
// what makes someone go and look.
func TestAnAccountCanReadOverdrawn(t *testing.T) {
	f := newCashFixture(t)

	f.record(t, finance.OpeningBalance, 5_000)
	f.record(t, finance.CashOut, -8_000)

	balance := f.balance(t, f.account)
	if !balance.IsOverdrawn() {
		t.Errorf("on hand = %s, want an overdrawn account", balance.OnHand)
	}
}

// Money moved on a till that was offline lands on the day it moved, not the day
// the server heard, which is what keeps yesterday's cash report stable.
func TestABalanceAsOfCountsWhenTheMoneyMoved(t *testing.T) {
	f := newCashFixture(t)

	f.record(t, finance.OpeningBalance, 50_000)
	f.record(t, finance.CashOut, -20_000, func(s *finance.MovementSnapshot) {
		s.OccurredAt = soldAt.Add(48 * time.Hour)
		s.RecordedAt = soldAt.Add(49 * time.Hour)
	})

	before, err := f.movements.BalanceAsOf(f.ctx, f.scope, f.account, soldAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("BalanceAsOf: %v", err)
	}
	if got := before.OnHand; !got.Equal(money.FromXAF(50_000)) {
		t.Errorf("before the withdrawal the till held %s, want 50000", got)
	}

	if _, err := f.movements.BalanceAsOf(f.ctx, f.scope, f.account, time.Time{}); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("a balance at no moment was accepted: %v", err)
	}
}

// The ledger is append-only in the database, so a correction has to be another
// movement even for a support script.
func TestAccountMovementsRefuseAnEditEvenInRawSQL(t *testing.T) {
	f := newCashFixture(t)

	movement := f.record(t, finance.OpeningBalance, 50_000)

	if _, err := f.pool.Exec(f.ctx,
		`UPDATE account_movements SET amount_minor = 1 WHERE id = $1`, movement.ID().ID()); err == nil {
		t.Error("a movement was edited in place")
	}
	if _, err := f.pool.Exec(f.ctx,
		`DELETE FROM account_movements WHERE id = $1`, movement.ID().ID()); err == nil {
		t.Error("a movement was deleted")
	}
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(50_000)) {
		t.Errorf("on hand = %s, want the original", got)
	}
}

func TestRecordingTheSameMovementTwiceConflicts(t *testing.T) {
	f := newCashFixture(t)

	movement := f.record(t, finance.OpeningBalance, 50_000)
	if err := f.movements.Record(f.ctx, f.scope, movement); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(50_000)) {
		t.Errorf("on hand = %s, want the float counted once", got)
	}
}

func TestAnotherBusinessesMoneyIsInvisible(t *testing.T) {
	f, other := newCashFixture(t), newCashFixture(t)

	other.record(t, finance.OpeningBalance, 50_000)

	balance, err := f.movements.BalanceOf(f.ctx, f.scope, other.account)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if balance.Movements != 0 {
		t.Errorf("read %d of another business's movements", balance.Movements)
	}

	movements, err := f.movements.ListForAccount(f.ctx, f.scope, other.account)
	if err != nil {
		t.Fatalf("ListForAccount: %v", err)
	}
	if len(movements) != 0 {
		t.Errorf("listed %d of another business's movements", len(movements))
	}

	theirs := other.movement(t, finance.OpeningBalance, 1_000)
	if err := f.movements.Record(f.ctx, f.scope, theirs); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

func TestCashOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newCashFixture(t)
	movement := f.movement(t, finance.OpeningBalance, 50_000)
	var none business.Scope

	operations := map[string]func() error{
		"Record":         func() error { return f.movements.Record(f.ctx, none, movement) },
		"RecordTransfer": func() error { return f.movements.RecordTransfer(f.ctx, none, movement, movement) },
		"ListForAccount": func() error { _, err := f.movements.ListForAccount(f.ctx, none, f.account); return err },
		"BalanceOf":      func() error { _, err := f.movements.BalanceOf(f.ctx, none, f.account); return err },
		"BalanceAsOf": func() error {
			_, err := f.movements.BalanceAsOf(f.ctx, none, f.account, soldAt)
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

func TestCashLookupsWithoutAnAccountFail(t *testing.T) {
	f := newCashFixture(t)

	if _, err := f.movements.ListForAccount(f.ctx, f.scope, finance.AccountID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("ListForAccount: got %v, want ErrNotFound", err)
	}
	if _, err := f.movements.BalanceOf(f.ctx, f.scope, finance.AccountID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("BalanceOf: got %v, want ErrNotFound", err)
	}
	if err := f.movements.Record(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Record: got %v, want ErrQuery", err)
	}
}

// ADR-013: a row the schema allows but the domain does not is refused on the
// way in.
func TestReadingAnAccountMovementWithAnUnknownCurrencyFails(t *testing.T) {
	f := newCashFixture(t)

	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO account_movements
			(id, account_id, business_id, type, amount_minor, currency,
			 user_id, device_id, occurred_at, recorded_at)
		VALUES ($1, $2, $3, 'CASH_IN', 5000, 'ZZZ', $4, $5, now(), now())`,
		finance.NewMovementID().ID(), f.account.ID(), f.tenant.ID(), f.user.ID(), f.till.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.movements.ListForAccount(f.ctx, f.scope, f.account); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
	// And a balance summing two currencies is a fault rather than a total.
	f.record(t, finance.OpeningBalance, 50_000)
	if _, err := f.movements.BalanceOf(f.ctx, f.scope, f.account); !errors.Is(err, finance.ErrInvalidCurrency) {
		t.Errorf("got %v, want ErrInvalidCurrency", err)
	}
}

func TestCashOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewAccountMovementRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	accountID := finance.NewAccountID()
	movement, err := finance.RecordMovement(finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  accountID,
		BusinessID: tenant,
		Type:       finance.OpeningBalance,
		Amount:     money.FromXAF(50_000),
		UserID:     users.NewID(),
		DeviceID:   devices.NewID(),
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("RecordMovement: %v", err)
	}

	operations := map[string]func() error{
		"Record":         func() error { return repo.Record(ctx, scope, movement) },
		"ListForAccount": func() error { _, err := repo.ListForAccount(ctx, scope, accountID); return err },
		"BalanceOf":      func() error { _, err := repo.BalanceOf(ctx, scope, accountID); return err },
		"BalanceAsOf": func() error {
			_, err := repo.BalanceAsOf(ctx, scope, accountID, createdAt)
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
