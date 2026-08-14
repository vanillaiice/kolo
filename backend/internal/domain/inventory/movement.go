// Package inventory records what physically moved.
//
// Stock is not a number this package keeps up to date. It is the sum of an
// append-only ledger of movements, and `product.stock = 47` is never written
// (SPECIFICATION.md §7, §59; ADR-009).
//
// That is not a stylistic preference. If two devices each hold "stock = 1" and
// each sells the last unit offline, any attempt to reconcile two competing
// numbers must discard a real sale. Accepting both movements loses nothing: the
// total goes to −1, which is a true statement about the business — two were
// sold and one existed — and is surfaced for someone to resolve.
package inventory

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Errors reported by this package.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("inventory: identifier is unset")
	// ErrInvalidMovementType means a movement type is not one this system defines.
	ErrInvalidMovementType = errors.New("inventory: invalid movement type")
	// ErrInvalidQuantity means a movement's quantity is unusable.
	ErrInvalidQuantity = errors.New("inventory: invalid quantity")
	// ErrWrongDirection means a quantity's sign contradicts its movement type.
	ErrWrongDirection = errors.New("inventory: quantity contradicts the movement type")
	// ErrInvalidCost means a unit cost is unusable.
	ErrInvalidCost = errors.New("inventory: invalid unit cost")
	// ErrMissingReason means an adjustment was recorded without one.
	ErrMissingReason = errors.New("inventory: this movement needs a reason")
	// ErrMissingReference means a movement was recorded without what caused it.
	ErrMissingReference = errors.New("inventory: this movement needs a reference")

	// ErrInvalidTime means a timestamp is unset.
	ErrInvalidTime = validate.ErrInvalidTime
)

type movementTag struct{}

// MovementID identifies a stock movement. It is immutable once assigned.
type MovementID = id.Typed[movementTag]

// NewMovementID returns a new movement identifier.
func NewMovementID() MovementID { return id.NewTyped[movementTag]() }

// MovementIDFrom tags an identifier drawn from a generator.
func MovementIDFrom(value id.ID) MovementID { return id.TypedFrom[movementTag](value) }

// ParseMovementID reads a movement identifier from its text form.
func ParseMovementID(text string) (MovementID, error) { return id.ParseTyped[movementTag](text) }

// MovementType says why stock moved (§7).
type MovementType string

// The movement types this system records.
const (
	// Purchase is stock arriving from a supplier.
	Purchase MovementType = "PURCHASE"
	// Sale is stock leaving because it was sold.
	Sale MovementType = "SALE"
	// SaleReturn is stock coming back from a customer.
	SaleReturn MovementType = "SALE_RETURN"
	// PurchaseReturn is stock going back to a supplier.
	PurchaseReturn MovementType = "PURCHASE_RETURN"
	// Damage is stock written off as unsellable.
	Damage MovementType = "DAMAGE"
	// Adjustment is a correction someone made deliberately.
	Adjustment MovementType = "ADJUSTMENT"
	// StockCount is the correction a physical count produced.
	StockCount MovementType = "STOCK_COUNT"
	// TransferOut is stock leaving for another branch.
	TransferOut MovementType = "TRANSFER_OUT"
	// TransferIn is stock arriving from another branch.
	TransferIn MovementType = "TRANSFER_IN"
	// OpeningBalance is what was already on the shelf when the business
	// started using the system.
	OpeningBalance MovementType = "OPENING_BALANCE"
)

var movementTypes = []MovementType{
	Purchase, Sale, SaleReturn, PurchaseReturn, Damage,
	Adjustment, StockCount, TransferOut, TransferIn, OpeningBalance,
}

// MovementTypes returns every defined movement type, in a stable order.
func MovementTypes() []MovementType { return slices.Clone(movementTypes) }

// Defined reports whether t is a movement type this system knows.
func (t MovementType) Defined() bool { return slices.Contains(movementTypes, t) }

// String implements fmt.Stringer.
func (t MovementType) String() string { return string(t) }

// ParseMovementType converts stored or transmitted text into a MovementType.
func ParseMovementType(text string) (MovementType, error) {
	candidate := MovementType(text)
	if !candidate.Defined() {
		return "", fmt.Errorf("%w: %q", ErrInvalidMovementType, text)
	}
	return candidate, nil
}

// Direction says which way a type of movement can go.
type Direction int

// The directions a movement type may take.
const (
	// Inward movements only ever add stock.
	Inward Direction = 1
	// Outward movements only ever remove it.
	Outward Direction = -1
	// EitherWay covers corrections, which go whichever way the truth requires.
	EitherWay Direction = 0
)

// Direction returns which way this type of movement may go.
//
// Most types have only one sensible direction: a sale cannot add stock, a
// purchase cannot remove it. Enforcing that catches a sign error at the point
// it is made rather than as an inexplicable stock level weeks later. Only
// corrections go either way, because a count can find either more or less than
// the ledger says.
func (t MovementType) Direction() Direction {
	switch t {
	case Purchase, SaleReturn, TransferIn, OpeningBalance:
		return Inward
	case Sale, PurchaseReturn, Damage, TransferOut:
		return Outward
	case Adjustment, StockCount:
		return EitherWay
	default:
		return EitherWay
	}
}

