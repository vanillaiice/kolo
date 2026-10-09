package inventory_test

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

var (
	occurredAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	tenant     = business.NewID()
	product    = products.NewID()
	operator   = users.NewID()
	till       = devices.NewID()
)

type movementOptions struct {
	productID  products.ID
	movement   inventory.MovementType
	quantity   quantity.Quantity
	unitCost   money.Money
	reference  inventory.Reference
	reason     string
	occurredAt time.Time
	branchID   business.BranchID
}

func record(t *testing.T, options movementOptions) *inventory.Movement {
	t.Helper()

	snapshot := inventory.Snapshot{
		ID:         inventory.NewMovementID(),
		BusinessID: tenant,
		BranchID:   options.branchID,
		ProductID:  options.productID,
		Type:       options.movement,
		Quantity:   options.quantity,
		UnitCost:   options.unitCost,
		Reference:  options.reference,
		Reason:     options.reason,
		UserID:     operator,
		DeviceID:   till,
		OccurredAt: options.occurredAt,
		RecordedAt: options.occurredAt,
	}
	if snapshot.ProductID.IsZero() {
		snapshot.ProductID = product
	}
	if snapshot.OccurredAt.IsZero() {
		snapshot.OccurredAt, snapshot.RecordedAt = occurredAt, occurredAt
	}

	movement, err := inventory.Record(snapshot)
	if err != nil {
		t.Fatalf("recording a %s of %s: %v", options.movement, options.quantity, err)
	}
	return movement
}

// purchased and sold are the two movements almost every test needs.
func purchased(t *testing.T, units string, at time.Time) *inventory.Movement {
	t.Helper()
	return record(t, movementOptions{
		movement:   inventory.Purchase,
		quantity:   quantity.MustParse(units),
		reference:  inventory.Reference{Kind: "PURCHASE", ID: "purchase-1"},
		occurredAt: at,
	})
}

func sold(t *testing.T, units string, at time.Time) *inventory.Movement {
	t.Helper()
	return record(t, movementOptions{
		movement:   inventory.Sale,
		quantity:   quantity.MustParse("-" + units),
		reference:  inventory.Reference{Kind: "SALE", ID: "sale-1"},
		occurredAt: at,
	})
}

// TestStockIsTheSumOfTheLedger walks the worked example from §7 exactly.
func TestStockIsTheSumOfTheLedger(t *testing.T) {
	movements := []*inventory.Movement{
		purchased(t, "100", occurredAt),
		sold(t, "3", occurredAt.Add(time.Hour)),
		record(t, movementOptions{
			movement: inventory.SaleReturn, quantity: quantity.MustParse("1"),
			reference:  inventory.Reference{Kind: "SALE_RETURN", ID: "return-1"},
			occurredAt: occurredAt.Add(2 * time.Hour),
		}),
		record(t, movementOptions{
			movement: inventory.Damage, quantity: quantity.MustParse("-2"),
			reason: "water damage", occurredAt: occurredAt.Add(3 * time.Hour),
		}),
		record(t, movementOptions{
			movement: inventory.Adjustment, quantity: quantity.MustParse("5"),
			reason: "found in the storeroom", occurredAt: occurredAt.Add(4 * time.Hour),
		}),
	}

	level, err := inventory.Derive(product, movements)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}

	if want := quantity.MustParse("101"); !level.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s", level.OnHand, want)
	}
	if level.Movements != len(movements) {
		t.Errorf("Movements = %d, want %d", level.Movements, len(movements))
	}
	if want := occurredAt.Add(4 * time.Hour); !level.LastMovedAt.Equal(want) {
		t.Errorf("LastMovedAt = %s, want %s", level.LastMovedAt, want)
	}
}

