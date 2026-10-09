package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// ledger is everything a movement needs to exist: a tenant, a product, someone
// who recorded it, and something they recorded it on.
type ledger struct {
	movements *postgres.MovementRepository
	productos *postgres.ProductRepository
	ctx       context.Context

	scope   business.Scope
	tenant  business.ID
	product products.ID
	user    users.ID
	device  devices.ID
}

func newLedger(t *testing.T) *ledger {
	t.Helper()

	pool := pgtest.Pool(t)
	ctx := context.Background()
	businesses := postgres.NewBusinessRepository(pool)
	userRepo := postgres.NewUserRepository(pool)
	deviceRepo := postgres.NewDeviceRepository(pool)
	productRepo := postgres.NewProductRepository(pool)

	tenant, scope := newTenant(t, businesses, ctx)

	user := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleInventory)
	if err := userRepo.Create(ctx, scope, user); err != nil {
		t.Fatalf("creating the user: %v", err)
	}
	device := newDevice(t, tenant.ID(), "Till 1")
	if err := deviceRepo.Create(ctx, scope, device); err != nil {
		t.Fatalf("creating the device: %v", err)
	}

	l := &ledger{
		movements: postgres.NewMovementRepository(pool),
		productos: productRepo,
		ctx:       ctx,
		scope:     scope,
		tenant:    tenant.ID(),
		user:      user.ID(),
		device:    device.ID(),
	}
	l.product = l.storedProduct(t, "Riz parfumé 5kg", quantity.Zero)
	return l
}

func (l *ledger) storedProduct(t *testing.T, name string, minimum quantity.Quantity) products.ID {
	t.Helper()

	product, err := products.New(products.Snapshot{
		ID:           products.NewID(),
		BusinessID:   l.tenant,
		Name:         name,
		Unit:         "sac",
		SellingPrice: money.FromXAF(6_500),
		MinimumStock: minimum,
		CreatedAt:    createdAt,
		UpdatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("products.New: %v", err)
	}
	if err := l.productos.Create(l.ctx, l.scope, product); err != nil {
		t.Fatalf("creating the product: %v", err)
	}
	return product.ID()
}

func (l *ledger) movement(
	t *testing.T, movementType inventory.MovementType, amount string, at time.Time,
) *inventory.Movement {
	t.Helper()

	snapshot := inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: l.tenant,
		ProductID:  l.product,
		Type:       movementType,
		Quantity:   quantity.MustParse(amount),
		UserID:     l.user,
		DeviceID:   l.device,
		OccurredAt: at,
		RecordedAt: at,
	}
	if movementType.RequiresReference() {
		snapshot.Reference = inventory.Reference{Kind: string(movementType), ID: "reference-1"}
	}
	if movementType.RequiresReason() {
		snapshot.Reason = "counted the shelf"
	}

	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}
	return movement
}

func TestAppendAndReadTheLedger(t *testing.T) {
	l := newLedger(t)

	appended := []*inventory.Movement{
		l.movement(t, inventory.Purchase, "100", createdAt),
		l.movement(t, inventory.Sale, "-3", createdAt.Add(time.Hour)),
		l.movement(t, inventory.Damage, "-2", createdAt.Add(2*time.Hour)),
	}
	for _, movement := range appended {
		if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	stored, err := l.movements.ListForProduct(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("ListForProduct: %v", err)
	}
	if len(stored) != 3 {
		t.Fatalf("got %d movements, want 3", len(stored))
	}
	for i, movement := range stored {
		if movement.Snapshot() != appended[i].Snapshot() {
			t.Errorf("movement %d round-tripped as %+v, want %+v", i,
				movement.Snapshot(), appended[i].Snapshot())
		}
	}
}

// TestTheLedgerIsAppendOnlyInTheDatabase is the point of the trigger. The
// domain refuses to edit a movement and the repository offers no way to, but
// the domain is not the only thing that can reach this table — a migration, a
// support script, or a future service could.
func TestTheLedgerIsAppendOnlyInTheDatabase(t *testing.T) {
	l := newLedger(t)
	pool := pgtest.Pool(t)

	movement := l.movement(t, inventory.Purchase, "100", createdAt)
	if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
		t.Fatalf("Append: %v", err)
	}

	t.Run("an update is refused", func(t *testing.T) {
		_, err := pool.Exec(l.ctx,
			`UPDATE inventory_movements SET quantity = 1 WHERE id = $1`, movement.ID().ID())
		if err == nil {
			t.Fatal("a movement was edited")
		}
		// And the row is untouched.
		level, err := l.movements.StockOf(l.ctx, l.scope, l.product)
		if err != nil {
			t.Fatalf("StockOf: %v", err)
		}
		if !level.OnHand.Equal(quantity.MustParse("100")) {
			t.Errorf("OnHand = %s after a refused edit, want 100", level.OnHand)
		}
	})

	t.Run("a delete is refused", func(t *testing.T) {
		_, err := pool.Exec(l.ctx,
			`DELETE FROM inventory_movements WHERE id = $1`, movement.ID().ID())
		if err == nil {
			t.Fatal("a movement was deleted")
		}
	})

	t.Run("a bulk update is refused", func(t *testing.T) {
		// The obvious way someone would try to "fix" stock across the board.
		if _, err := pool.Exec(l.ctx, `UPDATE inventory_movements SET quantity = 0`); err == nil {
			t.Fatal("the whole ledger was rewritten")
		}
	})
}

