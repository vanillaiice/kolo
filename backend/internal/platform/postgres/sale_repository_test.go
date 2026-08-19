package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// saleFixture is a business with a product to sell and somewhere to sell it.
type saleFixture struct {
	*applyFixture
	repo *postgres.SaleRepository
	pool *pgxpool.Pool
}

func newSaleFixture(t *testing.T) *saleFixture {
	t.Helper()

	base := newApplyFixture(t)
	pool := pgtest.Pool(t)
	return &saleFixture{applyFixture: base, repo: postgres.NewSaleRepository(pool), pool: pool}
}

var soldAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

// customer registers someone for the sale to be owed by.
//
// A sale may name a customer, and since 00008 the reference is a real one: a
// sale owed by nobody on the books would leave a debt with no ledger to carry
// it.
func (f *saleFixture) customer(t *testing.T, name string) customers.ID {
	t.Helper()

	customer, err := customers.New(customers.Snapshot{
		ID:         customers.NewID(),
		BusinessID: f.tenant,
		Name:       name,
		CreatedAt:  soldAt,
	})
	if err != nil {
		t.Fatalf("customers.New: %v", err)
	}
	if err := postgres.NewCustomerRepository(f.pool).Create(f.ctx, f.scope, customer); err != nil {
		t.Fatalf("creating the customer: %v", err)
	}
	return customer.ID()
}

