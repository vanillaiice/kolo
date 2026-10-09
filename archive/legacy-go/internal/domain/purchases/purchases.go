// Package purchases is stock coming in and what it cost (§15).
//
// A purchase is not an inventory operation. It raises stock and *either* lowers
// a financial account or raises what the business owes a supplier — §15 is
// explicit that it is a business transaction across several domains, and
// treating it as a single-table write is the mistake §59 names.
//
// The shape mirrors a sale, upside down. A sale has items, payments, and stock
// leaving; a purchase has items, payments, and stock arriving. What a sale
// leaves unpaid becomes a customer's debt; what a purchase leaves unpaid becomes
// the business's debt to a supplier.
package purchases

import (
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways a purchase can be rejected.
var (
	// ErrInvalidID means an identifier is missing or malformed.
	ErrInvalidID = errors.New("purchases: invalid identifier")
	// ErrNoItems means a purchase bought nothing.
	ErrNoItems = errors.New("purchases: a purchase needs at least one item")
	// ErrTooManyItems means a purchase has more lines than one can have.
	ErrTooManyItems = errors.New("purchases: too many items")
	// ErrDuplicateItem means the same line appears twice.
	ErrDuplicateItem = errors.New("purchases: duplicate item")
	// ErrInvalidQuantity means a line buys nothing, or a negative amount.
	ErrInvalidQuantity = errors.New("purchases: invalid quantity")
	// ErrInvalidCost means a unit cost is missing, negative, or the wrong
	// currency.
	ErrInvalidCost = errors.New("purchases: invalid unit cost")
	// ErrCurrencyMismatch means one purchase mixes currencies.
	ErrCurrencyMismatch = errors.New("purchases: mixed currencies")
	// ErrCreditNeedsSupplier means an unpaid balance has nobody to be owed to.
	ErrCreditNeedsSupplier = errors.New("purchases: credit needs a supplier")
	// ErrOverpaid means more was paid than the purchase came to.
	ErrOverpaid = errors.New("purchases: paid more than the purchase")
)

// MaxItems bounds one purchase, as it bounds a sale: a delivery with more lines
// than this is a bug or an attack, and the whole thing is applied in one
// transaction whose size should be bounded.
const MaxItems = 500

type purchaseTag struct{}

// ID identifies a purchase.
type ID = id.Typed[purchaseTag]

// NewID draws a new purchase identifier.
func NewID() ID { return id.NewTyped[purchaseTag]() }

// IDFrom tags an identifier drawn from a generator.
func IDFrom(value id.ID) ID { return id.TypedFrom[purchaseTag](value) }

// ParseID reads a purchase identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[purchaseTag](text) }

type itemTag struct{}

// ItemID identifies one line of a purchase.
type ItemID = id.Typed[itemTag]

// NewItemID draws a new item identifier.
func NewItemID() ItemID { return id.NewTyped[itemTag]() }

// ItemIDFrom tags an identifier drawn from a generator.
func ItemIDFrom(value id.ID) ItemID { return id.TypedFrom[itemTag](value) }

// ParseItemID reads an item identifier from its text form.
func ParseItemID(text string) (ItemID, error) { return id.ParseTyped[itemTag](text) }

// Item is one line of a purchase.
type Item struct {
	id        ItemID
	productID products.ID
	// unitCost is what one costs. Required, unlike a sale line's, because this
	// is where a cost is *learned*: a purchase with no cost would tell the shop
	// nothing about what its stock is worth (§8).
	unitCost money.Money
	quantity quantity.Quantity
}

// ItemSnapshot is the flat representation of an Item.
type ItemSnapshot struct {
	ID        ItemID
	ProductID products.ID
	UnitCost  money.Money
	Quantity  quantity.Quantity
}

func newItem(snapshot ItemSnapshot) (Item, error) {
	if snapshot.ID.IsZero() {
		return Item{}, fmt.Errorf("%w: item", ErrInvalidID)
	}
	if snapshot.ProductID.IsZero() {
		return Item{}, fmt.Errorf("%w: product", ErrInvalidID)
	}
	if !snapshot.Quantity.IsPositive() {
		return Item{}, fmt.Errorf("%w: %s", ErrInvalidQuantity, snapshot.Quantity)
	}
	if !snapshot.UnitCost.Valid() {
		return Item{}, fmt.Errorf("%w: no currency", ErrInvalidCost)
	}
	if snapshot.UnitCost.IsNegative() {
		return Item{}, fmt.Errorf("%w: %s is below zero", ErrInvalidCost, snapshot.UnitCost)
	}

	return Item{
		id:        snapshot.ID,
		productID: snapshot.ProductID,
		unitCost:  snapshot.UnitCost,
		quantity:  snapshot.Quantity,
	}, nil
}

// Snapshot returns the flat representation of the item.
func (i Item) Snapshot() ItemSnapshot {
	return ItemSnapshot{
		ID:        i.id,
		ProductID: i.productID,
		UnitCost:  i.unitCost,
		Quantity:  i.quantity,
	}
}

// ID returns the line's identifier.
func (i Item) ID() ItemID { return i.id }

// ProductID returns what was bought.
func (i Item) ProductID() products.ID { return i.productID }

// UnitCost returns what one costs.
func (i Item) UnitCost() money.Money { return i.unitCost }

// Quantity returns how many arrived.
func (i Item) Quantity() quantity.Quantity { return i.quantity }

// Total returns what the line came to.
//
// Cost times quantity divided by the scale, rounded half away from zero — the
// same arithmetic a sale line uses, because the two are compared to each other
// whenever anyone asks what a shop made.
func (i Item) Total() (money.Money, error) {
	return i.unitCost.MulRatio(i.quantity.Thousandths(), quantity.Scale, money.RoundHalfUp)
}

// Purchase is stock arriving and what it cost (§15).
//
// Immutable, like a sale: it is a statement about something that already
// happened, and a correction is a return, which is its own transaction.
type Purchase struct {
	id         ID
	businessID business.ID
	branchID   business.BranchID
	// supplierID names who it came from, and may be zero: a shopkeeper buying a
	// crate at the market has no supplier to record, and requiring one would
	// stop them recording the stock at all.
	supplierID suppliers.ID
	// reference is the supplier's invoice or delivery-note number, when there
	// is one.
	reference  string
	items      []Item
	note       string
	userID     users.ID
	deviceID   devices.ID
	occurredAt time.Time
	recordedAt time.Time
}

// Snapshot is the flat representation of a Purchase.
type Snapshot struct {
	ID         ID
	BusinessID business.ID
	BranchID   business.BranchID
	SupplierID suppliers.ID
	Reference  string
	Items      []ItemSnapshot
	Note       string
	UserID     users.ID
	DeviceID   devices.ID
	OccurredAt time.Time
	RecordedAt time.Time
}

// Record creates a purchase.
func Record(snapshot Snapshot) (*Purchase, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: purchase", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if snapshot.UserID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if snapshot.DeviceID.IsZero() {
		return nil, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if err := validate.Timestamps(snapshot.OccurredAt, snapshot.RecordedAt); err != nil {
		return nil, err
	}

	items, err := buildItems(snapshot.Items)
	if err != nil {
		return nil, err
	}

	return &Purchase{
		id:         snapshot.ID,
		businessID: snapshot.BusinessID,
		branchID:   snapshot.BranchID,
		supplierID: snapshot.SupplierID,
		reference:  snapshot.Reference,
		items:      items,
		note:       snapshot.Note,
		userID:     snapshot.UserID,
		deviceID:   snapshot.DeviceID,
		occurredAt: snapshot.OccurredAt.UTC(),
		recordedAt: snapshot.RecordedAt.UTC(),
	}, nil
}

// Restore rebuilds a purchase from storage, validating it on the way in.
func Restore(snapshot Snapshot) (*Purchase, error) { return Record(snapshot) }

func buildItems(lines []ItemSnapshot) ([]Item, error) {
	if len(lines) == 0 {
		return nil, ErrNoItems
	}
	if len(lines) > MaxItems {
		return nil, fmt.Errorf("%w: %d lines, the limit is %d", ErrTooManyItems, len(lines), MaxItems)
	}

	items := make([]Item, 0, len(lines))
	seen := make(map[ItemID]struct{}, len(lines))
	var currency money.Currency

	for i, line := range lines {
		item, err := newItem(line)
		if err != nil {
			return nil, fmt.Errorf("item %d: %w", i, err)
		}
		if _, repeated := seen[item.id]; repeated {
			return nil, fmt.Errorf("%w: item %s appears twice", ErrDuplicateItem, item.id)
		}
		seen[item.id] = struct{}{}

		// The same product may legitimately appear twice — two crates bought at
		// different prices in one delivery — so only the line is checked.
		if i == 0 {
			currency = item.unitCost.Currency()
		} else if item.unitCost.Currency() != currency {
			return nil, fmt.Errorf("%w: item %d is %s, the purchase is %s",
				ErrCurrencyMismatch, i, item.unitCost.Currency(), currency)
		}
		items = append(items, item)
	}
	return items, nil
}

// Total is what the delivery cost, derived every time rather than stored.
func (p *Purchase) Total() (money.Money, error) {
	total := money.Money{}
	for i, item := range p.items {
		lineTotal, err := item.Total()
		if err != nil {
			return money.Money{}, fmt.Errorf("item %d: %w", i, err)
		}
		if i == 0 {
			total = lineTotal
			continue
		}
		total, err = total.Add(lineTotal)
		if err != nil {
			return money.Money{}, fmt.Errorf("totalling the purchase: %w", err)
		}
	}
	return total, nil
}

// Snapshot returns the flat representation of the purchase.
func (p *Purchase) Snapshot() Snapshot {
	items := make([]ItemSnapshot, 0, len(p.items))
	for _, item := range p.items {
		items = append(items, item.Snapshot())
	}
	return Snapshot{
		ID:         p.id,
		BusinessID: p.businessID,
		BranchID:   p.branchID,
		SupplierID: p.supplierID,
		Reference:  p.reference,
		Items:      items,
		Note:       p.note,
		UserID:     p.userID,
		DeviceID:   p.deviceID,
		OccurredAt: p.occurredAt,
		RecordedAt: p.recordedAt,
	}
}

// ID returns the immutable identifier.
func (p *Purchase) ID() ID { return p.id }

// BusinessID returns the business that bought.
func (p *Purchase) BusinessID() business.ID { return p.businessID }

// BranchID returns the branch it arrived at, which may be zero.
func (p *Purchase) BranchID() business.BranchID { return p.branchID }

// Supplier returns who it came from, and whether anyone was named.
func (p *Purchase) Supplier() (suppliers.ID, bool) {
	return p.supplierID, !p.supplierID.IsZero()
}

// Reference returns the supplier's invoice number, which may be empty.
func (p *Purchase) Reference() string { return p.reference }

// Items returns the lines, as a copy: a purchase is immutable.
func (p *Purchase) Items() []Item { return slices.Clone(p.items) }

// Note returns whatever was written, which may be empty.
func (p *Purchase) Note() string { return p.note }

// UserID returns who recorded it.
func (p *Purchase) UserID() users.ID { return p.userID }

// DeviceID returns the device it was recorded on.
func (p *Purchase) DeviceID() devices.ID { return p.deviceID }

// OccurredAt returns when the stock arrived, in UTC.
func (p *Purchase) OccurredAt() time.Time { return p.occurredAt }

// RecordedAt returns when the record was written, in UTC.
func (p *Purchase) RecordedAt() time.Time { return p.recordedAt }

// Scope returns the tenant scope the purchase belongs to.
func (p *Purchase) Scope() business.Scope {
	return business.ScopeOf(p.businessID, p.branchID)
}

// Settlement is how a purchase stands against what has been paid for it (§15).
//
// Worked out every time, never stored. A purchase paid in full leaves the
// supplier's balance untouched; one left owing raises it by exactly what is
// outstanding — which is §15's two cases, and the reason this is derived rather
// than a flag someone sets.
type Settlement struct {
	Total money.Money
	Paid  money.Money
	// Outstanding is what the supplier is still owed. Zero when the delivery
	// was paid for on the spot.
	Outstanding money.Money
}

// Settled reports whether nothing is left to pay.
func (s Settlement) Settled() bool { return s.Outstanding.IsZero() }

// OnCredit reports whether the delivery raised what the business owes.
func (s Settlement) OnCredit() bool { return s.Outstanding.IsPositive() }

// Settle works out where a purchase stands against what was paid for it.
//
// paid is the sum of what the business handed over at the door — cash out of a
// drawer, a transfer from a wallet — and may be nothing at all, which is the
// ordinary credit case.
func Settle(purchase *Purchase, paid money.Money) (Settlement, error) {
	if purchase == nil {
		return Settlement{}, fmt.Errorf("%w: purchase", ErrInvalidID)
	}

	total, err := purchase.Total()
	if err != nil {
		return Settlement{}, err
	}

	// Nothing paid is nothing in the purchase's own currency, rather than an
	// amount with no currency that nothing can be subtracted from.
	if !paid.Valid() {
		paid = total.Currency().Zero()
	}
	if paid.IsNegative() {
		return Settlement{}, fmt.Errorf("%w: %s", ErrInvalidCost, paid)
	}

	outstanding, err := total.Sub(paid)
	if err != nil {
		return Settlement{}, fmt.Errorf("%w: %w", ErrCurrencyMismatch, err)
	}

	// Paying more than the delivery came to is someone recording the wrong
	// figure. Storing it would take money out of an account the business never
	// handed over.
	if outstanding.IsNegative() {
		return Settlement{}, fmt.Errorf("%w: paid %s against a total of %s",
			ErrOverpaid, paid, total)
	}

	// What is left owing has to be owed to someone, or it could never be paid
	// or reported (§16).
	if outstanding.IsPositive() {
		if _, named := purchase.Supplier(); !named {
			return Settlement{}, fmt.Errorf("%w: %s outstanding",
				ErrCreditNeedsSupplier, outstanding)
		}
	}

	return Settlement{Total: total, Paid: paid, Outstanding: outstanding}, nil
}
