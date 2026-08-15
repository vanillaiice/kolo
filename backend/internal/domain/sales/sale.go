// Package sales is what a business sold and what it was paid (§9–§11).
//
// A sale is the clearest case of the rule everything here follows: a business
// event creates immutable transactions, and current state is derived from them.
// One sale produces a sale record, its items, stock movements, one or more
// payments, and — when it is on credit — a customer transaction. None of that
// is a single-table write, and none of it is edited afterwards. A refund is a
// new sale that compensates the original, never a change to it (§41, ADR-007).
//
// Two things this package deliberately does not have:
//
//   - A payment method. §11 is explicit: a sale has many payments, and cash
//     plus Mobile Money for one sale is ordinary rather than exceptional. A
//     `payment_method` column would make the common case unrepresentable.
//   - A paid amount, or a status derived from one. What has been paid is the
//     sum of the payments, and storing it beside them would be a second version
//     of the same truth — the mistake §59 names.
package sales

import (
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways a sale can be rejected.
var (
	// ErrInvalidID means an identifier is missing or malformed.
	ErrInvalidID = errors.New("sales: invalid identifier")
	// ErrNoItems means a sale sold nothing.
	ErrNoItems = errors.New("sales: a sale needs at least one item")
	// ErrTooManyItems means a sale has more lines than one can be.
	ErrTooManyItems = errors.New("sales: too many items")
	// ErrDuplicateItem means the same line appears twice.
	ErrDuplicateItem = errors.New("sales: duplicate item")
	// ErrInvalidQuantity means a line sells nothing, or a negative amount.
	ErrInvalidQuantity = errors.New("sales: invalid quantity")
	// ErrInvalidPrice means a price is missing, negative, or the wrong currency.
	ErrInvalidPrice = errors.New("sales: invalid price")
	// ErrInvalidDiscount means a discount is negative or exceeds what it is
	// taken off.
	ErrInvalidDiscount = errors.New("sales: invalid discount")
	// ErrCurrencyMismatch means one sale mixes currencies.
	ErrCurrencyMismatch = errors.New("sales: mixed currencies")
	// ErrCreditNeedsCustomer means an unpaid balance has no one to owe it.
	ErrCreditNeedsCustomer = errors.New("sales: credit needs a customer")
)

// MaxItems bounds one sale.
//
// Not a business rule so much as a guard: a till cart with more lines than this
// is a bug or an attack, and a sale is applied in one transaction whose size
// should be bounded.
const MaxItems = 500

type saleTag struct{}

// ID identifies a sale.
type ID = id.Typed[saleTag]

// NewID draws a new sale identifier.
func NewID() ID { return id.NewTyped[saleTag]() }

// IDFrom tags an identifier drawn from a generator.
func IDFrom(value id.ID) ID { return id.TypedFrom[saleTag](value) }

// ParseID reads a sale identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[saleTag](text) }

// Sale is one completed sale.
//
// It is immutable. There is no method that changes one, because a sale is a
// statement about something that already happened.
type Sale struct {
	id         ID
	businessID business.ID
	branchID   business.BranchID
	// customerID names who bought, and is zero for an ordinary cash sale. §12
	// makes a customer optional, and requiring one would slow the common case
	// at the till for no gain.
	customerID customers.ID
	number     string
	items      []Item
	// discount is taken off the whole sale, after the lines. A discount on the
	// bill and a discount on a line are different things a shopkeeper does, and
	// collapsing them would lose which was meant.
	discount   money.Money
	note       string
	userID     users.ID
	deviceID   devices.ID
	occurredAt time.Time
	recordedAt time.Time
}

// Snapshot is the flat representation of a Sale.
type Snapshot struct {
	ID         ID
	BusinessID business.ID
	BranchID   business.BranchID
	CustomerID customers.ID
	// Number is what the receipt says, unique within a business. It is for
	// people, not for the system, which uses the identifier.
	Number     string
	Items      []ItemSnapshot
	Discount   money.Money
	Note       string
	UserID     users.ID
	DeviceID   devices.ID
	OccurredAt time.Time
	RecordedAt time.Time
}

// Record creates a sale.
//
// occurredAt is when the sale happened, which for a till offline for days is
// days ago; recordedAt is when the record was written. Reports are about when
// business happened, so the two are kept apart, as they are in the ledger.
func Record(snapshot Snapshot) (*Sale, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: sale", ErrInvalidID)
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

	number, err := validate.Name(snapshot.Number)
	if err != nil {
		return nil, fmt.Errorf("sale number: %w", err)
	}

	items, err := buildItems(snapshot.Items)
	if err != nil {
		return nil, err
	}

	// Every line agrees on a currency, and the sale's discount agrees with them.
	// A sale that mixed currencies could not be totalled, and there is nothing
	// sensible to do with one but refuse it (ADR-010).
	currency := items[0].unitPrice.Currency()
	subtotal, err := sumLines(items)
	if err != nil {
		return nil, err
	}

	discount, err := checkDiscount(snapshot.Discount, subtotal, currency, "sale")
	if err != nil {
		return nil, err
	}

	return &Sale{
		id:         snapshot.ID,
		businessID: snapshot.BusinessID,
		branchID:   snapshot.BranchID,
		customerID: snapshot.CustomerID,
		number:     number,
		items:      items,
		discount:   discount,
		note:       snapshot.Note,
		userID:     snapshot.UserID,
		deviceID:   snapshot.DeviceID,
		occurredAt: snapshot.OccurredAt.UTC(),
		recordedAt: snapshot.RecordedAt.UTC(),
	}, nil
}

// Restore rebuilds a sale from storage, validating it on the way in.
//
// The same rules as Record. A sale is never edited, so there is no state a
// stored one could be in that a new one could not.
func Restore(snapshot Snapshot) (*Sale, error) { return Record(snapshot) }

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

		// The same product may legitimately appear on two lines — two crates at
		// one price and a loose one at another — so only the line identifier is
		// checked for repetition, not the product.
		if i == 0 {
			currency = item.unitPrice.Currency()
		} else if item.unitPrice.Currency() != currency {
			return nil, fmt.Errorf("%w: item %d is %s, the sale is %s",
				ErrCurrencyMismatch, i, item.unitPrice.Currency(), currency)
		}
		items = append(items, item)
	}
	return items, nil
}