// sale builds a one-line sale for the fixture's product.
func (f *saleFixture) sale(t *testing.T, mutate ...func(*sales.Snapshot)) *sales.Sale {
	t.Helper()

	snapshot := sales.Snapshot{
		ID:         sales.NewID(),
		BusinessID: f.tenant,
		// The whole identifier, not a prefix: UUIDv7 begins with a timestamp, so
		// two drawn in the same millisecond share their first characters.
		Number: "V-" + sales.NewID().String(),
		Items: []sales.ItemSnapshot{{
			ID:        sales.NewItemID(),
			ProductID: f.product,
			Name:      "Riz parfumé 5kg",
			UnitPrice: money.FromXAF(6_500),
			Quantity:  quantity.MustFromUnits(2),
			UnitCost:  money.FromXAF(5_000),
		}},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	sale, err := sales.Record(snapshot)
	if err != nil {
		t.Fatalf("sales.Record: %v", err)
	}
	return sale
}

// payment builds a payment against a sale.
func (f *saleFixture) payment(t *testing.T, sale *sales.Sale, amount int64) *sales.Payment {
	t.Helper()

	payment, err := sales.RecordPayment(sales.PaymentSnapshot{
		ID:         sales.NewPaymentID(),
		SaleID:     sale.ID(),
		BusinessID: f.tenant,
		AccountID:  finance.NewAccountID(),
		Amount:     money.FromXAF(amount),
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("RecordPayment: %v", err)
	}
	return payment
}

// soldMovement is the stock a sale releases.
func (f *saleFixture) soldMovement(t *testing.T, sale *sales.Sale, units int64) *inventory.Movement {
	t.Helper()

	movement, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: f.tenant,
		ProductID:  f.product,
		Type:       inventory.Sale,
		Quantity:   quantity.FromThousandths(-units * 1_000),
		Reference:  inventory.Reference{Kind: "SALE", ID: sale.ID().String()},
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

// A sale, its lines, its payments, and its movements all land together.
func TestASaleAndEverythingItProducedLandTogether(t *testing.T) {
	f := newSaleFixture(t)

	sale := f.sale(t)
	payments := []*sales.Payment{f.payment(t, sale, 10_000), f.payment(t, sale, 3_000)}
	movements := []*inventory.Movement{f.soldMovement(t, sale, 2)}

	if err := f.repo.Record(f.ctx, f.scope, sale, payments, movements, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	stored, err := f.repo.Get(f.ctx, f.scope, sale.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	total, err := stored.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if total.Amount() != 13_000 {
		t.Errorf("total = %s, want 13000 XAF", total)
	}

	storedPayments, err := f.repo.PaymentsOf(f.ctx, f.scope, sale.ID())
	if err != nil {
		t.Fatalf("PaymentsOf: %v", err)
	}
	if len(storedPayments) != 2 {
		t.Errorf("got %d payments, want 2", len(storedPayments))
	}

	// And the stock left the shelf in the same breath.
	if got := f.stock(t); got != -2_000 {
		t.Errorf("stock = %d, want -2000 thousandths", got)
	}

	settlement, err := sales.Settle(stored, storedPayments)
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if !settlement.Settled() {
		t.Errorf("outstanding = %s, want a settled sale", settlement.Outstanding)
	}
}

// The failure the transaction exists for. A movement the database refuses must
// take the whole sale with it — money recorded for goods the ledger never
// released is worse than no record at all.
func TestASaleIsNotRecordedWhenItsMovementsCannotBe(t *testing.T) {
	f := newSaleFixture(t)

	sale := f.sale(t)
	orphan, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: f.tenant,
		ProductID:  products.NewID(), // no such product
		Type:       inventory.Sale,
		Quantity:   quantity.FromThousandths(-1_000),
		Reference:  inventory.Reference{Kind: "SALE", ID: sale.ID().String()},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}

	err = f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{f.payment(t, sale, 13_000)},
		[]*inventory.Movement{f.soldMovement(t, sale, 2), orphan}, nil)
	if err == nil {
		t.Fatal("a sale with an impossible movement was recorded")
	}

	if _, err := f.repo.Get(f.ctx, f.scope, sale.ID()); err == nil {
		t.Error("the sale survived a transaction that failed")
	}
	payments, err := f.repo.PaymentsOf(f.ctx, f.scope, sale.ID())
	if err != nil {
		t.Fatalf("PaymentsOf: %v", err)
	}
	if len(payments) != 0 {
		t.Errorf("%d payments survived a transaction that failed", len(payments))
	}
	if got := f.stock(t); got != 0 {
		t.Errorf("stock = %d, want 0: a movement landed from a failed transaction", got)
	}
}

// A payment the database refuses takes the sale with it too.
func TestASaleIsNotRecordedWhenItsPaymentsCannotBe(t *testing.T) {
	f := newSaleFixture(t)

	sale := f.sale(t)
	duplicate := f.payment(t, sale, 6_500)

	err := f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{duplicate, duplicate},
		[]*inventory.Movement{f.soldMovement(t, sale, 2)}, nil)
	if err == nil {
		t.Fatal("a sale with a duplicated payment was recorded")
	}
	if _, err := f.repo.Get(f.ctx, f.scope, sale.ID()); err == nil {
		t.Error("the sale survived a transaction that failed")
	}
	if got := f.stock(t); got != 0 {
		t.Errorf("stock = %d, want 0", got)
	}
}

// A sale is financial history and never changes. The database refuses, not just
// the domain, so a support script cannot do it either (§41).
func TestASaleCannotBeChangedOrDeleted(t *testing.T) {
	f := newSaleFixture(t)

	sale := f.sale(t)
	if err := f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{f.payment(t, sale, 13_000)},
		[]*inventory.Movement{f.soldMovement(t, sale, 2)}, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	for _, statement := range []struct {
		name string
		sql  string
	}{
		{"updating a sale", `UPDATE sales SET number = 'V-999' WHERE id = $1`},
		{"deleting a sale", `DELETE FROM sales WHERE id = $1`},
		{"updating an item", `UPDATE sale_items SET unit_price_minor = 1 WHERE sale_id = $1`},
		{"deleting an item", `DELETE FROM sale_items WHERE sale_id = $1`},
		{"updating a payment", `UPDATE sale_payments SET amount_minor = 1 WHERE sale_id = $1`},
		{"deleting a payment", `DELETE FROM sale_payments WHERE sale_id = $1`},
	} {
		t.Run(statement.name, func(t *testing.T) {
			if _, err := f.pool.Exec(f.ctx, statement.sql, sale.ID().ID()); err == nil {
				t.Error("the database allowed it")
			}
		})
	}
}

// Another tenant's sale is not found, never forbidden: saying "you may not see
// this" confirms it exists (ADR-008).
func TestASaleFromAnotherBusinessIsNotFound(t *testing.T) {
	f, stranger := newSaleFixture(t), newSaleFixture(t)

	sale := f.sale(t)
	if err := f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{f.payment(t, sale, 13_000)},
		[]*inventory.Movement{f.soldMovement(t, sale, 2)}, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if _, err := stranger.repo.Get(stranger.ctx, stranger.scope, sale.ID()); err != postgres.ErrNotFound {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
	payments, err := stranger.repo.PaymentsOf(stranger.ctx, stranger.scope, sale.ID())
	if err != nil {
		t.Fatalf("PaymentsOf: %v", err)
	}
	if len(payments) != 0 {
		t.Errorf("another business saw %d payments", len(payments))
	}
}

// Recording into another tenant is refused outright, before anything is
// written.
func TestASaleCannotBeRecordedIntoAnotherBusiness(t *testing.T) {
	f, stranger := newSaleFixture(t), newSaleFixture(t)

	sale := f.sale(t)
	if err := stranger.repo.Record(stranger.ctx, stranger.scope, sale, nil, nil, nil); err == nil {
		t.Fatal("a sale was recorded into another business")
	}
	if _, err := f.repo.Get(f.ctx, f.scope, sale.ID()); err == nil {
		t.Error("the sale was written anyway")
	}
}

// A payment naming another sale is refused: it would settle a debt it was never
// paid against.
func TestAPaymentForAnotherSaleIsRefusedAtTheRepository(t *testing.T) {
	f := newSaleFixture(t)

	sale, other := f.sale(t), f.sale(t)
	err := f.repo.Record(f.ctx, f.scope, sale, []*sales.Payment{f.payment(t, other, 1_000)}, nil, nil)
	if err == nil {
		t.Fatal("a payment for another sale was accepted")
	}
}

// A receipt number is unique within a business, and only within it: two shops
// both starting at V-000001 is expected.
func TestAReceiptNumberIsUniquePerBusiness(t *testing.T) {
	f, other := newSaleFixture(t), newSaleFixture(t)

	first := f.sale(t, func(s *sales.Snapshot) { s.Number = "V-000001" })
	if err := f.repo.Record(f.ctx, f.scope, first, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	clash := f.sale(t, func(s *sales.Snapshot) { s.Number = "V-000001" })
	if err := f.repo.Record(f.ctx, f.scope, clash, nil, nil, nil); err == nil {
		t.Error("the same receipt number was reused within one business")
	}

	elsewhere := other.sale(t, func(s *sales.Snapshot) { s.Number = "V-000001" })
	if err := other.repo.Record(other.ctx, other.scope, elsewhere, nil, nil, nil); err != nil {
		t.Errorf("another business could not use the same number: %v", err)
	}
}

// creditFor builds the ledger entry a sale left unpaid produces.
func (f *saleFixture) creditFor(
	t *testing.T, sale *sales.Sale, customerID customers.ID, minor int64,
) *customers.Transaction {
	t.Helper()

	credit, err := customers.RecordTransaction(customers.TransactionSnapshot{
		ID:         customers.NewTransactionID(),
		CustomerID: customerID,
		BusinessID: f.tenant,
		Type:       customers.CreditSale,
		Amount:     money.FromXAF(minor),
		Reference:  customers.Reference{Kind: "SALE", ID: sale.ID().String()},
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: soldAt,
		RecordedAt: soldAt.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("customers.RecordTransaction: %v", err)
	}
	return credit
}

// §9's fan-out reaching §13: the sale, its stock, its payment, and the debt it
// left all land in one transaction, and the customer's balance is that debt.
func TestACreditSaleLandsWithTheDebtItLeft(t *testing.T) {
	f := newSaleFixture(t)

	customerID := f.customer(t, "Jean Mbarga")
	sale := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })
	payments := []*sales.Payment{f.payment(t, sale, 10_000)}
	movements := []*inventory.Movement{f.soldMovement(t, sale, 2)}
	// 2 at 6,500 is 13,000, of which 10,000 was paid.
	credit := f.creditFor(t, sale, customerID, 3_000)

	if err := f.repo.Record(f.ctx, f.scope, sale, payments, movements, credit); err != nil {
		t.Fatalf("Record: %v", err)
	}

	balance, err := postgres.NewCreditRepository(f.pool).BalanceOf(f.ctx, f.scope, customerID)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if got := balance.Outstanding; !got.Equal(money.FromXAF(3_000)) {
		t.Errorf("outstanding = %s, want 3000 XAF", got)
	}
	if balance.Entries != 1 {
		t.Errorf("entries = %d, want the one the sale created", balance.Entries)
	}
}

// The debt cannot land without the sale. A ledger entry the database refuses
// takes the whole sale with it, because a sale recorded without its debt is
// goods gone with nobody owing for them — and nothing afterwards could tell.
func TestASaleIsNotRecordedWhenItsCreditCannotBe(t *testing.T) {
	f := newSaleFixture(t)

	customerID := f.customer(t, "Jean Mbarga")
	first := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })
	credit := f.creditFor(t, first, first.Snapshot().CustomerID, 3_000)
	if err := f.repo.Record(f.ctx, f.scope, first,
		[]*sales.Payment{f.payment(t, first, 10_000)},
		[]*inventory.Movement{f.soldMovement(t, first, 2)}, credit); err != nil {
		t.Fatalf("Record: %v", err)
	}

	// A second sale reusing the ledger entry's identifier, which is what a
	// device that garbled a resend would send.
	second := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })
	if err := f.repo.Record(f.ctx, f.scope, second,
		[]*sales.Payment{f.payment(t, second, 10_000)},
		[]*inventory.Movement{f.soldMovement(t, second, 2)}, credit); err == nil {
		t.Fatal("a sale reusing a ledger entry was recorded")
	}

	if _, err := f.repo.Get(f.ctx, f.scope, second.ID()); err == nil {
		t.Error("the sale survived a transaction that failed")
	}
	if got := f.stock(t); got != -2_000 {
		t.Errorf("stock = %d, want only the first sale's movement", got)
	}
}

