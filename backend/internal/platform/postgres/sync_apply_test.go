package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// applyFixture is a sync fixture with a product to move and a way to read the
// resulting stock back.
type applyFixture struct {
	*syncFixture
	movements *postgres.MovementRepository
	product   products.ID
	pool      *pgxpool.Pool
}

func newApplyFixture(t *testing.T) *applyFixture {
	t.Helper()

	base := newSyncFixture(t)
	pool := pgtest.Pool(t)
	productRepo := postgres.NewProductRepository(pool)

	product := fullProduct(t, base.tenant)
	if err := productRepo.Create(base.ctx, base.scope, product); err != nil {
		t.Fatalf("creating the product: %v", err)
	}

	return &applyFixture{
		syncFixture: base,
		movements:   postgres.NewMovementRepository(pool),
		product:     product.ID(),
		pool:        pool,
	}
}

// movement builds a movement of the given size against the fixture's product.
func (f *applyFixture) movement(t *testing.T, units int64) *inventory.Movement {
	t.Helper()
	return f.movementWithID(t, inventory.NewMovementID(), units)
}

func (f *applyFixture) movementWithID(
	t *testing.T, movementID inventory.MovementID, units int64,
) *inventory.Movement {
	t.Helper()

	amount, err := quantity.FromUnits(units)
	if err != nil {
		t.Fatalf("quantity.FromUnits: %v", err)
	}
	movement, err := inventory.Record(inventory.Snapshot{
		ID:         movementID,
		BusinessID: f.tenant,
		ProductID:  f.product,
		Type:       inventory.Adjustment,
		Quantity:   amount,
		Reason:     "a stock count",
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}
	return movement
}

func (f *applyFixture) event(t *testing.T, sequence int64) *sync.Event {
	t.Helper()

	event, err := sync.New(f.envelope(f.till, sequence))
	if err != nil {
		t.Fatalf("sync.New: %v", err)
	}
	return event
}

// stock reads what the ledger now says, in thousandths, which is a sum of
// movements and never a stored number (§7, ADR-009).
func (f *applyFixture) stock(t *testing.T) int64 {
	t.Helper()

	level, err := f.movements.StockOf(f.ctx, f.scope, f.product)
	if err != nil {
		t.Fatalf("StockOf: %v", err)
	}
	return level.OnHand.Thousandths()
}

// An applied event moves stock and files the event, both at once.
func TestRecordAndApplyAppliesAndRecords(t *testing.T) {
	f := newApplyFixture(t)

	outcome, err := f.events.RecordAndApply(
		f.ctx, f.scope, f.event(t, 1), postgres.Effects{Movements: []*inventory.Movement{f.movement(t, 12)}})
	if err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}
	if outcome != postgres.Recorded {
		t.Errorf("got %v, want Recorded", outcome)
	}
	if got := f.stock(t); got != 12_000 {
		t.Errorf("stock = %d, want 12 units", got)
	}
}

// The point of the transaction: a replay files nothing and moves nothing. Two
// devices resending a backlog must not double the shop's stock.
func TestReplayingAnAppliedEventMovesNoStock(t *testing.T) {
	f := newApplyFixture(t)

	event := f.event(t, 1)
	movements := []*inventory.Movement{f.movement(t, 12)}

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, event, postgres.Effects{Movements: movements}); err != nil {
		t.Fatalf("the first push: %v", err)
	}
	for attempt := range 3 {
		outcome, err := f.events.RecordAndApply(f.ctx, f.scope, event, postgres.Effects{Movements: movements})
		if err != nil {
			t.Fatalf("replay %d: %v", attempt, err)
		}
		if outcome != postgres.AlreadyRecorded {
			t.Errorf("replay %d gave %v, want AlreadyRecorded", attempt, outcome)
		}
	}

	if got := f.stock(t); got != 12_000 {
		t.Errorf("stock = %d after three replays, want 12 units", got)
	}
}

