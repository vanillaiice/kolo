package postgres_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// settling builds a payment against the fixture's supplier, out of its till.
func (f *purchaseFixture) settling(t *testing.T, minor int64) *suppliers.Transaction {
	t.Helper()

	transaction, err := suppliers.RecordTransaction(suppliers.TransactionSnapshot{
		ID:         suppliers.NewTransactionID(),
		SupplierID: f.supplier,
		BusinessID: f.tenant,
		Type:       suppliers.Payment,
		Amount:     money.FromXAF(-minor),
		AccountID:  f.account,
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("suppliers.RecordTransaction: %v", err)
	}
	return transaction
}

// §15's fan-out arriving as one event: the delivery, the stock it brought in,
// the money handed over, and the debt for the rest, all in one transaction.
func TestAnAppliedDeliveryLandsWithItsStockMoneyAndDebt(t *testing.T) {
	f := newPurchaseFixture(t)
	f.record(t, finance.OpeningBalance, 200_000)

	purchase := f.purchase(t)
	effects := postgres.Effects{
		Purchase:  purchase,
		Movements: []*inventory.Movement{f.arriving(t, purchase, 20)},
		Cash:      []*finance.Movement{f.handedOver(t, 40_000)},
		Owed:      []*suppliers.Transaction{f.owed(t, purchase, 60_000)},
	}

	event := f.event(t, 1)
	if _, err := f.repo.Get(f.ctx, f.scope, purchase.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Fatalf("the delivery was there before the event: %v", err)
	}
	if _, err := f.events.RecordAndApply(f.ctx, f.scope, event, effects); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, purchase.ID()); err != nil {
		t.Errorf("the delivery did not land: %v", err)
	}
	if got := f.stock(t); got != 20_000 {
		t.Errorf("stock = %d, want the 20 units that arrived", got)
	}
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(160_000)) {
		t.Errorf("the till holds %s, want 160000 after paying 40000", got)
	}
	if got := f.owes(t); !got.Equal(money.FromXAF(60_000)) {
		t.Errorf("the supplier is owed %s, want 60000", got)
	}

	// A till resending its backlog must not double the stock, the money, or the
	// debt (§27).
	outcome, err := f.events.RecordAndApply(f.ctx, f.scope, event, effects)
	if err != nil {
		t.Fatalf("replaying: %v", err)
	}
	if outcome != postgres.AlreadyRecorded {
		t.Errorf("outcome = %v, want AlreadyRecorded", outcome)
	}
	if got := f.stock(t); got != 20_000 {
		t.Errorf("stock = %d after a resend, want 20000", got)
	}
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(160_000)) {
		t.Errorf("the till holds %s after a resend, want 160000", got)
	}
	if got := f.owes(t); !got.Equal(money.FromXAF(60_000)) {
		t.Errorf("the supplier is owed %s after a resend, want 60000", got)
	}
}

// Settling a wholesaler's account is not about any one delivery, so it needs no
// delivery in the event carrying it (§16).
func TestSettlingASupplierAppliesWithoutADelivery(t *testing.T) {
	f := newPurchaseFixture(t)
	f.record(t, finance.OpeningBalance, 200_000)

	purchase := f.purchase(t)
	if err := f.repo.Record(f.ctx, f.scope, purchase, nil, nil,
		f.owed(t, purchase, 100_000)); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
		postgres.Effects{Owed: []*suppliers.Transaction{f.settling(t, 30_000)}}); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}

	if got := f.owes(t); !got.Equal(money.FromXAF(70_000)) {
		t.Errorf("the supplier is owed %s, want 70000 after a 30000 payment", got)
	}
}

// The drawer has to know. A payment to a wholesaler is a source of money like
// any other, and one missing from the balance query would leave the till
// reading long by exactly what it paid out (§18).
func TestPayingAWholesalerLowersWhatTheDrawerHolds(t *testing.T) {
	f := newPurchaseFixture(t)
	f.record(t, finance.OpeningBalance, 200_000)

	purchase := f.purchase(t)
	if err := f.repo.Record(f.ctx, f.scope, purchase, nil, nil,
		f.owed(t, purchase, 100_000)); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if err := f.ledger.Record(f.ctx, f.scope, f.settling(t, 30_000)); err != nil {
		t.Fatalf("recording the payment: %v", err)
	}

	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(170_000)) {
		t.Errorf("the till holds %s, want 170000: paying a wholesaler took 30000 out", got)
	}

	// And a payment that names no account — goods going back, which reduce the
	// bill without a franc moving — leaves the drawer alone.
	goingBack, err := suppliers.RecordTransaction(suppliers.TransactionSnapshot{
		ID:         suppliers.NewTransactionID(),
		SupplierID: f.supplier,
		BusinessID: f.tenant,
		Type:       suppliers.Return,
		Amount:     money.FromXAF(-10_000),
		Reference:  suppliers.Reference{Kind: "PURCHASE", ID: purchase.ID().String()},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("suppliers.RecordTransaction: %v", err)
	}
	if err := f.ledger.Record(f.ctx, f.scope, goingBack); err != nil {
		t.Fatalf("recording the return: %v", err)
	}

	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(170_000)) {
		t.Errorf("the till holds %s after a return, want 170000: no cash moved", got)
	}
	if got := f.owes(t); !got.Equal(money.FromXAF(60_000)) {
		t.Errorf("the supplier is owed %s, want 60000", got)
	}
}