// TestStockIsDerivedByQuery checks the database's sum agrees with the domain's,
// since the query exists only as a faster route to the same answer.
func TestStockIsDerivedByQuery(t *testing.T) {
	l := newLedger(t)

	// The worked example from §7.
	for _, entry := range []struct {
		movementType inventory.MovementType
		amount       string
	}{
		{inventory.Purchase, "100"},
		{inventory.Sale, "-3"},
		{inventory.SaleReturn, "1"},
		{inventory.Damage, "-2"},
		{inventory.Adjustment, "5"},
	} {
		movement := l.movement(t, entry.movementType, entry.amount, createdAt)
		if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	fromQuery, err := l.movements.StockOf(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("StockOf: %v", err)
	}
	if want := quantity.MustParse("101"); !fromQuery.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s", fromQuery.OnHand, want)
	}
	if fromQuery.Movements != 5 {
		t.Errorf("Movements = %d, want 5", fromQuery.Movements)
	}

	// The same ledger summed in the domain must agree, or one of the two is
	// wrong and reports would disagree with the till.
	loaded, err := l.movements.ListForProduct(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("ListForProduct: %v", err)
	}
	inMemory, err := inventory.Derive(l.product, loaded)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if !fromQuery.OnHand.Equal(inMemory.OnHand) {
		t.Errorf("the database says %s and the domain says %s", fromQuery.OnHand, inMemory.OnHand)
	}
	if fromQuery.Movements != inMemory.Movements {
		t.Errorf("counts differ: %d against %d", fromQuery.Movements, inMemory.Movements)
	}
	if !fromQuery.LastMovedAt.Equal(inMemory.LastMovedAt) {
		t.Errorf("last movement differs: %s against %s", fromQuery.LastMovedAt, inMemory.LastMovedAt)
	}
}

func TestStockOfAProductWithNoMovements(t *testing.T) {
	l := newLedger(t)

	level, err := l.movements.StockOf(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("StockOf: %v", err)
	}
	if !level.OnHand.IsZero() {
		t.Errorf("OnHand = %s, want zero", level.OnHand)
	}
	if level.HasHistory() {
		t.Error("a product with no movements reports history")
	}
	if !level.LastMovedAt.IsZero() {
		t.Errorf("LastMovedAt = %s, want the zero time", level.LastMovedAt)
	}
}

// TestNegativeStockIsStoredAndReported is §29's case surviving the round trip:
// both sales stand, and the discrepancy reaches whoever needs to resolve it.
func TestNegativeStockIsStoredAndReported(t *testing.T) {
	l := newLedger(t)

	for _, entry := range []struct {
		movementType inventory.MovementType
		amount       string
	}{
		{inventory.Purchase, "1"},
		{inventory.Sale, "-1"}, // device A, offline
		{inventory.Sale, "-1"}, // device B, offline
	} {
		movement := l.movement(t, entry.movementType, entry.amount, createdAt)
		if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	level, err := l.movements.StockOf(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("StockOf: %v", err)
	}
	if want := quantity.MustParse("-1"); !level.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s: both sales must be kept", level.OnHand, want)
	}
	if !level.IsNegative() {
		t.Error("the discrepancy is not surfaced")
	}
	if level.Movements != 3 {
		t.Errorf("Movements = %d, want 3", level.Movements)
	}
}