// The failure the transaction exists for. A movement the database refuses must
// take the event down with it — an event left recorded would tell the device to
// stop resending stock that never landed.
func TestAnEventIsNotRecordedWhenItsMovementsCannotBe(t *testing.T) {
	f := newApplyFixture(t)

	// A movement against a product from no business, which the foreign key
	// refuses. The event beside it is perfectly valid.
	orphan, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: f.tenant,
		ProductID:  products.NewID(),
		Type:       inventory.Adjustment,
		Quantity:   quantity.FromThousandths(5000),
		Reason:     "a stock count",
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}

	event := f.event(t, 1)
	good := f.movement(t, 12)
	if _, err := f.events.RecordAndApply(
		f.ctx, f.scope, event, postgres.Effects{Movements: []*inventory.Movement{good, orphan}}); err == nil {
		t.Fatal("a movement against an unknown product was accepted")
	}

	// Neither the event nor the good movement beside it survived.
	if got := f.stock(t); got != 0 {
		t.Errorf("stock = %d, want 0: a movement landed from a transaction that failed", got)
	}
	stored, err := f.events.Since(f.ctx, f.scope, 0, devices.ID{}, 10)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(stored) != 0 {
		t.Error("the event was recorded even though its movements were not")
	}

	// And the same event goes through once the bad movement is gone, which is
	// what makes the retry worth making.
	if _, err := f.events.RecordAndApply(
		f.ctx, f.scope, event, postgres.Effects{Movements: []*inventory.Movement{good}}); err != nil {
		t.Fatalf("the retry: %v", err)
	}
	if got := f.stock(t); got != 12_000 {
		t.Errorf("stock = %d after the retry, want 12 units", got)
	}
}

// A movement identifier already in the ledger is refused, and takes its event
// with it. Nothing is applied twice under a new event identifier.
func TestAReusedMovementIdentifierIsRefused(t *testing.T) {
	f := newApplyFixture(t)

	shared := inventory.NewMovementID()
	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
		postgres.Effects{Movements: []*inventory.Movement{f.movementWithID(t, shared, 12)}}); err != nil {
		t.Fatalf("the first event: %v", err)
	}

	err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 2),
		postgres.Effects{Movements: []*inventory.Movement{f.movementWithID(t, shared, 99)}}))
	if err == nil {
		t.Fatal("a reused movement identifier was accepted")
	}
	if !postgres.IsUniqueViolation(err) {
		t.Errorf("error = %v, want a unique violation the service can turn into a rejection", err)
	}
	if got := f.stock(t); got != 12_000 {
		t.Errorf("stock = %d, want the original 12 units", got)
	}
}

// A movement for another business is refused before anything is written, even
// though the event itself is in scope (ADR-008).
func TestAMovementOutsideTheScopeIsRefused(t *testing.T) {
	f := newApplyFixture(t)

	stranger, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: business.NewID(),
		ProductID:  f.product,
		Type:       inventory.Adjustment,
		Quantity:   quantity.FromThousandths(5000),
		Reason:     "a stock count",
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}

	if _, err := f.events.RecordAndApply(
		f.ctx, f.scope, f.event(t, 1), postgres.Effects{Movements: []*inventory.Movement{stranger}}); err == nil {
		t.Fatal("a movement for another business was accepted")
	}
	if got := f.stock(t); got != 0 {
		t.Errorf("stock = %d, want 0", got)
	}
}

// An event with no movements is still an event. Nothing about applying makes
// the event log conditional on there being something to apply.
func TestAnEventWithNoMovementsIsStillRecorded(t *testing.T) {
	f := newApplyFixture(t)

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1), postgres.Effects{}); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}
	stored, err := f.events.Since(f.ctx, f.scope, 0, devices.ID{}, 10)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(stored) != 1 {
		t.Errorf("the log holds %d events, want 1", len(stored))
	}
}