func sumLines(items []Item) (money.Money, error) {
	total := money.Money{}
	for i, item := range items {
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
			return money.Money{}, fmt.Errorf("totalling the sale: %w", err)
		}
	}
	return total, nil
}

// checkDiscount refuses a discount that is negative or larger than what it
// comes off.
//
// A discount bigger than the thing discounted would make a sale the business
// pays the customer for. If that is ever meant, it is a refund, which is a
// different transaction with a different name.
func checkDiscount(
	discount, ceiling money.Money, currency money.Currency, what string,
) (money.Money, error) {
	if discount.IsZero() {
		// The zero Money has no currency, so it is given the sale's rather than
		// failing the currency check below on a discount nobody asked for.
		return money.New(0, currency)
	}
	if discount.Currency() != currency {
		return money.Money{}, fmt.Errorf("%w: %s discount is %s, the sale is %s",
			ErrCurrencyMismatch, what, discount.Currency(), currency)
	}
	if discount.IsNegative() {
		return money.Money{}, fmt.Errorf("%w: %s discount %s is below zero", ErrInvalidDiscount, what, discount)
	}
	if order, err := discount.Cmp(ceiling); err != nil {
		return money.Money{}, err
	} else if order > 0 {
		return money.Money{}, fmt.Errorf("%w: %s discount %s exceeds %s",
			ErrInvalidDiscount, what, discount, ceiling)
	}
	return discount, nil
}

// Subtotal is the sum of the lines, before the sale's own discount.
func (s *Sale) Subtotal() (money.Money, error) { return sumLines(s.items) }

// Total is what the customer owes.
//
// Derived every time rather than stored. It is the sum of the lines less the
// sale discount, and a stored copy could disagree with the lines it came from.
func (s *Sale) Total() (money.Money, error) {
	subtotal, err := s.Subtotal()
	if err != nil {
		return money.Money{}, err
	}
	return subtotal.Sub(s.discount)
}

// Snapshot returns the flat representation of the sale.
func (s *Sale) Snapshot() Snapshot {
	items := make([]ItemSnapshot, 0, len(s.items))
	for _, item := range s.items {
		items = append(items, item.Snapshot())
	}
	return Snapshot{
		ID:         s.id,
		BusinessID: s.businessID,
		BranchID:   s.branchID,
		CustomerID: s.customerID,
		Number:     s.number,
		Items:      items,
		Discount:   s.discount,
		Note:       s.note,
		UserID:     s.userID,
		DeviceID:   s.deviceID,
		OccurredAt: s.occurredAt,
		RecordedAt: s.recordedAt,
	}
}

// ID returns the immutable identifier.
func (s *Sale) ID() ID { return s.id }

// BusinessID returns the business the sale belongs to.
func (s *Sale) BusinessID() business.ID { return s.businessID }

// BranchID returns the branch, which may be zero.
func (s *Sale) BranchID() business.BranchID { return s.branchID }

// Customer returns who bought, and whether anyone was named.
func (s *Sale) Customer() (customers.ID, bool) {
	return s.customerID, !s.customerID.IsZero()
}

// Number returns what the receipt says.
func (s *Sale) Number() string { return s.number }

// Items returns the lines, as a copy: a sale is immutable, and handing out the
// slice would let a caller edit one.
func (s *Sale) Items() []Item { return slices.Clone(s.items) }

// Discount returns the amount taken off the whole sale.
func (s *Sale) Discount() money.Money { return s.discount }

// Note returns whatever the cashier wrote, which may be empty.
func (s *Sale) Note() string { return s.note }

// UserID returns who made the sale.
func (s *Sale) UserID() users.ID { return s.userID }

// DeviceID returns the till it was made on.
func (s *Sale) DeviceID() devices.ID { return s.deviceID }

// OccurredAt returns when the sale happened, in UTC.
func (s *Sale) OccurredAt() time.Time { return s.occurredAt }

// RecordedAt returns when the record was written, in UTC.
func (s *Sale) RecordedAt() time.Time { return s.recordedAt }

// Scope returns the tenant scope the sale belongs to.
func (s *Sale) Scope() business.Scope {
	return business.ScopeOf(s.businessID, s.branchID)
}