// TestStockAsOfCountsWhenStockMoved covers the case that makes a report about
// last month mean anything, including a movement synced days after it happened.
func TestStockAsOfCountsWhenStockMoved(t *testing.T) {
	l := newLedger(t)

	purchase := l.movement(t, inventory.Purchase, "100", createdAt)
	if err := l.movements.Append(l.ctx, l.scope, purchase); err != nil {
		t.Fatalf("Append: %v", err)
	}

	cutoff := createdAt.Add(36 * time.Hour)
	before, err := l.movements.StockAsOf(l.ctx, l.scope, l.product, cutoff)
	if err != nil {
		t.Fatalf("StockAsOf: %v", err)
	}
	if want := quantity.MustParse("100"); !before.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s", before.OnHand, want)
	}

	// A sale from within the period arrives late, recorded now but dated then.
	late := inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: l.tenant,
		ProductID:  l.product,
		Type:       inventory.Sale,
		Quantity:   quantity.MustParse("-10"),
		Reference:  inventory.Reference{Kind: "SALE", ID: "sale-late"},
		UserID:     l.user,
		DeviceID:   l.device,
		OccurredAt: createdAt.Add(12 * time.Hour),
		RecordedAt: createdAt.Add(96 * time.Hour),
	}
	movement, err := inventory.Record(late)
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}
	if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
		t.Fatalf("Append: %v", err)
	}

	after, err := l.movements.StockAsOf(l.ctx, l.scope, l.product, cutoff)
	if err != nil {
		t.Fatalf("StockAsOf: %v", err)
	}
	if want := quantity.MustParse("90"); !after.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s: a late arrival dated in the period must count", after.OnHand, want)
	}

	if _, err := l.movements.StockAsOf(l.ctx, l.scope, l.product, time.Time{}); !errors.Is(err, inventory.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

// TestAppendAllIsOneFact: a sale of three lines moves three products' stock,
// and half of them landing would leave a ledger describing nothing that
// happened.
func TestAppendAllIsOneFact(t *testing.T) {
	l := newLedger(t)
	second := l.storedProduct(t, "Huile 1L", quantity.Zero)

	first := l.movement(t, inventory.Sale, "-2", createdAt)
	other := inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: l.tenant,
		ProductID:  second,
		Type:       inventory.Sale,
		Quantity:   quantity.MustParse("-1"),
		Reference:  inventory.Reference{Kind: "SALE", ID: "sale-1"},
		UserID:     l.user,
		DeviceID:   l.device,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	}
	secondMovement, err := inventory.Record(other)
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}

	if err := l.movements.AppendAll(l.ctx, l.scope, []*inventory.Movement{first, secondMovement}); err != nil {
		t.Fatalf("AppendAll: %v", err)
	}

	for _, entry := range []struct {
		product products.ID
		want    string
	}{{l.product, "-2"}, {second, "-1"}} {
		level, err := l.movements.StockOf(l.ctx, l.scope, entry.product)
		if err != nil {
			t.Fatalf("StockOf: %v", err)
		}
		if !level.OnHand.Equal(quantity.MustParse(entry.want)) {
			t.Errorf("OnHand = %s, want %s", level.OnHand, entry.want)
		}
	}
}

// TestAppendAllRollsBackTogether is the property the batch exists for.
func TestAppendAllRollsBackTogether(t *testing.T) {
	l := newLedger(t)

	good := l.movement(t, inventory.Purchase, "10", createdAt)
	// A movement for a product that does not exist: the foreign key rejects it,
	// after the first has already been queued.
	orphan, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: l.tenant,
		ProductID:  products.NewID(),
		Type:       inventory.Purchase,
		Quantity:   quantity.MustParse("5"),
		Reference:  inventory.Reference{Kind: "PURCHASE", ID: "p1"},
		UserID:     l.user,
		DeviceID:   l.device,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}

	if err := l.movements.AppendAll(l.ctx, l.scope, []*inventory.Movement{good, orphan}); err == nil {
		t.Fatal("AppendAll succeeded with an orphan movement")
	}

	level, err := l.movements.StockOf(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("StockOf: %v", err)
	}
	if !level.OnHand.IsZero() {
		t.Errorf("OnHand = %s, want zero: the first movement outlived the batch", level.OnHand)
	}
}

