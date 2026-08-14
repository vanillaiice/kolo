package inventory

import (
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// StockLevel is what a product's ledger adds up to.
//
// It is derived, never stored. Nothing writes a stock level; this is what you
// get by summing movements (§59, ADR-009). A repository may keep a rebuildable
// projection of it for speed, but that projection is a cache of this
// calculation and never a second source of truth.
type StockLevel struct {
	ProductID products.ID
	// OnHand is the sum of every movement.
	OnHand quantity.Quantity
	// Movements is how many entries the sum came from, so a caller can tell
	// "no stock because nothing ever arrived" from "no stock because it all
	// sold".
	Movements int
	// LastMovedAt is when the most recent movement occurred, or the zero time
	// if there were none.
	LastMovedAt time.Time
}

// IsNegative reports whether more has left than ever arrived.
//
// This is not corrupt data. Two devices each selling the last unit offline is
// expected (§29), and the honest total is below zero until someone counts the
// shelf and records an adjustment. Callers surface it rather than clamping it:
// clamping would hide the very discrepancy the owner needs to see.
func (s StockLevel) IsNegative() bool { return s.OnHand.IsNegative() }

// HasHistory reports whether any movement was ever recorded.
func (s StockLevel) HasHistory() bool { return s.Movements > 0 }

// Derive sums a product's movements into its stock level.
//
// The movements need not be in any order: addition does not care, and a device
// syncing a week late inserts movements among ones already recorded. That is
// the property that makes an append-only ledger work offline — a late arrival
// changes the total without disturbing anything already counted.
//
// Movements for other products are an error rather than something to skip
// silently, because a caller mixing products has a bug that a quietly wrong
// total would hide.
func Derive(productID products.ID, movements []*Movement) (StockLevel, error) {
	if productID.IsZero() {
		return StockLevel{}, fmt.Errorf("%w: product", ErrInvalidID)
	}

	level := StockLevel{ProductID: productID}
	for i, movement := range movements {
		if movement == nil {
			return StockLevel{}, fmt.Errorf("inventory: movement %d is missing", i)
		}
		if movement.ProductID() != productID {
			return StockLevel{}, fmt.Errorf(
				"inventory: movement %s is for product %s, not %s",
				movement.ID(), movement.ProductID(), productID)
		}

		total, err := level.OnHand.Add(movement.Quantity())
		if err != nil {
			return StockLevel{}, fmt.Errorf("inventory: summing product %s: %w", productID, err)
		}
		level.OnHand = total
		level.Movements++

		if movement.OccurredAt().After(level.LastMovedAt) {
			level.LastMovedAt = movement.OccurredAt()
		}
	}
	return level, nil
}

// DeriveAll sums movements for many products at once, which is what a stock
// report or a low-stock check needs.
//
// Products with no movements are absent from the result rather than present at
// zero: the caller knows which products it asked about, and inventing entries
// for products that were never stocked would make "never stocked" and "sold
// out" look the same.
func DeriveAll(movements []*Movement) (map[products.ID]StockLevel, error) {
	levels := make(map[products.ID]StockLevel)

	for i, movement := range movements {
		if movement == nil {
			return nil, fmt.Errorf("inventory: movement %d is missing", i)
		}

		productID := movement.ProductID()
		level, seen := levels[productID]
		if !seen {
			level = StockLevel{ProductID: productID}
		}

		total, err := level.OnHand.Add(movement.Quantity())
		if err != nil {
			return nil, fmt.Errorf("inventory: summing product %s: %w", productID, err)
		}
		level.OnHand = total
		level.Movements++
		if movement.OccurredAt().After(level.LastMovedAt) {
			level.LastMovedAt = movement.OccurredAt()
		}

		levels[productID] = level
	}
	return levels, nil
}

// DeriveAsOf sums only the movements that had occurred by a given moment.
//
// This is what makes a report about last month mean anything: it must count
// what had happened by then, not what the ledger looks like now. A movement
// synced afterwards but dated earlier is included, because it did happen then —
// which is also why a report run twice over the same past period can legitimately
// differ, and why reports say when they were produced.
func DeriveAsOf(productID products.ID, movements []*Movement, asOf time.Time) (StockLevel, error) {
	if asOf.IsZero() {
		return StockLevel{}, fmt.Errorf("%w: no moment given", ErrInvalidTime)
	}

	within := make([]*Movement, 0, len(movements))
	for i, movement := range movements {
		if movement == nil {
			return StockLevel{}, fmt.Errorf("inventory: movement %d is missing", i)
		}
		if !movement.OccurredAt().After(asOf) {
			within = append(within, movement)
		}
	}
	return Derive(productID, within)
}

// Valuation is what stock is worth at what it cost.
//
// §8 requires purchase cost to be retained rather than assuming selling price
// equals inventory value. This is the simplest method that respects that: the
// weighted average of what arrived. FIFO and the rest can be added later
// because the ledger keeps the per-movement costs they need (ADR-009).
type Valuation struct {
	ProductID products.ID
	// OnHand is the stock the valuation is for.
	OnHand quantity.Quantity
	// AverageUnitCost is the weighted average of what arriving stock cost, in
	// minor units. Zero when nothing with a cost ever arrived.
	AverageUnitCostMinor int64
	// TotalCostMinor is OnHand valued at that average.
	TotalCostMinor int64
	// Costed is how many inward movements carried a cost. A caller can tell a
	// valuation resting on complete information from one resting on a single
	// priced delivery.
	Costed int
}

// Value returns what a product's stock is worth, by weighted average cost.
//
// Only inward movements are considered. Stock leaving does not change what the
// remaining stock cost, and a sale's price is revenue rather than cost.
//
// The average is computed over quantities and costs as integers throughout, so
// there is no rounding until the final total.
func Value(productID products.ID, movements []*Movement) (Valuation, error) {
	level, err := Derive(productID, movements)
	if err != nil {
		return Valuation{}, err
	}

	valuation := Valuation{ProductID: productID, OnHand: level.OnHand}

	var (
		costedThousandths int64
		costedTotalMinor  int64
	)
	for _, movement := range movements {
		cost, hasCost := movement.UnitCost()
		if !hasCost || !movement.Quantity().IsPositive() {
			continue
		}

		thousandths := movement.Quantity().Thousandths()
		lineCost, err := cost.Mul(thousandths)
		if err != nil {
			return Valuation{}, fmt.Errorf("inventory: valuing product %s: %w", productID, err)
		}

		costedThousandths += thousandths
		costedTotalMinor += lineCost.Amount()
		valuation.Costed++
	}

	if costedThousandths == 0 {
		return valuation, nil
	}

	// costedTotalMinor is already scaled by quantity.Scale, so dividing by the
	// scaled quantity gives a per-unit figure without a second scaling step.
	valuation.AverageUnitCostMinor = costedTotalMinor / costedThousandths
	valuation.TotalCostMinor = valuation.AverageUnitCostMinor * level.OnHand.Thousandths() / quantity.Scale

	return valuation, nil
}

// BelowMinimum reports whether a stock level has fallen to or below a
// reorder point, which is what drives the low-stock list (§21, §49).
//
// A minimum of zero means the product is not tracked for reordering, rather
// than that every product with no stock is perpetually low.
func BelowMinimum(level StockLevel, minimum quantity.Quantity) bool {
	if minimum.IsZero() || minimum.IsNegative() {
		return false
	}
	return level.OnHand.Cmp(minimum) <= 0
}