// A debt arriving on its own would be a balance from nowhere, with no delivery
// note a wholesaler could be shown to explain it.
func TestASupplierDebtWithoutItsDeliveryIsRefused(t *testing.T) {
	f := newPurchaseFixture(t)
	purchase := f.purchase(t)

	err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
		postgres.Effects{Owed: []*suppliers.Transaction{f.owed(t, purchase, 60_000)}}))
	if !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// The entry must be against the delivery the event carries. One naming another
// would put a debt on the shop for goods this event says nothing about.
func TestASupplierDebtAgainstAnotherDeliveryIsRefused(t *testing.T) {
	f := newPurchaseFixture(t)
	purchase, elsewhere := f.purchase(t), f.purchase(t)

	err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1), postgres.Effects{
		Purchase: purchase,
		Owed:     []*suppliers.Transaction{f.owed(t, elsewhere, 60_000)},
	}))
	if !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// And owed to the wholesaler the delivery names, or one supplier's goods land
// on another's account.
func TestASupplierDebtOwedToTheWrongWholesalerIsRefused(t *testing.T) {
	f := newPurchaseFixture(t)

	other := f.newSupplier(t, "Autre grossiste")
	purchase := f.purchase(t)
	stray := f.owed(t, purchase, 60_000)
	// Rebuilt against the other wholesaler, with the delivery's own reference.
	snapshot := stray.Snapshot()
	snapshot.SupplierID = other.ID()
	misdirected, err := suppliers.RestoreTransaction(snapshot)
	if err != nil {
		t.Fatalf("RestoreTransaction: %v", err)
	}

	failure := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1), postgres.Effects{
		Purchase: purchase,
		Owed:     []*suppliers.Transaction{misdirected},
	}))
	if !errors.Is(failure, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", failure)
	}
}

// Another tenant's books cannot be written through this event, whatever the
// payload said (ADR-008).
func TestADeliveryOrDebtOutsideTheScopeIsRefused(t *testing.T) {
	f, other := newPurchaseFixture(t), newPurchaseFixture(t)
	stranger := other.purchase(t)

	t.Run("the delivery", func(t *testing.T) {
		err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
			postgres.Effects{Purchase: stranger}))
		if !errors.Is(err, business.ErrCrossTenant) {
			t.Errorf("got %v, want ErrCrossTenant", err)
		}
	})
	t.Run("the debt", func(t *testing.T) {
		err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 2), postgres.Effects{
			Purchase: f.purchase(t),
			Owed:     []*suppliers.Transaction{other.owed(t, stranger, 60_000)},
		}))
		if !errors.Is(err, business.ErrCrossTenant) {
			t.Errorf("got %v, want ErrCrossTenant", err)
		}
	})
	t.Run("the supplier", func(t *testing.T) {
		err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 3),
			postgres.Effects{Suppliers: []*suppliers.Supplier{
				other.newSupplier(t, "Grossiste Douala"),
			}}))
		if !errors.Is(err, business.ErrCrossTenant) {
			t.Errorf("got %v, want ErrCrossTenant", err)
		}
	})
}

func TestANilSupplierOrDebtIsRefused(t *testing.T) {
	f := newPurchaseFixture(t)

	t.Run("supplier", func(t *testing.T) {
		err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
			postgres.Effects{Suppliers: []*suppliers.Supplier{nil}}))
		if !errors.Is(err, postgres.ErrQuery) {
			t.Errorf("got %v, want ErrQuery", err)
		}
	})
	t.Run("debt", func(t *testing.T) {
		err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 2),
			postgres.Effects{Owed: []*suppliers.Transaction{nil}}))
		if !errors.Is(err, postgres.ErrQuery) {
			t.Errorf("got %v, want ErrQuery", err)
		}
	})
}