// A debt has to be owed by the person the sale names, or one customer's
// purchase lands on another's account.
func TestACreditEntryMustBelongToTheSalesCustomer(t *testing.T) {
	f := newSaleFixture(t)

	buyer := f.customer(t, "Jean Mbarga")
	someoneElse := f.customer(t, "Alice Ngo")

	sale := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = buyer })
	stray := f.creditFor(t, sale, someoneElse, 3_000)
	if err := f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{f.payment(t, sale, 10_000)}, nil, stray); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}

	// And a cash sale that names nobody cannot carry a debt at all.
	cash := f.sale(t)
	orphan := f.creditFor(t, cash, buyer, 3_000)
	if err := f.repo.Record(f.ctx, f.scope, cash, nil, nil, orphan); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// A sale can be owed by a customer, but only by one on this business's books.
// The alternative is a debt with no ledger to carry it, and — worse — a sale
// pointing at another tenant's customer.
func TestASaleCannotNameACustomerWhoIsNotOnTheBooks(t *testing.T) {
	f := newSaleFixture(t)
	other := newSaleFixture(t)

	unknown := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customers.NewID() })
	if err := f.repo.Record(f.ctx, f.scope, unknown, nil, nil, nil); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("a sale named a customer who does not exist: %v", err)
	}

	elsewhere := f.sale(t, func(s *sales.Snapshot) {
		s.CustomerID = other.customer(t, "Alice Ngo")
	})
	if err := f.repo.Record(f.ctx, f.scope, elsewhere, nil, nil, nil); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("a sale named another business's customer: %v", err)
	}
}

