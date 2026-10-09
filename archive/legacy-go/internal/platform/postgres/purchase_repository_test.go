package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// purchaseFixture is a business with a supplier, a till, and a product to buy.
type purchaseFixture struct {
	*cashFixture
	repo     *postgres.PurchaseRepository
	ledger   *postgres.SupplierLedgerRepository
	supplier suppliers.ID
}

func newPurchaseFixture(t *testing.T) *purchaseFixture {
	t.Helper()

	base := newCashFixture(t)
	f := &purchaseFixture{
		cashFixture: base,
		repo:        postgres.NewPurchaseRepository(base.pool),
		ledger:      postgres.NewSupplierLedgerRepository(base.pool),
	}
	f.supplier = f.newSupplier(t, "Grossiste Nkoabang").ID()
	return f
}

func (f *purchaseFixture) newSupplier(t *testing.T, name string) *suppliers.Supplier {
	t.Helper()

	supplier, err := suppliers.New(suppliers.Snapshot{
		ID:         suppliers.NewID(),
		BusinessID: f.tenant,
		Name:       name,
		CreatedAt:  createdAt,
	})
	if err != nil {
		t.Fatalf("suppliers.New: %v", err)
	}
	if err := postgres.NewSupplierRepository(f.pool).Create(f.ctx, f.scope, supplier); err != nil {
		t.Fatalf("creating a supplier: %v", err)
	}
	return supplier
}

// purchase builds a one-line delivery of the fixture's product.
func (f *purchaseFixture) purchase(
	t *testing.T, mutate ...func(*purchases.Snapshot),
) *purchases.Purchase {
	t.Helper()

	snapshot := purchases.Snapshot{
		ID:         purchases.NewID(),
		BusinessID: f.tenant,
		SupplierID: f.supplier,
		Items: []purchases.ItemSnapshot{{
			ID:        purchases.NewItemID(),
			ProductID: f.product,
			UnitCost:  money.FromXAF(5_000),
			Quantity:  quantity.MustFromUnits(20),
		}},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	purchase, err := purchases.Record(snapshot)
	if err != nil {
		t.Fatalf("purchases.Record: %v", err)
	}
	return purchase
}

// arriving is the stock a delivery brought in.
func (f *purchaseFixture) arriving(
	t *testing.T, purchase *purchases.Purchase, units int64,
) *inventory.Movement {
	t.Helper()

	movement, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: f.tenant,
		ProductID:  f.product,
		Type:       inventory.Purchase,
		Quantity:   quantity.FromThousandths(units * 1_000),
		UnitCost:   money.FromXAF(5_000),
		Reference:  inventory.Reference{Kind: "PURCHASE", ID: purchase.ID().String()},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}
	return movement
}