// RequiresReason reports whether this type of movement must say why.
//
// Corrections and write-offs are where stock changes without a sale or a
// delivery to explain it, which is exactly where an owner needs to know what
// happened (§7, §39).
func (t MovementType) RequiresReason() bool {
	switch t {
	case Adjustment, StockCount, Damage:
		return true
	default:
		return false
	}
}

// RequiresReference reports whether this type of movement must name what caused
// it.
//
// A sale's movement without its sale is untraceable, and §40 requires inventory
// movements to be traceable.
func (t MovementType) RequiresReference() bool {
	switch t {
	case Purchase, Sale, SaleReturn, PurchaseReturn, TransferIn, TransferOut:
		return true
	default:
		return false
	}
}

// IsSensitive reports whether this movement needs an audit record (§39).
func (t MovementType) IsSensitive() bool {
	switch t {
	case Adjustment, StockCount, Damage:
		return true
	default:
		return false
	}
}

// Movement is one entry in the stock ledger.
//
// It is immutable. There is no method that changes one, because a movement is a
// statement about something that already happened; a mistake is corrected by
// recording another movement, not by editing this one (§41, ADR-007).
type Movement struct {
	id         MovementID
	businessID business.ID
	branchID   business.BranchID
	productID  products.ID

	movementType MovementType
	// quantity is signed: positive adds stock, negative removes it. Summing the
	// ledger is then addition with no per-type special cases, which is what
	// keeps stock derivation simple enough to trust.
	quantity quantity.Quantity

	// unitCost is what one unit cost on the way in. Kept so inventory can be
	// valued at what was paid rather than at what it sells for (§8), and so a
	// later FIFO or weighted-average method has the data it needs.
	unitCost money.Money

	// reference names what caused this movement — the sale, the purchase, the
	// transfer. Empty for movements that stand alone.
	reference Reference

	reason     string
	userID     users.ID
	deviceID   devices.ID
	occurredAt time.Time
	recordedAt time.Time
}

// Reference names the business event a movement came from.
type Reference struct {
	// Kind is what sort of thing caused the movement, such as "SALE".
	Kind string
	// ID is that thing's identifier, as text: the ledger refers to several
	// kinds of record and does not depend on any of their packages.
	ID string
}

// IsZero reports whether the reference is unset.
func (r Reference) IsZero() bool { return r.Kind == "" && r.ID == "" }

// String implements fmt.Stringer.
func (r Reference) String() string {
	if r.IsZero() {
		return ""
	}
	return r.Kind + ":" + r.ID
}

// Snapshot is the flat representation of a Movement, used to persist it and to
// rebuild it from storage.
type Snapshot struct {
	ID         MovementID
	BusinessID business.ID
	BranchID   business.BranchID
	ProductID  products.ID
	Type       MovementType
	Quantity   quantity.Quantity
	UnitCost   money.Money
	Reference  Reference
	Reason     string
	UserID     users.ID
	DeviceID   devices.ID
	OccurredAt time.Time
	RecordedAt time.Time
}

// Record creates a movement.
//
// occurredAt is when the stock actually moved, which for a device that has been
// offline for days is days ago. recordedAt is when this record was written.
// Both are kept: reports are about when business happened, while sync and
// troubleshooting need to know when the system learned of it.
func Record(snapshot Snapshot) (*Movement, error) {
	if err := validateSnapshot(snapshot); err != nil {
		return nil, err
	}

	return &Movement{
		id:           snapshot.ID,
		businessID:   snapshot.BusinessID,
		branchID:     snapshot.BranchID,
		productID:    snapshot.ProductID,
		movementType: snapshot.Type,
		quantity:     snapshot.Quantity,
		unitCost:     snapshot.UnitCost,
		reference:    snapshot.Reference,
		reason:       snapshot.Reason,
		userID:       snapshot.UserID,
		deviceID:     snapshot.DeviceID,
		occurredAt:   snapshot.OccurredAt.UTC(),
		recordedAt:   snapshot.RecordedAt.UTC(),
	}, nil
}

// Restore rebuilds a movement from storage, validating it on the way in.
//
// It applies the same rules as Record. A movement is never edited, so there is
// no state a stored one could be in that a new one could not.
func Restore(snapshot Snapshot) (*Movement, error) {
	return Record(snapshot)
}

