package sales

import (
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

type itemTag struct{}

// ItemID identifies one line of a sale.
type ItemID = id.Typed[itemTag]

// NewItemID draws a new line identifier.
func NewItemID() ItemID { return id.NewTyped[itemTag]() }

// ItemIDFrom tags an identifier drawn from a generator.
func ItemIDFrom(value id.ID) ItemID { return id.TypedFrom[itemTag](value) }

// ParseItemID reads a line identifier from its text form.
func ParseItemID(text string) (ItemID, error) { return id.ParseTyped[itemTag](text) }

// Item is one line of a sale.
//
// It keeps the product's name and price as they were when it sold, rather than
// pointing at the product for them. A receipt reprinted next year has to show
// what was charged, and the product's price will have moved on — §41 wants
// financial history that does not change under it.
type Item struct {
	id        ItemID
	productID products.ID
	// name is the product's name at the time of sale, kept for the same reason
	// as the price.
	name      string
	unitPrice money.Money
	quantity  quantity.Quantity
	discount  money.Money
	// taxRateBasisPoints is the rate that applied, kept alongside the price so a
	// receipt can be reproduced after the rate changes.
	taxRateBasisPoints int
	// unitCost is what the business paid for one, kept so profit can be reported
	// against the cost at the time rather than today's (§8, §21).
	unitCost money.Money
}

// ItemSnapshot is the flat representation of an Item.
type ItemSnapshot struct {
	ID                 ItemID
	ProductID          products.ID
	Name               string
	UnitPrice          money.Money
	Quantity           quantity.Quantity
	Discount           money.Money
	TaxRateBasisPoints int
	UnitCost           money.Money
}

// MaxTaxRateBasisPoints is 100%, above which a rate is a mistake.
const MaxTaxRateBasisPoints = 10_000

func newItem(snapshot ItemSnapshot) (Item, error) {
	if snapshot.ID.IsZero() {
		return Item{}, fmt.Errorf("%w: item", ErrInvalidID)
	}
	if snapshot.ProductID.IsZero() {
		return Item{}, fmt.Errorf("%w: product", ErrInvalidID)
	}
	if snapshot.Name == "" {
		return Item{}, fmt.Errorf("%w: item name", ErrInvalidID)
	}

	if !snapshot.UnitPrice.Valid() {
		return Item{}, fmt.Errorf("%w: no unit price", ErrInvalidPrice)
	}
	if snapshot.UnitPrice.IsNegative() {
		return Item{}, fmt.Errorf("%w: unit price %s is below zero", ErrInvalidPrice, snapshot.UnitPrice)
	}

	// A line must sell something. Zero would be a line that changes nothing, and
	// negative would be a refund wearing a sale's clothes — §41 wants that as a
	// separate compensating transaction, not a sign flip hidden in a line.
	if !snapshot.Quantity.IsPositive() {
		return Item{}, fmt.Errorf("%w: %s", ErrInvalidQuantity, snapshot.Quantity)
	}

	if snapshot.TaxRateBasisPoints < 0 || snapshot.TaxRateBasisPoints > MaxTaxRateBasisPoints {
		return Item{}, fmt.Errorf("%w: tax rate %d basis points is outside 0–%d",
			ErrInvalidPrice, snapshot.TaxRateBasisPoints, MaxTaxRateBasisPoints)
	}

	if snapshot.UnitCost.Valid() {
		if snapshot.UnitCost.IsNegative() {
			return Item{}, fmt.Errorf("%w: unit cost %s is below zero", ErrInvalidPrice, snapshot.UnitCost)
		}
		if snapshot.UnitCost.Currency() != snapshot.UnitPrice.Currency() {
			return Item{}, fmt.Errorf("%w: cost is %s, price is %s",
				ErrCurrencyMismatch, snapshot.UnitCost.Currency(), snapshot.UnitPrice.Currency())
		}
	}

	item := Item{
		id:                 snapshot.ID,
		productID:          snapshot.ProductID,
		name:               snapshot.Name,
		unitPrice:          snapshot.UnitPrice,
		quantity:           snapshot.Quantity,
		taxRateBasisPoints: snapshot.TaxRateBasisPoints,
		unitCost:           snapshot.UnitCost,
	}

	gross, err := item.Gross()
	if err != nil {
		return Item{}, err
	}
	discount, err := checkDiscount(snapshot.Discount, gross, snapshot.UnitPrice.Currency(), "item")
	if err != nil {
		return Item{}, err
	}
	item.discount = discount

	return item, nil
}

// Gross is the price times the quantity, before this line's discount.
//
// Quantity is in thousandths, so this is a ratio rather than a multiplication:
// half a kilo at 1,000 FCFA is 500, and doing it as integer division on the
// quantity first would lose the half. Ties round half up, which is the ordinary
// commercial convention and the one a shopkeeper checking the arithmetic by
// hand will expect.
func (i Item) Gross() (money.Money, error) {
	return i.unitPrice.MulRatio(i.quantity.Thousandths(), quantity.Scale, money.RoundHalfUp)
}

// Total is what this line adds to the sale.
func (i Item) Total() (money.Money, error) {
	gross, err := i.Gross()
	if err != nil {
		return money.Money{}, err
	}
	if i.discount.IsZero() {
		return gross, nil
	}
	return gross.Sub(i.discount)
}

// Cost is what the business paid for what this line sold, and whether that is
// known at all.
//
// A business that has not recorded what it paid has no cost to report, and a
// guess would be worse than an honest gap (§6). Callers report profit only for
// the lines where this is known.
func (i Item) Cost() (money.Money, bool, error) {
	if !i.unitCost.Valid() {
		return money.Money{}, false, nil
	}
	cost, err := i.unitCost.MulRatio(i.quantity.Thousandths(), quantity.Scale, money.RoundHalfUp)
	if err != nil {
		return money.Money{}, false, err
	}
	return cost, true, nil
}

// Profit is what this line made, and whether the cost was known.
func (i Item) Profit() (money.Money, bool, error) {
	cost, known, err := i.Cost()
	if err != nil || !known {
		return money.Money{}, false, err
	}
	total, err := i.Total()
	if err != nil {
		return money.Money{}, false, err
	}
	profit, err := total.Sub(cost)
	if err != nil {
		return money.Money{}, false, err
	}
	return profit, true, nil
}

// Snapshot returns the flat representation of the line.
func (i Item) Snapshot() ItemSnapshot {
	return ItemSnapshot{
		ID:                 i.id,
		ProductID:          i.productID,
		Name:               i.name,
		UnitPrice:          i.unitPrice,
		Quantity:           i.quantity,
		Discount:           i.discount,
		TaxRateBasisPoints: i.taxRateBasisPoints,
		UnitCost:           i.unitCost,
	}
}

// ID returns the line's identifier.
func (i Item) ID() ItemID { return i.id }

// ProductID returns what was sold.
func (i Item) ProductID() products.ID { return i.productID }

// Name returns the product's name as it was when it sold.
func (i Item) Name() string { return i.name }

// UnitPrice returns what one was charged at.
func (i Item) UnitPrice() money.Money { return i.unitPrice }

// Quantity returns how many were sold.
func (i Item) Quantity() quantity.Quantity { return i.quantity }

// Discount returns what was taken off this line.
func (i Item) Discount() money.Money { return i.discount }

// TaxRateBasisPoints returns the rate that applied.
func (i Item) TaxRateBasisPoints() int { return i.taxRateBasisPoints }

// UnitCost returns what one cost the business, and whether that is known.
func (i Item) UnitCost() (money.Money, bool) {
	return i.unitCost, i.unitCost.Valid()
}

// SoldAt is a convenience for reporting, pairing a line with when its sale
// happened.
type SoldAt struct {
	Item
	At time.Time
}