// TestOrderDoesNotChangeTheTotal is the property that makes an append-only
// ledger work offline: a device syncing a week late inserts movements among
// ones already recorded, and the total must not depend on when they arrived.
func TestOrderDoesNotChangeTheTotal(t *testing.T) {
	movements := []*inventory.Movement{
		purchased(t, "100", occurredAt),
		sold(t, "3", occurredAt.Add(time.Hour)),
		sold(t, "7", occurredAt.Add(2*time.Hour)),
		purchased(t, "50", occurredAt.Add(3*time.Hour)),
	}

	forwards, err := inventory.Derive(product, movements)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}

	backwards, err := inventory.Derive(product, reversed(movements))
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}

	if !forwards.OnHand.Equal(backwards.OnHand) {
		t.Errorf("the total depends on order: %s forwards, %s backwards",
			forwards.OnHand, backwards.OnHand)
	}
	if !forwards.LastMovedAt.Equal(backwards.LastMovedAt) {
		t.Errorf("LastMovedAt depends on order: %s against %s",
			forwards.LastMovedAt, backwards.LastMovedAt)
	}
}

// TestTwoDevicesSellingTheLastUnit is the case §29 names and ADR-009 answers.
// Both movements are accepted; the total goes below zero, which is true.
func TestTwoDevicesSellingTheLastUnit(t *testing.T) {
	// Both devices believed there was one left.
	movements := []*inventory.Movement{
		purchased(t, "1", occurredAt),
		sold(t, "1", occurredAt.Add(time.Hour)), // device A, offline
		sold(t, "1", occurredAt.Add(time.Hour)), // device B, offline
	}

	level, err := inventory.Derive(product, movements)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}

	if want := quantity.MustParse("-1"); !level.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s: both sales must be kept", level.OnHand, want)
	}
	if !level.IsNegative() {
		t.Error("the discrepancy is not surfaced")
	}
	if level.Movements != 3 {
		t.Errorf("Movements = %d, want 3: neither sale may be discarded", level.Movements)
	}

	// And a count afterwards corrects it without deleting anything.
	corrected := append(movements, record(t, movementOptions{
		movement: inventory.StockCount, quantity: quantity.MustParse("1"),
		reason: "counted the shelf after a double sale", occurredAt: occurredAt.Add(2 * time.Hour),
	}))
	after, err := inventory.Derive(product, corrected)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if !after.OnHand.IsZero() {
		t.Errorf("OnHand = %s after the count, want zero", after.OnHand)
	}
	if after.Movements != 4 {
		t.Errorf("Movements = %d, want 4: the correction adds to history rather than editing it", after.Movements)
	}
}

func TestAnEmptyLedgerIsZeroWithNoHistory(t *testing.T) {
	level, err := inventory.Derive(product, nil)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}

	if !level.OnHand.IsZero() {
		t.Errorf("OnHand = %s, want zero", level.OnHand)
	}
	if level.HasHistory() {
		t.Error("an empty ledger reports history")
	}
	if !level.LastMovedAt.IsZero() {
		t.Errorf("LastMovedAt = %s, want the zero time", level.LastMovedAt)
	}
}

// TestDeriveRefusesAnotherProductsMovements keeps a caller's mixed-up slice from
// producing a quietly wrong total.
func TestDeriveRefusesAnotherProductsMovements(t *testing.T) {
	other := products.NewID()
	movements := []*inventory.Movement{
		purchased(t, "10", occurredAt),
		record(t, movementOptions{
			productID: other, movement: inventory.Purchase,
			quantity:  quantity.MustParse("5"),
			reference: inventory.Reference{Kind: "PURCHASE", ID: "purchase-2"},
		}),
	}

	if _, err := inventory.Derive(product, movements); err == nil {
		t.Error("Derive accepted a movement for another product")
	}
	if _, err := inventory.Derive(products.ID{}, nil); !errors.Is(err, inventory.ErrInvalidID) {
		t.Errorf("got %v, want ErrInvalidID", err)
	}
	if _, err := inventory.Derive(product, []*inventory.Movement{nil}); err == nil {
		t.Error("Derive accepted a missing movement")
	}
}