func TestAppendAllOfNothingIsHarmless(t *testing.T) {
	l := newLedger(t)
	if err := l.movements.AppendAll(l.ctx, l.scope, nil); err != nil {
		t.Errorf("AppendAll of nothing: %v", err)
	}
	if err := l.movements.AppendAll(l.ctx, l.scope, []*inventory.Movement{nil}); err == nil {
		t.Error("AppendAll accepted a missing movement")
	}
}

func TestLowStock(t *testing.T) {
	l := newLedger(t)

	tracked := l.storedProduct(t, "Sucre 1kg", quantity.MustParse("10"))
	untracked := l.storedProduct(t, "Sel 1kg", quantity.Zero)

	stock := func(product products.ID, amount string) {
		movement, err := inventory.Record(inventory.Snapshot{
			ID: inventory.NewMovementID(), BusinessID: l.tenant, ProductID: product,
			Type: inventory.Purchase, Quantity: quantity.MustParse(amount),
			Reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"},
			UserID:    l.user, DeviceID: l.device,
			OccurredAt: createdAt, RecordedAt: createdAt,
		})
		if err != nil {
			t.Fatalf("inventory.Record: %v", err)
		}
		if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	stock(tracked, "8")   // below its reorder point of 10
	stock(untracked, "1") // low, but not tracked for reordering

	low, err := l.movements.LowStock(l.ctx, l.scope)
	if err != nil {
		t.Fatalf("LowStock: %v", err)
	}

	seen := make(map[products.ID]quantity.Quantity, len(low))
	for _, item := range low {
		seen[item.ProductID] = item.OnHand
	}
	if onHand, listed := seen[tracked]; !listed {
		t.Error("a product below its reorder point is missing")
	} else if !onHand.Equal(quantity.MustParse("8")) {
		t.Errorf("OnHand = %s, want 8", onHand)
	}
	if _, listed := seen[untracked]; listed {
		t.Error("a product with no reorder point was listed as low")
	}
	// A product with a reorder point and no stock at all is low.
	if _, listed := seen[l.product]; listed {
		t.Error("the untracked default product was listed")
	}
}

// TestLowStockIncludesAProductThatNeverArrived: nothing on the shelf and a
// reorder point set is exactly the case an owner needs to see.
func TestLowStockIncludesAProductThatNeverArrived(t *testing.T) {
	l := newLedger(t)
	never := l.storedProduct(t, "Farine 1kg", quantity.MustParse("5"))

	low, err := l.movements.LowStock(l.ctx, l.scope)
	if err != nil {
		t.Fatalf("LowStock: %v", err)
	}

	for _, item := range low {
		if item.ProductID == never {
			if !item.OnHand.IsZero() {
				t.Errorf("OnHand = %s, want zero", item.OnHand)
			}
			return
		}
	}
	t.Error("a product with a reorder point and no stock was not listed")
}

// TestOneTenantCannotReachAnothersLedger is the isolation boundary over the
// table that decides what a business believes it has.
func TestOneTenantCannotReachAnothersLedger(t *testing.T) {
	first := newLedger(t)
	second := newLedger(t)

	movement := first.movement(t, inventory.Purchase, "100", createdAt)
	if err := first.movements.Append(first.ctx, first.scope, movement); err != nil {
		t.Fatalf("Append: %v", err)
	}

	// The other tenant sees nothing of it.
	level, err := second.movements.StockOf(second.ctx, second.scope, first.product)
	if err != nil {
		t.Fatalf("StockOf: %v", err)
	}
	if !level.OnHand.IsZero() || level.HasHistory() {
		t.Errorf("another tenant sees %s across %d movements", level.OnHand, level.Movements)
	}

	found, err := second.movements.ListForProduct(second.ctx, second.scope, first.product)
	if err != nil {
		t.Fatalf("ListForProduct: %v", err)
	}
	if len(found) != 0 {
		t.Errorf("another tenant read %d movements", len(found))
	}

	// And cannot write into it.
	if err := second.movements.Append(second.ctx, second.scope, movement); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
	if err := second.movements.AppendAll(second.ctx, second.scope, []*inventory.Movement{movement}); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

func TestEveryMovementOperationRefusesAnUnsetScope(t *testing.T) {
	l := newLedger(t)
	movement := l.movement(t, inventory.Purchase, "1", createdAt)

	var unset business.Scope

	operations := map[string]func() error{
		"Append":         func() error { return l.movements.Append(l.ctx, unset, movement) },
		"AppendAll":      func() error { return l.movements.AppendAll(l.ctx, unset, []*inventory.Movement{movement}) },
		"ListForProduct": func() error { _, err := l.movements.ListForProduct(l.ctx, unset, l.product); return err },
		"StockOf":        func() error { _, err := l.movements.StockOf(l.ctx, unset, l.product); return err },
		"StockAsOf":      func() error { _, err := l.movements.StockAsOf(l.ctx, unset, l.product, createdAt); return err },
		"LowStock":       func() error { _, err := l.movements.LowStock(l.ctx, unset); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestMovementOperationsRejectAZeroProduct(t *testing.T) {
	l := newLedger(t)

	if _, err := l.movements.ListForProduct(l.ctx, l.scope, products.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := l.movements.StockOf(l.ctx, l.scope, products.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestAppendingTheSameMovementTwiceConflicts(t *testing.T) {
	l := newLedger(t)
	movement := l.movement(t, inventory.Purchase, "10", createdAt)

	if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := l.movements.Append(l.ctx, l.scope, movement); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// TestTheSchemaRefusesAMovementTheDomainWould covers the constraints as a
// second line: the domain checks these, but a bad migration or a future service
// could reach the table directly.
func TestTheSchemaRefusesAMovementTheDomainWould(t *testing.T) {
	l := newLedger(t)
	pool := pgtest.Pool(t)

	insert := func(movementType string, amount int64, reason, referenceKind, referenceID any) error {
		_, err := pool.Exec(l.ctx, `
			INSERT INTO inventory_movements
				(id, business_id, product_id, type, quantity, reason,
				 reference_kind, reference_id, user_id, device_id, occurred_at, recorded_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())`,
			newUUID(t), l.tenant.ID(), l.product.ID(), movementType, amount,
			reason, referenceKind, referenceID, l.user.ID(), l.device.ID())
		return err
	}

	tests := []struct {
		name          string
		movementType  string
		amount        int64
		reason        any
		referenceKind any
		referenceID   any
	}{
		{"a movement of nothing", "ADJUSTMENT", 0, "counted", nil, nil},
		{"a purchase that removes stock", "PURCHASE", -1, nil, "PURCHASE", "p1"},
		{"a sale that adds stock", "SALE", 1, nil, "SALE", "s1"},
		{"an adjustment with no reason", "ADJUSTMENT", 5, nil, nil, nil},
		{"a write-off with a blank reason", "DAMAGE", -1, "   ", nil, nil},
		{"a sale with no reference", "SALE", -1, nil, nil, nil},
		{"half a reference", "ADJUSTMENT", 5, "counted", "SALE", nil},
		{"an unknown type", "TELEPORT", 5, "counted", nil, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := insert(tc.movementType, tc.amount, tc.reason, tc.referenceKind, tc.referenceID); err == nil {
				t.Error("the row was accepted, want a constraint violation")
			}
		})
	}
}

func TestMovementOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewMovementRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	movement, err := inventory.Record(inventory.Snapshot{
		ID: inventory.NewMovementID(), BusinessID: tenant, ProductID: products.NewID(),
		Type: inventory.Purchase, Quantity: quantity.MustParse("1"),
		Reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"},
		UserID:    users.NewID(), DeviceID: devices.NewID(),
		OccurredAt: createdAt, RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}

	operations := map[string]func() error{
		"Append":         func() error { return repo.Append(ctx, scope, movement) },
		"AppendAll":      func() error { return repo.AppendAll(ctx, scope, []*inventory.Movement{movement}) },
		"ListForProduct": func() error { _, err := repo.ListForProduct(ctx, scope, movement.ProductID()); return err },
		"StockOf":        func() error { _, err := repo.StockOf(ctx, scope, movement.ProductID()); return err },
		"LowStock":       func() error { _, err := repo.LowStock(ctx, scope); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}

// TestAUnitCostSurvivesTheRoundTrip is what inventory valuation rests on: §8
// requires stock to be valued at what was paid, and a cost that did not come
// back would silently value everything at zero.
func TestAUnitCostSurvivesTheRoundTrip(t *testing.T) {
	l := newLedger(t)

	costed, err := inventory.Record(inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: l.tenant,
		ProductID:  l.product,
		Type:       inventory.Purchase,
		Quantity:   quantity.MustParse("100"),
		UnitCost:   money.FromXAF(400),
		Reference:  inventory.Reference{Kind: "PURCHASE", ID: "purchase-7"},
		UserID:     l.user,
		DeviceID:   l.device,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}
	if err := l.movements.Append(l.ctx, l.scope, costed); err != nil {
		t.Fatalf("Append: %v", err)
	}

	stored, err := l.movements.ListForProduct(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("ListForProduct: %v", err)
	}
	if len(stored) != 1 {
		t.Fatalf("got %d movements, want 1", len(stored))
	}

	cost, recorded := stored[0].UnitCost()
	if !recorded {
		t.Fatal("the unit cost did not come back")
	}
	if cost.Amount() != 400 || cost.Currency() != money.XAF {
		t.Errorf("UnitCost() = %s, want 400 XAF", cost)
	}

	reference, present := stored[0].Reference()
	if !present || reference.Kind != "PURCHASE" || reference.ID != "purchase-7" {
		t.Errorf("Reference() = %v, %v", reference, present)
	}

	// And the valuation computed from what came back is the one §8 asks for.
	valuation, err := inventory.Value(l.product, stored)
	if err != nil {
		t.Fatalf("Value: %v", err)
	}
	if valuation.AverageUnitCostMinor != 400 {
		t.Errorf("AverageUnitCostMinor = %d, want 400", valuation.AverageUnitCostMinor)
	}
	if valuation.TotalCostMinor != 40_000 {
		t.Errorf("TotalCostMinor = %d, want 40000", valuation.TotalCostMinor)
	}
}

// TestAReasonSurvivesTheRoundTrip covers the other nullable text column, which
// is what an owner reads when asking why stock changed without a sale.
func TestAReasonSurvivesTheRoundTrip(t *testing.T) {
	l := newLedger(t)

	movement := l.movement(t, inventory.Adjustment, "5", createdAt)
	if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
		t.Fatalf("Append: %v", err)
	}

	stored, err := l.movements.ListForProduct(l.ctx, l.scope, l.product)
	if err != nil {
		t.Fatalf("ListForProduct: %v", err)
	}
	if got := stored[0].Reason(); got != "counted the shelf" {
		t.Errorf("Reason() = %q", got)
	}
	if !stored[0].IsSensitive() {
		t.Error("an adjustment came back without needing an audit record")
	}
	// A movement with no cost comes back with none, rather than zero.
	if cost, recorded := stored[0].UnitCost(); recorded {
		t.Errorf("an uncosted movement came back with %s", cost)
	}
}

// TestReadingAMovementWithAnUnknownCurrencyFails covers a row the schema
// permits but the domain does not.
func TestReadingAMovementWithAnUnknownCurrencyFails(t *testing.T) {
	l := newLedger(t)
	pool := pgtest.Pool(t)

	movement, err := inventory.Record(inventory.Snapshot{
		ID: inventory.NewMovementID(), BusinessID: l.tenant, ProductID: l.product,
		Type: inventory.Purchase, Quantity: quantity.MustParse("10"),
		UnitCost:  money.FromXAF(400),
		Reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"},
		UserID:    l.user, DeviceID: l.device,
		OccurredAt: createdAt, RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("inventory.Record: %v", err)
	}
	if err := l.movements.Append(l.ctx, l.scope, movement); err != nil {
		t.Fatalf("Append: %v", err)
	}

	// The ledger is append-only, so the constraint has to go before the row can
	// be corrupted — which is exactly the shape a bad migration would take.
	if _, err := pool.Exec(l.ctx,
		`ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_no_update`); err != nil {
		t.Fatalf("disabling the trigger: %v", err)
	}
	defer func() {
		if _, err := pool.Exec(l.ctx,
			`ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_no_update`); err != nil {
			t.Fatalf("restoring the trigger: %v", err)
		}
	}()

	if _, err := pool.Exec(l.ctx,
		`UPDATE inventory_movements SET unit_cost_currency = 'ZZZ' WHERE id = $1`,
		movement.ID().ID()); err != nil {
		t.Fatalf("planting the unknown currency: %v", err)
	}

	if _, err := l.movements.ListForProduct(l.ctx, l.scope, l.product); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}