// A nil movement in the slice is a caller bug, and is refused rather than
// written around.
func TestANilMovementIsRefused(t *testing.T) {
	f := newApplyFixture(t)

	if _, err := f.events.RecordAndApply(
		f.ctx, f.scope, f.event(t, 1),
		postgres.Effects{Movements: []*inventory.Movement{f.movement(t, 3), nil}}); err == nil {
		t.Fatal("a nil movement was accepted")
	}
	if got := f.stock(t); got != 0 {
		t.Errorf("stock = %d, want 0", got)
	}
}

// The zero scope permits nothing, here as everywhere (ADR-008).
func TestApplyingRefusesTheZeroScope(t *testing.T) {
	f := newApplyFixture(t)

	if _, err := f.events.RecordAndApply(
		context.Background(), business.Scope{}, f.event(t, 1),
		postgres.Effects{Movements: []*inventory.Movement{f.movement(t, 3)}}); err == nil {
		t.Fatal("the zero scope was accepted")
	}
}

// A sale arriving from another till lands whole — the sale, its payment, the
// stock it released, and the debt it left — in the one transaction that also
// files the event.
func TestAnAppliedSaleLandsWithItsCredit(t *testing.T) {
	f := newSaleFixture(t)

	customerID := f.customer(t, "Jean Mbarga")
	sale := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })
	effects := postgres.Effects{
		Sale:      sale,
		Payments:  []*sales.Payment{f.payment(t, sale, 10_000)},
		Movements: []*inventory.Movement{f.soldMovement(t, sale, 2)},
		Credit:    f.creditFor(t, sale, customerID, 3_000),
	}

	event := f.event(t, 1)
	if _, err := f.events.RecordAndApply(f.ctx, f.scope, event, effects); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}

	ledger := postgres.NewCreditRepository(f.pool)
	balance, err := ledger.BalanceOf(f.ctx, f.scope, customerID)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if got := balance.Outstanding; !got.Equal(money.FromXAF(3_000)) {
		t.Errorf("outstanding = %s, want 3000 XAF", got)
	}

	// A till resending its backlog must not put the debt on twice (§27).
	outcome, err := f.events.RecordAndApply(f.ctx, f.scope, event, effects)
	if err != nil {
		t.Fatalf("replaying: %v", err)
	}
	if outcome != postgres.AlreadyRecorded {
		t.Errorf("outcome = %v, want AlreadyRecorded", outcome)
	}
	balance, err = ledger.BalanceOf(f.ctx, f.scope, customerID)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if balance.Entries != 1 {
		t.Errorf("the ledger holds %d entries after a resend, want 1", balance.Entries)
	}
}

// A debt arriving on its own would be a balance appearing from nowhere, with no
// sale a customer could be shown to explain it.
func TestACreditEntryWithoutItsSaleIsRefused(t *testing.T) {
	f := newSaleFixture(t)

	customerID := f.customer(t, "Jean Mbarga")
	sale := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })

	err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
		postgres.Effects{Credit: f.creditFor(t, sale, customerID, 3_000)}))
	if !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// The entry must be against the sale the event carries. One naming a different
// sale would put a debt on a customer for a purchase this event says nothing
// about.
func TestACreditEntryAgainstAnotherSaleIsRefused(t *testing.T) {
	f := newSaleFixture(t)

	customerID := f.customer(t, "Jean Mbarga")
	sale := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })
	elsewhere := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })

	err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1), postgres.Effects{
		Sale:   sale,
		Credit: f.creditFor(t, elsewhere, customerID, 13_000),
	}))
	if !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// Another tenant's debt cannot be written through this event, whatever the
// payload said (ADR-008).
func TestACreditEntryOutsideTheScopeIsRefused(t *testing.T) {
	f, other := newSaleFixture(t), newSaleFixture(t)

	customerID := other.customer(t, "Jean Mbarga")
	sale := other.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })

	err := errFrom(f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1), postgres.Effects{
		Sale:   f.sale(t),
		Credit: other.creditFor(t, sale, customerID, 3_000),
	}))
	if !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

// errFrom drops the outcome so a test can speak about the error alone.
func errFrom(_ postgres.RecordOutcome, err error) error { return err }