func TestFractionalQuantitiesStaySexact(t *testing.T) {
	// A tenth of a kilo, ten times, must be exactly one kilo. With floating
	// point it is not, which is why quantities are integers underneath.
	movements := make([]*inventory.Movement, 0, 10)
	for i := range 10 {
		movements = append(movements, record(t, movementOptions{
			movement:   inventory.Purchase,
			quantity:   quantity.MustParse("0.1"),
			reference:  inventory.Reference{Kind: "PURCHASE", ID: "purchase-1"},
			occurredAt: occurredAt.Add(time.Duration(i) * time.Minute),
		}))
	}

	level, err := inventory.Derive(product, movements)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if want := quantity.MustParse("1"); !level.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want exactly %s", level.OnHand, want)
	}
}

func TestDeriveAll(t *testing.T) {
	rice, oil := products.NewID(), products.NewID()

	movements := []*inventory.Movement{
		record(t, movementOptions{productID: rice, movement: inventory.Purchase,
			quantity: quantity.MustParse("100"), reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"}}),
		record(t, movementOptions{productID: rice, movement: inventory.Sale,
			quantity: quantity.MustParse("-30"), reference: inventory.Reference{Kind: "SALE", ID: "s1"}}),
		record(t, movementOptions{productID: oil, movement: inventory.Purchase,
			quantity: quantity.MustParse("20"), reference: inventory.Reference{Kind: "PURCHASE", ID: "p2"}}),
	}

	levels, err := inventory.DeriveAll(movements)
	if err != nil {
		t.Fatalf("DeriveAll: %v", err)
	}

	if got := levels[rice].OnHand; !got.Equal(quantity.MustParse("70")) {
		t.Errorf("rice = %s, want 70", got)
	}
	if got := levels[oil].OnHand; !got.Equal(quantity.MustParse("20")) {
		t.Errorf("oil = %s, want 20", got)
	}

	// A product with no movements is absent rather than present at zero, so
	// "never stocked" and "sold out" do not look the same.
	if _, present := levels[products.NewID()]; present {
		t.Error("a product with no movements appeared in the result")
	}
}

// TestDeriveAsOfCountsWhatHadHappened is what makes a report about last month
// mean anything.
func TestDeriveAsOfCountsWhatHadHappened(t *testing.T) {
	movements := []*inventory.Movement{
		purchased(t, "100", occurredAt),
		sold(t, "10", occurredAt.Add(24*time.Hour)),
		sold(t, "20", occurredAt.Add(48*time.Hour)),
	}

	cutoff := occurredAt.Add(36 * time.Hour)
	level, err := inventory.DeriveAsOf(product, movements, cutoff)
	if err != nil {
		t.Fatalf("DeriveAsOf: %v", err)
	}
	if want := quantity.MustParse("90"); !level.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s", level.OnHand, want)
	}

	// A movement exactly at the cutoff had happened by then.
	atCutoff, err := inventory.DeriveAsOf(product, movements, occurredAt.Add(24*time.Hour))
	if err != nil {
		t.Fatalf("DeriveAsOf: %v", err)
	}
	if want := quantity.MustParse("90"); !atCutoff.OnHand.Equal(want) {
		t.Errorf("at the cutoff OnHand = %s, want %s", atCutoff.OnHand, want)
	}

	if _, err := inventory.DeriveAsOf(product, movements, time.Time{}); !errors.Is(err, inventory.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

// TestALateArrivalChangesThePastNotThePresentCount is the consequence of
// occurrence time governing reports: a movement synced days after it happened
// is counted in the period it belongs to.
func TestALateArrivalChangesThePastNotThePresentCount(t *testing.T) {
	cutoff := occurredAt.Add(36 * time.Hour)

	early := []*inventory.Movement{
		purchased(t, "100", occurredAt),
	}
	before, err := inventory.DeriveAsOf(product, early, cutoff)
	if err != nil {
		t.Fatalf("DeriveAsOf: %v", err)
	}

	// A sale from yesterday arrives from a device that was offline.
	late := append(early, sold(t, "10", occurredAt.Add(12*time.Hour)))
	after, err := inventory.DeriveAsOf(product, late, cutoff)
	if err != nil {
		t.Fatalf("DeriveAsOf: %v", err)
	}

	if before.OnHand.Equal(after.OnHand) {
		t.Error("a late arrival dated before the cutoff was not counted in that period")
	}
	if want := quantity.MustParse("90"); !after.OnHand.Equal(want) {
		t.Errorf("OnHand = %s, want %s", after.OnHand, want)
	}
}

// TestValuationUsesWhatStockCost pins §8: inventory is valued at purchase cost,
// not at what it sells for.
func TestValuationUsesWhatStockCost(t *testing.T) {
	movements := []*inventory.Movement{
		record(t, movementOptions{
			movement: inventory.Purchase, quantity: quantity.MustParse("100"),
			unitCost:  money.FromXAF(400),
			reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"},
		}),
		record(t, movementOptions{
			movement: inventory.Purchase, quantity: quantity.MustParse("100"),
			unitCost:  money.FromXAF(600),
			reference: inventory.Reference{Kind: "PURCHASE", ID: "p2"},
		}),
		sold(t, "50", occurredAt.Add(time.Hour)),
	}

	valuation, err := inventory.Value(product, movements)
	if err != nil {
		t.Fatalf("Value: %v", err)
	}

	// Two deliveries of 100 at 400 and 600 average 500 a unit.
	if valuation.AverageUnitCostMinor != 500 {
		t.Errorf("AverageUnitCostMinor = %d, want 500", valuation.AverageUnitCostMinor)
	}
	// 150 left at 500 each.
	if valuation.TotalCostMinor != 75_000 {
		t.Errorf("TotalCostMinor = %d, want 75000", valuation.TotalCostMinor)
	}
	if valuation.Costed != 2 {
		t.Errorf("Costed = %d, want 2", valuation.Costed)
	}
}

// TestASaleDoesNotChangeWhatRemainingStockCost is why only inward movements are
// valued: a sale's price is revenue, not cost.
func TestASaleDoesNotChangeWhatRemainingStockCost(t *testing.T) {
	purchase := record(t, movementOptions{
		movement: inventory.Purchase, quantity: quantity.MustParse("10"),
		unitCost:  money.FromXAF(400),
		reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"},
	})

	before, err := inventory.Value(product, []*inventory.Movement{purchase})
	if err != nil {
		t.Fatalf("Value: %v", err)
	}

	withSale := []*inventory.Movement{purchase, sold(t, "4", occurredAt.Add(time.Hour))}
	after, err := inventory.Value(product, withSale)
	if err != nil {
		t.Fatalf("Value: %v", err)
	}

	if before.AverageUnitCostMinor != after.AverageUnitCostMinor {
		t.Errorf("the average cost changed from %d to %d because of a sale",
			before.AverageUnitCostMinor, after.AverageUnitCostMinor)
	}
	// The total falls because there is less stock, not because it is worth less.
	if after.TotalCostMinor != 2_400 {
		t.Errorf("TotalCostMinor = %d, want 2400", after.TotalCostMinor)
	}
}

func TestValuationWithNoCostsRecorded(t *testing.T) {
	movements := []*inventory.Movement{
		record(t, movementOptions{
			movement: inventory.OpeningBalance, quantity: quantity.MustParse("10"),
		}),
	}

	valuation, err := inventory.Value(product, movements)
	if err != nil {
		t.Fatalf("Value: %v", err)
	}
	if valuation.AverageUnitCostMinor != 0 || valuation.TotalCostMinor != 0 {
		t.Errorf("an uncosted ledger valued at %d a unit, %d total",
			valuation.AverageUnitCostMinor, valuation.TotalCostMinor)
	}
	// Costed says the valuation rests on nothing, so a caller can say so
	// rather than reporting a confident zero.
	if valuation.Costed != 0 {
		t.Errorf("Costed = %d, want 0", valuation.Costed)
	}
	if !valuation.OnHand.Equal(quantity.MustParse("10")) {
		t.Errorf("OnHand = %s, want 10", valuation.OnHand)
	}
}

func TestBelowMinimum(t *testing.T) {
	tests := []struct {
		name    string
		onHand  string
		minimum string
		want    bool
	}{
		{"well stocked", "100", "10", false},
		{"exactly at the reorder point", "10", "10", true},
		{"below it", "9", "10", true},
		{"none left", "0", "10", true},
		{"negative", "-1", "10", true},
		{"not tracked for reordering", "0", "0", false},
		{"a nonsensical minimum", "0", "-5", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			level := inventory.StockLevel{
				ProductID: product,
				OnHand:    quantity.MustParse(tc.onHand),
			}
			if got := inventory.BelowMinimum(level, quantity.MustParse(tc.minimum)); got != tc.want {
				t.Errorf("BelowMinimum(%s, %s) = %v, want %v", tc.onHand, tc.minimum, got, tc.want)
			}
		})
	}
}

func reversed(movements []*inventory.Movement) []*inventory.Movement {
	out := make([]*inventory.Movement, len(movements))
	for i, movement := range movements {
		out[len(movements)-1-i] = movement
	}
	return out
}

// TestDerivationRefusesAMissingMovementEverywhere keeps a nil in a caller's
// slice from being counted as zero.
func TestDerivationRefusesAMissingMovementEverywhere(t *testing.T) {
	withNil := []*inventory.Movement{nil}

	if _, err := inventory.DeriveAll(withNil); err == nil {
		t.Error("DeriveAll accepted a missing movement")
	}
	if _, err := inventory.DeriveAsOf(product, withNil, occurredAt); err == nil {
		t.Error("DeriveAsOf accepted a missing movement")
	}
	if _, err := inventory.Value(product, withNil); err == nil {
		t.Error("Value accepted a missing movement")
	}
}

// TestValueRefusesAnotherProductsMovements follows from Value deriving first.
func TestValueRefusesAnotherProductsMovements(t *testing.T) {
	other := record(t, movementOptions{
		productID: products.NewID(), movement: inventory.Purchase,
		quantity:  quantity.MustParse("5"),
		reference: inventory.Reference{Kind: "PURCHASE", ID: "p9"},
	})

	if _, err := inventory.Value(product, []*inventory.Movement{other}); err == nil {
		t.Error("Value accepted a movement for another product")
	}
}

// TestSummingPastTheRepresentableRangeIsReported keeps a ledger that cannot be
// summed from producing a wrapped total that looks plausible.
func TestSummingPastTheRepresentableRangeIsReported(t *testing.T) {
	enormous := func() *inventory.Movement {
		movement, err := inventory.Record(inventory.Snapshot{
			ID: inventory.NewMovementID(), BusinessID: tenant, ProductID: product,
			Type:      inventory.Purchase,
			Quantity:  quantity.FromThousandths(math.MaxInt64),
			Reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"},
			UserID:    operator, DeviceID: till,
			OccurredAt: occurredAt, RecordedAt: occurredAt,
		})
		if err != nil {
			t.Fatalf("Record: %v", err)
		}
		return movement
	}
	movements := []*inventory.Movement{enormous(), enormous()}

	if _, err := inventory.Derive(product, movements); !errors.Is(err, quantity.ErrOverflow) {
		t.Errorf("Derive: got %v, want ErrOverflow", err)
	}
	if _, err := inventory.DeriveAll(movements); !errors.Is(err, quantity.ErrOverflow) {
		t.Errorf("DeriveAll: got %v, want ErrOverflow", err)
	}
}

// TestValuingPastTheRepresentableRangeIsReported is the same guard on the money
// side of the calculation.
func TestValuingPastTheRepresentableRangeIsReported(t *testing.T) {
	movement, err := inventory.Record(inventory.Snapshot{
		ID: inventory.NewMovementID(), BusinessID: tenant, ProductID: product,
		Type:      inventory.Purchase,
		Quantity:  quantity.FromThousandths(math.MaxInt64),
		UnitCost:  money.FromXAF(math.MaxInt64),
		Reference: inventory.Reference{Kind: "PURCHASE", ID: "p1"},
		UserID:    operator, DeviceID: till,
		OccurredAt: occurredAt, RecordedAt: occurredAt,
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}

	if _, err := inventory.Value(product, []*inventory.Movement{movement}); err == nil {
		t.Error("Value produced a figure that cannot be represented")
	}
}