// Everything a sale carries survives the trip through storage.
func TestASaleRoundTripsThroughStorage(t *testing.T) {
	f := newSaleFixture(t)

	customerID := f.customer(t, "Jean Mbarga")
	sale := f.sale(t, func(s *sales.Snapshot) {
		s.CustomerID = customerID
		s.Note = "livraison samedi"
		s.Discount = money.FromXAF(500)
		s.Items = []sales.ItemSnapshot{
			{
				ID:                 sales.NewItemID(),
				ProductID:          f.product,
				Name:               "Riz parfumé 5kg",
				UnitPrice:          money.FromXAF(6_500),
				Quantity:           quantity.MustParse("2.5"),
				Discount:           money.FromXAF(250),
				TaxRateBasisPoints: 1_925,
				UnitCost:           money.FromXAF(5_000),
			},
			{
				ID:        sales.NewItemID(),
				ProductID: f.product,
				Name:      "Sucre 1kg",
				UnitPrice: money.FromXAF(900),
				Quantity:  quantity.MustFromUnits(1),
			},
		}
	})

	if err := f.repo.Record(f.ctx, f.scope, sale, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	stored, err := f.repo.Get(f.ctx, f.scope, sale.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	before, after := sale.Snapshot(), stored.Snapshot()
	if len(after.Items) != len(before.Items) {
		t.Fatalf("restored %d items, want %d", len(after.Items), len(before.Items))
	}
	// Items come back ordered by identifier rather than by insertion, so they
	// are matched rather than compared position by position.
	byID := make(map[sales.ItemID]sales.ItemSnapshot, len(after.Items))
	for _, item := range after.Items {
		byID[item.ID] = item
	}
	for _, want := range before.Items {
		got, found := byID[want.ID]
		if !found {
			t.Errorf("item %s did not come back", want.ID)
			continue
		}
		if got != want {
			t.Errorf("item %s changed:\n before %+v\n after  %+v", want.ID, want, got)
		}
	}

	if customer, named := stored.Customer(); !named || customer != customerID {
		t.Errorf("Customer = %s/%v, want %s", customer, named, customerID)
	}
	if after.Note != before.Note {
		t.Errorf("Note = %q, want %q", after.Note, before.Note)
	}
	if after.Discount != before.Discount {
		t.Errorf("Discount = %s, want %s", after.Discount, before.Discount)
	}
	if !after.OccurredAt.Equal(before.OccurredAt) {
		t.Errorf("OccurredAt = %s, want %s", after.OccurredAt, before.OccurredAt)
	}
}

// A sale with an unknown cost keeps the gap rather than filling it with zero,
// which would report the whole line as profit (§6).
func TestAnUnknownCostStaysUnknownThroughStorage(t *testing.T) {
	f := newSaleFixture(t)

	sale := f.sale(t, func(s *sales.Snapshot) {
		s.Items = []sales.ItemSnapshot{{
			ID:        sales.NewItemID(),
			ProductID: f.product,
			Name:      "Riz parfumé 5kg",
			UnitPrice: money.FromXAF(6_500),
			Quantity:  quantity.MustFromUnits(1),
		}}
	})
	if err := f.repo.Record(f.ctx, f.scope, sale, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	stored, err := f.repo.Get(f.ctx, f.scope, sale.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if cost, known := stored.Items()[0].UnitCost(); known {
		t.Errorf("UnitCost = %s, want unknown", cost)
	}
}

// Reports slice on when the shop traded, not when a device happened to sync.
func TestSalesAreListedByWhenTheyHappened(t *testing.T) {
	f := newSaleFixture(t)

	monday := time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC)
	tuesday := time.Date(2026, 8, 11, 9, 0, 0, 0, time.UTC)

	// Both recorded today, but they happened on different days — the shape of a
	// till syncing after a gap (§45).
	for _, when := range []time.Time{monday, tuesday} {
		sale := f.sale(t, func(s *sales.Snapshot) {
			s.OccurredAt = when
			s.RecordedAt = soldAt.Add(time.Hour)
		})
		if err := f.repo.Record(f.ctx, f.scope, sale, nil, nil, nil); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	mondayOnly, err := f.repo.Between(f.ctx, f.scope, monday, tuesday, 100)
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(mondayOnly) != 1 {
		t.Fatalf("Monday holds %d sales, want 1", len(mondayOnly))
	}
	if !mondayOnly[0].OccurredAt().Equal(monday) {
		t.Errorf("got the sale from %s, want Monday's", mondayOnly[0].OccurredAt())
	}

	both, err := f.repo.Between(f.ctx, f.scope, monday, tuesday.Add(24*time.Hour), 100)
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(both) != 2 {
		t.Errorf("the two days hold %d sales, want 2", len(both))
	}
	// Newest first, so a day's report opens on the most recent sale.
	if both[0].OccurredAt().Before(both[1].OccurredAt()) {
		t.Error("sales came back oldest first")
	}
}

func TestBetweenRefusesAnEmptyLimit(t *testing.T) {
	f := newSaleFixture(t)

	for _, limit := range []int{0, -1} {
		if _, err := f.repo.Between(f.ctx, f.scope, soldAt, soldAt.Add(time.Hour), limit); err == nil {
			t.Errorf("a limit of %d was accepted", limit)
		}
	}
}

func TestBetweenDoesNotCrossTenants(t *testing.T) {
	f, stranger := newSaleFixture(t), newSaleFixture(t)

	sale := f.sale(t)
	if err := f.repo.Record(f.ctx, f.scope, sale, nil, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	found, err := stranger.repo.Between(stranger.ctx, stranger.scope,
		soldAt.Add(-time.Hour), soldAt.Add(time.Hour), 100)
	if err != nil {
		t.Fatalf("Between: %v", err)
	}
	if len(found) != 0 {
		t.Errorf("another business saw %d sales", len(found))
	}
}

// The zero scope permits nothing, here as everywhere.
func TestTheSaleRepositoryRefusesTheZeroScope(t *testing.T) {
	f := newSaleFixture(t)
	sale := f.sale(t)

	if err := f.repo.Record(context.Background(), business.Scope{}, sale, nil, nil, nil); err == nil {
		t.Error("Record accepted the zero scope")
	}
	if _, err := f.repo.Get(context.Background(), business.Scope{}, sale.ID()); err == nil {
		t.Error("Get accepted the zero scope")
	}
	if _, err := f.repo.PaymentsOf(context.Background(), business.Scope{}, sale.ID()); err == nil {
		t.Error("PaymentsOf accepted the zero scope")
	}
	if _, err := f.repo.Between(context.Background(), business.Scope{}, soldAt, soldAt, 10); err == nil {
		t.Error("Between accepted the zero scope")
	}
}

// A caller passing nothing where a sale belongs is a bug, refused rather than
// written around.
func TestRecordingNothingIsRefused(t *testing.T) {
	f := newSaleFixture(t)

	if err := f.repo.Record(f.ctx, f.scope, nil, nil, nil, nil); err == nil {
		t.Error("a nil sale was accepted")
	}

	sale := f.sale(t)
	if err := f.repo.Record(f.ctx, f.scope, sale, []*sales.Payment{nil}, nil, nil); err == nil {
		t.Error("a nil payment was accepted")
	}
	if err := f.repo.Record(f.ctx, f.scope, sale, nil, []*inventory.Movement{nil}, nil); err == nil {
		t.Error("a nil movement was accepted")
	}
}

// A sale nobody has recorded is not found.
func TestAnUnknownSaleIsNotFound(t *testing.T) {
	f := newSaleFixture(t)

	if _, err := f.repo.Get(f.ctx, f.scope, sales.NewID()); err != postgres.ErrNotFound {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}