// A supplier is state, so the newest edit wins — and it wins whichever order
// the two arrive in, which is what lets a device settle a conflict offline
// (ADR-015).
func TestAnAppliedSupplierEditIsLastWriteWins(t *testing.T) {
	for _, testCase := range []struct {
		name         string
		firstIsLater bool
	}{
		{"in order", false},
		{"out of order", true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newPurchaseFixture(t)
			supplierRepo := postgres.NewSupplierRepository(f.pool)

			supplier := f.newSupplier(t, "Grossiste Mokolo")
			early, late := createdAt.Add(time.Hour), createdAt.Add(5*time.Hour)

			edit := func(name string, at time.Time) *suppliers.Supplier {
				snapshot := supplier.Snapshot()
				snapshot.Name = name
				snapshot.UpdatedAt = at
				snapshot.UpdatedByDevice = f.till
				edited, err := suppliers.Restore(snapshot)
				if err != nil {
					t.Fatalf("suppliers.Restore: %v", err)
				}
				return edited
			}

			first, second := edit("Grossiste Mokolo", early), edit("Grossiste Mokolo SARL", late)
			if testCase.firstIsLater {
				first, second = second, first
			}

			for i, incoming := range []*suppliers.Supplier{first, second} {
				if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, int64(i+1)),
					postgres.Effects{Suppliers: []*suppliers.Supplier{incoming}}); err != nil {
					t.Fatalf("RecordAndApply: %v", err)
				}
			}

			found, err := supplierRepo.Get(f.ctx, f.scope, supplier.ID())
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if found.Name() != "Grossiste Mokolo SARL" {
				t.Errorf("Name = %q, want the later edit", found.Name())
			}
			if !found.UpdatedAt().Equal(late) {
				t.Errorf("UpdatedAt = %s, want %s", found.UpdatedAt(), late)
			}
		})
	}
}

// A supplier arriving with a delivery is applied first, so a purchase naming a
// wholesaler nobody has heard of does not fail on the order the two are in.
func TestASupplierArrivingWithItsFirstDeliveryIsAppliedFirst(t *testing.T) {
	f := newPurchaseFixture(t)

	fresh, err := suppliers.New(suppliers.Snapshot{
		ID:         suppliers.NewID(),
		BusinessID: f.tenant,
		Name:       "Grossiste Inconnu",
		CreatedAt:  createdAt,
	})
	if err != nil {
		t.Fatalf("suppliers.New: %v", err)
	}

	purchase := f.purchase(t, func(s *purchases.Snapshot) { s.SupplierID = fresh.ID() })
	owed := f.owed(t, purchase, 100_000)
	snapshot := owed.Snapshot()
	snapshot.SupplierID = fresh.ID()
	owed, err = suppliers.RestoreTransaction(snapshot)
	if err != nil {
		t.Fatalf("RestoreTransaction: %v", err)
	}

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1), postgres.Effects{
		Suppliers: []*suppliers.Supplier{fresh},
		Purchase:  purchase,
		Owed:      []*suppliers.Transaction{owed},
	}); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}

	balance, err := f.ledger.BalanceOf(f.ctx, f.scope, fresh.ID())
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if !balance.Outstanding.Equal(money.FromXAF(100_000)) {
		t.Errorf("the new supplier is owed %s, want 100000", balance.Outstanding)
	}
}

// Half a delivery describes something that did not happen, so a movement the
// database refuses takes the whole event with it — including the event row,
// which is what stops the device being told "accepted" for nothing.
func TestADeliveryIsNotRecordedWhenAnyPartOfItFails(t *testing.T) {
	f := newPurchaseFixture(t)

	// A wholesaler nobody opened, named by both the delivery and its debt: that
	// is what gets the entry past the guard and down to the database, which
	// refuses the reference.
	absent := suppliers.NewID()
	purchase := f.purchase(t, func(s *purchases.Snapshot) { s.SupplierID = absent })

	snapshot := f.owed(t, purchase, 100_000).Snapshot()
	snapshot.SupplierID = absent
	orphan, err := suppliers.RestoreTransaction(snapshot)
	if err != nil {
		t.Fatalf("RestoreTransaction: %v", err)
	}

	event := f.event(t, 1)
	if _, err := f.events.RecordAndApply(f.ctx, f.scope, event, postgres.Effects{
		Purchase:  purchase,
		Movements: []*inventory.Movement{f.arriving(t, purchase, 20)},
		Owed:      []*suppliers.Transaction{orphan},
	}); err == nil {
		t.Fatal("a delivery with an impossible debt was applied")
	}

	if _, err := f.repo.Get(f.ctx, f.scope, purchase.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Error("the delivery survived a transaction that failed")
	}
	if got := f.stock(t); got != 0 {
		t.Errorf("stock = %d, want nothing: a movement landed from a failed transaction", got)
	}
	// And the event is not in the log, so the device resends rather than being
	// told its delivery arrived.
	events, err := f.events.Since(f.ctx, f.scope, 0, f.phone, 10)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	for _, stored := range events {
		if stored.Event.Envelope().ID == event.Envelope().ID {
			t.Error("the event was recorded though its effects were not")
		}
	}
}
