package business

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// Errors reported when an entity would be invalid.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("business: identifier is unset")
	// ErrInvalidName means a name is empty, too long, or contains control characters.
	ErrInvalidName = errors.New("business: invalid name")
	// ErrInvalidCurrency means no operating currency was given.
	ErrInvalidCurrency = errors.New("business: invalid currency")
	// ErrInvalidTime means a timestamp is unset or inconsistent.
	ErrInvalidTime = errors.New("business: invalid timestamp")
)

// MaxNameLength is the longest name a business or branch may carry, in runes.
// It is generous enough for a real trading name and short enough to render in a
// list on a small screen.
const MaxNameLength = 120

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
	if now.IsZero() {
		return nil, fmt.Errorf("%w: creation time is unset", ErrInvalidTime)
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
	if at.IsZero() {
		return fmt.Errorf("%w: update time is unset", ErrInvalidTime)
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
	if at.IsZero() {
		return fmt.Errorf("%w: update time is unset", ErrInvalidTime)
	}
	if b.active == active {
		return nil
	}
	b.active = active
	b.updatedAt = at.UTC()
	return nil
}

// validateName trims a name and checks it is usable.
//
// Names arrive from a phone keyboard, so surrounding whitespace is trimmed
// rather than rejected. Accents and other multi-byte characters are counted as
// single characters, so a French name is not charged double against the limit.
//
// Invisible characters are refused — not only control characters (Cc) but the
// whole Unicode "other" category: format characters (Cf), private use (Co), and
// surrogates (Cs). Two names that render identically but compare differently
// are a real problem for a shop: staff cannot tell them apart in a list, and a
// bidirectional override can make a receipt display a name other than the one
// stored. The cost is that emoji joined by a zero-width joiner cannot appear in
// a trading name, which is an acceptable trade.
func validateName(name string) (string, error) {
	cleaned := strings.TrimSpace(name)

	if cleaned == "" {
		return "", fmt.Errorf("%w: name is empty", ErrInvalidName)
	}
	if !utf8.ValidString(cleaned) {
		return "", fmt.Errorf("%w: name is not valid UTF-8", ErrInvalidName)
	}
	if length := utf8.RuneCountInString(cleaned); length > MaxNameLength {
		return "", fmt.Errorf("%w: name is %d characters, the limit is %d", ErrInvalidName, length, MaxNameLength)
	}
	for _, character := range cleaned {
		if unicode.In(character, unicode.C) {
			return "", fmt.Errorf("%w: name contains the invisible character %U", ErrInvalidName, character)
		}
	}
	return cleaned, nil
}

// validateTimestamps checks a stored pair of timestamps.
//
// An update recorded before the creation it belongs to means the record is
// corrupt, not that a clock drifted: both values come from the same device.
func validateTimestamps(createdAt, updatedAt time.Time) error {
	if createdAt.IsZero() {
		return fmt.Errorf("%w: creation time is unset", ErrInvalidTime)
	}
	if updatedAt.IsZero() {
		return fmt.Errorf("%w: update time is unset", ErrInvalidTime)
	}
	if updatedAt.Before(createdAt) {
		return fmt.Errorf("%w: updated at %s precedes created at %s", ErrInvalidTime, updatedAt, createdAt)
	}
	return nil
}