func validateSnapshot(snapshot Snapshot) error {
	if snapshot.ID.IsZero() {
		return fmt.Errorf("%w: movement", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return fmt.Errorf("%w: business", ErrInvalidID)
	}
	if snapshot.ProductID.IsZero() {
		return fmt.Errorf("%w: product", ErrInvalidID)
	}
	if snapshot.UserID.IsZero() {
		return fmt.Errorf("%w: user", ErrInvalidID)
	}
	if snapshot.DeviceID.IsZero() {
		return fmt.Errorf("%w: device", ErrInvalidID)
	}
	if !snapshot.Type.Defined() {
		return fmt.Errorf("%w: %q", ErrInvalidMovementType, snapshot.Type)
	}

	// A movement of nothing says nothing and would only clutter the ledger.
	if snapshot.Quantity.IsZero() {
		return fmt.Errorf("%w: a movement of zero changes nothing", ErrInvalidQuantity)
	}
	if err := checkDirection(snapshot.Type, snapshot.Quantity); err != nil {
		return err
	}

	if err := checkCost(snapshot.UnitCost); err != nil {
		return err
	}

	if snapshot.Type.RequiresReason() && strings.TrimSpace(snapshot.Reason) == "" {
		return fmt.Errorf("%w: %s", ErrMissingReason, snapshot.Type)
	}
	if snapshot.Type.RequiresReference() && snapshot.Reference.IsZero() {
		return fmt.Errorf("%w: %s", ErrMissingReference, snapshot.Type)
	}

	if err := validate.Moment(snapshot.OccurredAt, "occurrence time"); err != nil {
		return err
	}
	if err := validate.Moment(snapshot.RecordedAt, "record time"); err != nil {
		return err
	}
	return nil
}

// checkDirection catches a sign error where it is made, rather than as an
// inexplicable stock level weeks later.
func checkDirection(movementType MovementType, q quantity.Quantity) error {
	switch movementType.Direction() {
	case Inward:
		if q.IsNegative() {
			return fmt.Errorf("%w: %s adds stock, but the quantity is %s", ErrWrongDirection, movementType, q)
		}
	case Outward:
		if q.IsPositive() {
			return fmt.Errorf("%w: %s removes stock, so the quantity must be negative, got %s",
				ErrWrongDirection, movementType, q)
		}
	case EitherWay:
		// A correction goes whichever way the truth requires.
	}
	return nil
}

// checkCost allows an unset cost but refuses a negative one.
//
// Cost is unset for movements where it means nothing — a sale removes stock at
// whatever it was bought for, not at a new cost — but a negative cost is always
// a mistake.
func checkCost(cost money.Money) error {
	if !cost.Valid() {
		return nil
	}
	if cost.IsNegative() {
		return fmt.Errorf("%w: %s", ErrInvalidCost, cost)
	}
	return nil
}

// Snapshot returns the flat representation of the movement.
func (m *Movement) Snapshot() Snapshot {
	return Snapshot{
		ID:         m.id,
		BusinessID: m.businessID,
		BranchID:   m.branchID,
		ProductID:  m.productID,
		Type:       m.movementType,
		Quantity:   m.quantity,
		UnitCost:   m.unitCost,
		Reference:  m.reference,
		Reason:     m.reason,
		UserID:     m.userID,
		DeviceID:   m.deviceID,
		OccurredAt: m.occurredAt,
		RecordedAt: m.recordedAt,
	}
}

// ID returns the immutable identifier.
func (m *Movement) ID() MovementID { return m.id }

// BusinessID returns the business the movement belongs to.
func (m *Movement) BusinessID() business.ID { return m.businessID }

// BranchID returns the branch the stock moved at, and whether one was recorded.
func (m *Movement) BranchID() (business.BranchID, bool) {
	return m.branchID, !m.branchID.IsZero()
}

// ProductID returns the product whose stock moved.
func (m *Movement) ProductID() products.ID { return m.productID }

// Type returns why the stock moved.
func (m *Movement) Type() MovementType { return m.movementType }

// Quantity returns the signed change: positive added stock, negative removed it.
func (m *Movement) Quantity() quantity.Quantity { return m.quantity }

// UnitCost returns what one unit cost, if the movement recorded one.
func (m *Movement) UnitCost() (money.Money, bool) {
	return m.unitCost, m.unitCost.Valid()
}

// Reference returns what caused the movement, and whether one was recorded.
func (m *Movement) Reference() (Reference, bool) {
	return m.reference, !m.reference.IsZero()
}

// Reason returns why, for the movements that require it.
func (m *Movement) Reason() string { return m.reason }

// UserID returns who recorded it.
func (m *Movement) UserID() users.ID { return m.userID }

// DeviceID returns which installation recorded it.
func (m *Movement) DeviceID() devices.ID { return m.deviceID }

// OccurredAt returns when the stock actually moved, in UTC.
func (m *Movement) OccurredAt() time.Time { return m.occurredAt }

// RecordedAt returns when the record was written, in UTC.
func (m *Movement) RecordedAt() time.Time { return m.recordedAt }

// Scope returns the tenant scope the movement belongs to.
func (m *Movement) Scope() business.Scope {
	return business.ScopeOf(m.businessID, m.branchID)
}

// IsSensitive reports whether this movement needs an audit record (§39).
func (m *Movement) IsSensitive() bool { return m.movementType.IsSensitive() }
