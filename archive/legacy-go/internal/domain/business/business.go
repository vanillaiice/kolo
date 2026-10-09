package business

import (
	"errors"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Errors reported when an entity would be invalid.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("business: identifier is unset")
	// ErrInvalidCurrency means no operating currency was given.
	ErrInvalidCurrency = errors.New("business: invalid currency")

	// ErrInvalidName means a name is empty, too long, or contains characters
	// that would not be visible to the person reading it.
	ErrInvalidName = validate.ErrInvalidName
	// ErrInvalidTime means a timestamp is unset or inconsistent.
	ErrInvalidTime = validate.ErrInvalidTime
)

// MaxNameLength is the longest name a business or branch may carry, in runes.
const MaxNameLength = validate.MaxNameLength

// Business is the tenant that owns every other record in the system.
//
// Its identifier is immutable (SPECIFICATION.md §40). Its descriptive fields
// are not financial history, so they may be edited in place and are resolved
// last-write-wins across devices (ADR-006).
type Business struct {
	id        ID
	name      string
	currency  money.Currency
	active    bool
	createdAt time.Time
	updatedAt time.Time
}

// Snapshot is the flat representation of a Business, used to persist it and to
// rebuild it from storage. It is the only way the entity's internals cross the
// package boundary, so a repository cannot construct one that skipped
// validation.
type Snapshot struct {
	ID        ID
	Name      string
	Currency  money.Currency
	Active    bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// New creates a business, active from the given moment.
//
// The currency is the one the business trades in; for the target market that is
// XAF (§44). It is fixed at creation because amounts already recorded cannot be
// reinterpreted in another currency afterwards.
func New(businessID ID, name string, currency money.Currency, now time.Time) (*Business, error) {
	if businessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validateName(name)
	if err != nil {
		return nil, err
	}
	if !currency.Defined() {
		return nil, ErrInvalidCurrency
	}
	if err := validate.Moment(now, "creation time"); err != nil {
		return nil, err
	}

	moment := now.UTC()
	return &Business{
		id:        businessID,
		name:      cleaned,
		currency:  currency,
		active:    true,
		createdAt: moment,
		updatedAt: moment,
	}, nil
}

// Restore rebuilds a business from storage, validating it on the way in.
//
// Stored data is not trusted: a record written by an older version, or synced
// from another device, is checked against the same rules as a new one so that a
// broken record surfaces at the boundary rather than deep in a calculation.
func Restore(snapshot Snapshot) (*Business, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validateName(snapshot.Name)
	if err != nil {
		return nil, err
	}
	if !snapshot.Currency.Defined() {
		return nil, ErrInvalidCurrency
	}
	if err := validateTimestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	return &Business{
		id:        snapshot.ID,
		name:      cleaned,
		currency:  snapshot.Currency,
		active:    snapshot.Active,
		createdAt: snapshot.CreatedAt.UTC(),
		updatedAt: snapshot.UpdatedAt.UTC(),
	}, nil
}

// Snapshot returns the flat representation of the business.
func (b *Business) Snapshot() Snapshot {
	return Snapshot{
		ID:        b.id,
		Name:      b.name,
		Currency:  b.currency,
		Active:    b.active,
		CreatedAt: b.createdAt,
		UpdatedAt: b.updatedAt,
	}
}

// ID returns the immutable identifier.
func (b *Business) ID() ID { return b.id }

// Name returns the trading name.
func (b *Business) Name() string { return b.name }

// Currency returns the currency the business trades in.
func (b *Business) Currency() money.Currency { return b.currency }

// IsActive reports whether the business is in service.
func (b *Business) IsActive() bool { return b.active }

// CreatedAt returns when the business was created, in UTC.
func (b *Business) CreatedAt() time.Time { return b.createdAt }

// UpdatedAt returns when the business last changed, in UTC.
func (b *Business) UpdatedAt() time.Time { return b.updatedAt }

// Scope returns a scope covering this whole business, which is what most
// operations against its data need.
func (b *Business) Scope() Scope {
	return Scope{business: b.id}
}

// Rename changes the trading name.
func (b *Business) Rename(name string, at time.Time) error {
	cleaned, err := validateName(name)
	if err != nil {
		return err
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}

	b.name = cleaned
	b.updatedAt = at.UTC()
	return nil
}

// Deactivate takes the business out of service. It is idempotent.
//
// Deactivation is not deletion: the records stay, because financial history is
// never destroyed (§40, ADR-007).
func (b *Business) Deactivate(at time.Time) error {
	return b.setActive(false, at)
}

// Activate returns the business to service. It is idempotent.
func (b *Business) Activate(at time.Time) error {
	return b.setActive(true, at)
}

func (b *Business) setActive(active bool, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if b.active == active {
		return nil
	}
	b.active = active
	b.updatedAt = at.UTC()
	return nil
}

// validateName applies the shared name rule, reported under this package's
// error so callers match on business.ErrInvalidName.
func validateName(name string) (string, error) {
	return validate.Name(name)
}

// validateTimestamps applies the shared rule for a stored pair of timestamps.
func validateTimestamps(createdAt, updatedAt time.Time) error {
	return validate.Timestamps(createdAt, updatedAt)
}