// handedOver is money leaving an account at the door.
func (f *purchaseFixture) handedOver(t *testing.T, minor int64) *finance.Movement {
	t.Helper()

	movement, err := finance.RecordMovement(finance.MovementSnapshot{
		ID:         finance.NewMovementID(),
		AccountID:  f.account,
		BusinessID: f.tenant,
		Type:       finance.CashOut,
		Amount:     money.FromXAF(-minor),
		Reason:     "payé au livreur",
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("finance.RecordMovement: %v", err)
	}
	return movement
}

// owed is what the supplier is still owed for a delivery.
func (f *purchaseFixture) owed(
	t *testing.T, purchase *purchases.Purchase, minor int64,
) *suppliers.Transaction {
	t.Helper()

	transaction, err := suppliers.RecordTransaction(suppliers.TransactionSnapshot{
		ID:         suppliers.NewTransactionID(),
		SupplierID: f.supplier,
		BusinessID: f.tenant,
		Type:       suppliers.Purchase,
		Amount:     money.FromXAF(minor),
		Reference:  suppliers.Reference{Kind: "PURCHASE", ID: purchase.ID().String()},
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

func (f *purchaseFixture) owes(t *testing.T) money.Money {
	t.Helper()

	balance, err := f.ledger.BalanceOf(f.ctx, f.scope, f.supplier)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	return balance.Outstanding
}

// §15's first case: paid at the door. Inventory up, cash down, and the supplier
// is owed nothing.
func TestAPurchasePaidAtTheDoor(t *testing.T) {
	f := newPurchaseFixture(t)

	f.record(t, finance.OpeningBalance, 200_000)
	purchase := f.purchase(t)

	if err := f.repo.Record(f.ctx, f.scope, purchase,
		[]*inventory.Movement{f.arriving(t, purchase, 20)},
		[]*finance.Movement{f.handedOver(t, 100_000)}, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if got := f.stock(t); got != 20_000 {
		t.Errorf("stock = %d, want the 20 units that arrived", got)
	}
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(100_000)) {
		t.Errorf("the till holds %s, want 100000 after paying", got)
	}
	if owed := f.owes(t); owed.Valid() {
		t.Errorf("the supplier is owed %s for a delivery paid at the door", owed)
	}
}

// §15's second case: on credit. Inventory up, cash untouched, and the supplier
// is owed the bill.
func TestAPurchaseOnCredit(t *testing.T) {
	f := newPurchaseFixture(t)

	f.record(t, finance.OpeningBalance, 200_000)
	purchase := f.purchase(t)

	if err := f.repo.Record(f.ctx, f.scope, purchase,
		[]*inventory.Movement{f.arriving(t, purchase, 20)},
		nil, f.owed(t, purchase, 100_000)); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if got := f.stock(t); got != 20_000 {
		t.Errorf("stock = %d, want the 20 units that arrived", got)
	}
	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(200_000)) {
		t.Errorf("the till holds %s: a credit purchase moved money", got)
	}
	if got := f.owes(t); !got.Equal(money.FromXAF(100_000)) {
		t.Errorf("the supplier is owed %s, want 100000", got)
	}
}

// Part paid at the door, the rest owed — the ordinary case between §15's two.
func TestAPurchasePartlyPaid(t *testing.T) {
	f := newPurchaseFixture(t)

	f.record(t, finance.OpeningBalance, 200_000)
	purchase := f.purchase(t)

	if err := f.repo.Record(f.ctx, f.scope, purchase,
		[]*inventory.Movement{f.arriving(t, purchase, 20)},
		[]*finance.Movement{f.handedOver(t, 40_000)},
		f.owed(t, purchase, 60_000)); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if got := f.balance(t, f.account).OnHand; !got.Equal(money.FromXAF(160_000)) {
		t.Errorf("the till holds %s, want 160000", got)
	}
	if got := f.owes(t); !got.Equal(money.FromXAF(60_000)) {
		t.Errorf("the supplier is owed %s, want 60000", got)
	}
}

// Half a fan-out describes something that did not happen.
func TestAPurchaseIsNotRecordedWhenAnyPartOfItFails(t *testing.T) {
	f := newPurchaseFixture(t)

	purchase := f.purchase(t)
	// A movement for a product that does not exist: the database refuses it,
	// and the purchase must not survive.
	orphan, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: f.tenant,
		ProductID:  products.NewID(), // no such product
		Type:       inventory.Purchase,
		Quantity:   quantity.MustFromUnits(1),
		Reference:  inventory.Reference{Kind: "PURCHASE", ID: purchase.ID().String()},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}

	if err := f.repo.Record(f.ctx, f.scope, purchase,
		[]*inventory.Movement{f.arriving(t, purchase, 20), orphan}, nil,
		f.owed(t, purchase, 100_000)); err == nil {
		t.Fatal("a purchase with an impossible movement was recorded")
	}

	if _, err := f.repo.Get(f.ctx, f.scope, purchase.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Error("the purchase survived a transaction that failed")
	}
	if got := f.stock(t); got != 0 {
		t.Errorf("stock = %d, want nothing: a movement landed from a failed transaction", got)
	}
	if owed := f.owes(t); owed.Valid() {
		t.Errorf("the supplier is owed %s from a transaction that failed", owed)
	}
}

// The debt belongs to the supplier the delivery names, or one wholesaler's
// goods land on another's account.
func TestTheDebtMustBeOwedToThePurchasesSupplier(t *testing.T) {
	f := newPurchaseFixture(t)

	other := f.newSupplier(t, "Autre grossiste")
	purchase := f.purchase(t)
	stray, err := suppliers.RecordTransaction(suppliers.TransactionSnapshot{
		ID:         suppliers.NewTransactionID(),
		SupplierID: other.ID(),
		BusinessID: f.tenant,
		Type:       suppliers.Purchase,
		Amount:     money.FromXAF(100_000),
		Reference:  suppliers.Reference{Kind: "PURCHASE", ID: purchase.ID().String()},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("RecordTransaction: %v", err)
	}

	if err := f.repo.Record(f.ctx, f.scope, purchase, nil, nil, stray); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}

	// And a delivery from the market, naming nobody, cannot carry a debt at all.
	market := f.purchase(t, func(s *purchases.Snapshot) { s.SupplierID = suppliers.ID{} })
	if err := f.repo.Record(f.ctx, f.scope, market, nil, nil,
		f.owed(t, market, 100_000)); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

func TestEverythingAPurchaseCarriesSurvivesStorage(t *testing.T) {
	f := newPurchaseFixture(t)

	recorded := f.purchase(t, func(s *purchases.Snapshot) {
		s.Reference = "BL-4471"
		s.Note = "deux sacs abîmés"
		s.Items = append(s.Items, purchases.ItemSnapshot{
			ID:        purchases.NewItemID(),
			ProductID: f.product,
			UnitCost:  money.FromXAF(4_800),
			Quantity:  quantity.MustParse("2.5"),
		})
	})
	if err := f.repo.Record(f.ctx, f.scope, recorded, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	loaded, err := f.repo.Get(f.ctx, f.scope, recorded.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	before, after := recorded.Snapshot(), loaded.Snapshot()
	if len(after.Items) != len(before.Items) {
		t.Fatalf("loaded %d lines, want %d", len(after.Items), len(before.Items))
	}
	if after.Reference != "BL-4471" || after.Note != "deux sacs abîmés" {
		t.Errorf("kept %q and %q", after.Reference, after.Note)
	}
	total, err := loaded.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	// 20 × 5,000 plus 2.5 × 4,800.
	if total.Amount() != 112_000 {
		t.Errorf("total = %s, want 112000", total)
	}
}

func TestPurchasesArePartOfThePeriodTheyArrivedIn(t *testing.T) {
	f := newPurchaseFixture(t)

	early := f.purchase(t, func(s *purchases.Snapshot) {
		s.OccurredAt = soldAt.Add(-48 * time.Hour)
		s.RecordedAt = soldAt
	})
	if err := f.repo.Record(f.ctx, f.scope, early, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}
	late := f.purchase(t)
	if err := f.repo.Record(f.ctx, f.scope, late, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	found, err := f.repo.Between(f.ctx, f.scope, soldAt.Add(-72*time.Hour), soldAt.Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(found) != 1 || found[0].ID() != early.ID() {
		t.Errorf("the period holds %d purchases, want the one that arrived in it", len(found))
	}
	if len(found[0].Items()) != 1 {
		t.Errorf("the purchase came back with %d lines", len(found[0].Items()))
	}
}

func TestAPurchaseCannotBeChangedOrDeleted(t *testing.T) {
	f := newPurchaseFixture(t)

	purchase := f.purchase(t)
	if err := f.repo.Record(f.ctx, f.scope, purchase, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	for _, statement := range []struct {
		name string
		sql  string
	}{
		{"updating a purchase", `UPDATE purchases SET reference = 'X' WHERE id = $1`},
		{"deleting a purchase", `DELETE FROM purchases WHERE id = $1`},
		{"updating a line", `UPDATE purchase_items SET unit_cost_minor = 1 WHERE purchase_id = $1`},
		{"deleting a line", `DELETE FROM purchase_items WHERE purchase_id = $1`},
	} {
		t.Run(statement.name, func(t *testing.T) {
			if _, err := f.pool.Exec(f.ctx, statement.sql, purchase.ID().ID()); err == nil {
				t.Error("the database allowed it")
			}
		})
	}
}

func TestAnotherBusinessesPurchasesAreInvisible(t *testing.T) {
	f, other := newPurchaseFixture(t), newPurchaseFixture(t)

	theirs := other.purchase(t)
	if err := other.repo.Record(other.ctx, other.scope, theirs, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, theirs.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	mine, err := f.repo.Between(f.ctx, f.scope, soldAt.Add(-time.Hour), soldAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(mine) != 0 {
		t.Errorf("read %d of another business's purchases", len(mine))
	}
	if err := f.repo.Record(f.ctx, f.scope, theirs, nil, nil, nil); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

func TestPurchaseOperationsRefuseWhatCannotBeAnswered(t *testing.T) {
	f := newPurchaseFixture(t)
	purchase := f.purchase(t)
	var none business.Scope

	if err := f.repo.Record(f.ctx, none, purchase, nil, nil, nil); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("Record: got %v, want ErrNoTenant", err)
	}
	if _, err := f.repo.Get(f.ctx, none, purchase.ID()); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("Get: got %v, want ErrNoTenant", err)
	}
	if _, err := f.repo.Between(f.ctx, none, soldAt, soldAt.Add(time.Hour)); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("Between: got %v, want ErrNoTenant", err)
	}

	if err := f.repo.Record(f.ctx, f.scope, nil, nil, nil, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Record without a purchase: got %v, want ErrQuery", err)
	}
	if err := f.repo.Record(f.ctx, f.scope, purchase, []*inventory.Movement{nil}, nil, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("a nil movement was accepted: %v", err)
	}
	if err := f.repo.Record(f.ctx, f.scope, purchase, nil, []*finance.Movement{nil}, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("a nil payment was accepted: %v", err)
	}
	if _, err := f.repo.Get(f.ctx, f.scope, purchases.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("Get without an identifier: got %v, want ErrNotFound", err)
	}
	if _, err := f.repo.Between(f.ctx, f.scope, time.Time{}, soldAt); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Between with no start: got %v, want ErrQuery", err)
	}
	if _, err := f.repo.Between(f.ctx, f.scope, soldAt, soldAt.Add(-time.Hour)); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("a period that ends before it starts: got %v, want ErrQuery", err)
	}
}

func TestPurchaseOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewPurchaseRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	purchase, err := purchases.Record(purchases.Snapshot{
		ID:         purchases.NewID(),
		BusinessID: tenant,
		Items: []purchases.ItemSnapshot{{
			ID:        purchases.NewItemID(),
			ProductID: products.NewID(), // no such product
			UnitCost:  money.FromXAF(5_000),
			Quantity:  quantity.MustFromUnits(1),
		}},
		UserID:     users.NewID(),
		DeviceID:   devices.NewID(),
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("purchases.Record: %v", err)
	}

	operations := map[string]func() error{
		"Record":  func() error { return repo.Record(ctx, scope, purchase, nil, nil, nil) },
		"Get":     func() error { _, err := repo.Get(ctx, scope, purchase.ID()); return err },
		"Between": func() error { _, err := repo.Between(ctx, scope, createdAt, createdAt.Add(time.Hour)); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}
