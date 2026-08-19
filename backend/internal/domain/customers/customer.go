package customers

import (
	"errors"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways a customer can be rejected.
var (
	// ErrInvalidID means an identifier is missing or malformed.
	ErrInvalidID = errors.New("customers: invalid identifier")
	// ErrInvalidCreditLimit means a limit is negative or the wrong currency.
	ErrInvalidCreditLimit = errors.New("customers: invalid credit limit")
)

// Customer is someone a business sells to (§12).
//
// Only a name is required. A shopkeeper putting a regular on credit at the
// counter should not have to fill in an address first, and §12 makes everything
// but the name optional for exactly that reason.
//
// It holds **no balance**. What a customer owes is the sum of their
// transactions (§13), and a column here would be a second version of that —
// one that could disagree with the transactions it came from, about the one
// number a shopkeeper will argue with a customer over.
type Customer struct {
	id         ID
	businessID business.ID
	name       string
	// number is optional: a customer in a village shop may not have a phone,
	// and requiring one would exclude them from the credit book they are
	// already in on paper.
	number  phone.Number
	address string
	notes   string
	// creditLimit is how much this customer may owe at once. Zero means no
	// limit has been set, which is not the same as a limit of zero — see
	// CreditLimit.
	creditLimit money.Money
	active      bool
	// updatedByDevice is the device whose edit is currently in force. It breaks
	// a tie between two edits stamped the same instant, which is what makes the
	// conflict rule give every device the same answer (ADR-015).
	updatedByDevice devices.ID
	createdAt       time.Time
	updatedAt       time.Time
}

// Snapshot is the flat representation of a Customer.
type Snapshot struct {
	ID              ID
	BusinessID      business.ID
	Name            string
	Phone           phone.Number
	Address         string
	Notes           string
	CreditLimit     money.Money
	Active          bool
	UpdatedByDevice devices.ID
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// New creates a customer, active from the given moment.
func New(snapshot Snapshot) (*Customer, error) {
	cleaned, err := validateSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Moment(snapshot.CreatedAt, "creation time"); err != nil {
		return nil, err
	}

	moment := snapshot.CreatedAt.UTC()
	customer := build(cleaned)
	customer.active = true
	customer.updatedByDevice = snapshot.UpdatedByDevice
	customer.createdAt = moment
	customer.updatedAt = moment
	return customer, nil
}

// Restore rebuilds a customer from storage, validating it on the way in.
func Restore(snapshot Snapshot) (*Customer, error) {
	cleaned, err := validateSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Timestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	customer := build(cleaned)
	customer.active = snapshot.Active
	customer.updatedByDevice = snapshot.UpdatedByDevice
	customer.createdAt = snapshot.CreatedAt.UTC()
	customer.updatedAt = snapshot.UpdatedAt.UTC()
	return customer, nil
}

func build(snapshot Snapshot) *Customer {
	return &Customer{
		id:          snapshot.ID,
		businessID:  snapshot.BusinessID,
		name:        snapshot.Name,
		number:      snapshot.Phone,
		address:     snapshot.Address,
		notes:       snapshot.Notes,
		creditLimit: snapshot.CreditLimit,
	}
}

func validateSnapshot(snapshot Snapshot) (Snapshot, error) {
	if snapshot.ID.IsZero() {
		return Snapshot{}, fmt.Errorf("%w: customer", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return Snapshot{}, fmt.Errorf("%w: business", ErrInvalidID)
	}

	name, err := validate.Name(snapshot.Name)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot.Name = name

	if snapshot.CreditLimit.Valid() && snapshot.CreditLimit.IsNegative() {
		return Snapshot{}, fmt.Errorf("%w: %s is below zero",
			ErrInvalidCreditLimit, snapshot.CreditLimit)
	}
	return snapshot, nil
}

// Snapshot returns the flat representation of the customer.
func (c *Customer) Snapshot() Snapshot {
	return Snapshot{
		ID:              c.id,
		BusinessID:      c.businessID,
		Name:            c.name,
		Phone:           c.number,
		Address:         c.address,
		Notes:           c.notes,
		CreditLimit:     c.creditLimit,
		Active:          c.active,
		UpdatedByDevice: c.updatedByDevice,
		CreatedAt:       c.createdAt,
		UpdatedAt:       c.updatedAt,
	}
}

// ID returns the immutable identifier.
func (c *Customer) ID() ID { return c.id }

// BusinessID returns the business the customer belongs to.
func (c *Customer) BusinessID() business.ID { return c.businessID }

// Name returns what they are called.
func (c *Customer) Name() string { return c.name }

// Phone returns their number, and whether one was recorded.
func (c *Customer) Phone() (phone.Number, bool) { return c.number, !c.number.IsZero() }

// Address returns where they are, which may be empty.
func (c *Customer) Address() string { return c.address }

// Notes returns whatever the shopkeeper wrote, which may be empty.
func (c *Customer) Notes() string { return c.notes }

// CreditLimit returns how much they may owe at once, and whether a limit was
// set at all.
//
// The two are distinct and the distinction matters. No limit means the
// shopkeeper has not decided, and credit is theirs to judge; a limit of zero
// means this customer may not have credit. Collapsing them would either refuse
// every regular who has never been given a limit, or extend unlimited credit to
// someone deliberately cut off.
func (c *Customer) CreditLimit() (money.Money, bool) {
	return c.creditLimit, c.creditLimit.Valid()
}

// Active reports whether the customer is still on the books.
func (c *Customer) Active() bool { return c.active }

// UpdatedByDevice returns the device that last edited the record, which may be
// zero for one written before the column existed or created on the server.
func (c *Customer) UpdatedByDevice() devices.ID { return c.updatedByDevice }

// CreatedAt returns when the record was made, in UTC.
func (c *Customer) CreatedAt() time.Time { return c.createdAt }

// UpdatedAt returns when it last changed, in UTC.
func (c *Customer) UpdatedAt() time.Time { return c.updatedAt }

// Scope returns the tenant scope the customer belongs to.
func (c *Customer) Scope() business.Scope { return business.ScopeOf(c.businessID, business.BranchID{}) }
