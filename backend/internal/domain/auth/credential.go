package auth

import (
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// ErrNoPhone means a credential was given no login number.
var ErrNoPhone = fmt.Errorf("%w: no phone number", ErrInvalidID)

// Credential is how one user proves who they are: a phone number they are
// known by, and a PIN only they know (ADR-012).
//
// It is keyed by user and carries its business, because a phone number
// identifies a person within one business rather than globally. The same person
// may work for two businesses on the same number.
//
// There is exactly one credential per user. Multiple login methods would each
// be a way in, and the spec describes one.
type Credential struct {
	userID     users.ID
	businessID business.ID
	number     phone.Number
	pin        PINHash
	createdAt  time.Time
	updatedAt  time.Time
}

// CredentialSnapshot is the flat representation of a Credential, used to
// persist it and to rebuild it from storage.
type CredentialSnapshot struct {
	UserID     users.ID
	BusinessID business.ID
	Phone      phone.Number
	PIN        PINHash
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// NewCredential creates a login credential for a user.
//
// The PIN is taken in plaintext and hashed immediately; it is not retained.
func NewCredential(
	userID users.ID,
	businessID business.ID,
	number phone.Number,
	pin string,
	now time.Time,
) (*Credential, error) {
	if userID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if businessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if number.IsZero() {
		return nil, ErrNoPhone
	}
	if err := validate.Moment(now, "creation time"); err != nil {
		return nil, err
	}

	hashed, err := HashPIN(pin)
	if err != nil {
		return nil, err
	}

	moment := now.UTC()
	return &Credential{
		userID:     userID,
		businessID: businessID,
		number:     number,
		pin:        hashed,
		createdAt:  moment,
		updatedAt:  moment,
	}, nil
}

// RestoreCredential rebuilds a credential from storage, validating it on the
// way in.
func RestoreCredential(snapshot CredentialSnapshot) (*Credential, error) {
	if snapshot.UserID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if snapshot.Phone.IsZero() {
		return nil, ErrNoPhone
	}
	if snapshot.PIN.IsZero() {
		return nil, fmt.Errorf("%w: stored credential has no PIN hash", ErrInvalidPIN)
	}
	if err := validate.Timestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	return &Credential{
		userID:     snapshot.UserID,
		businessID: snapshot.BusinessID,
		number:     snapshot.Phone,
		pin:        snapshot.PIN,
		createdAt:  snapshot.CreatedAt.UTC(),
		updatedAt:  snapshot.UpdatedAt.UTC(),
	}, nil
}

// Snapshot returns the flat representation of the credential.
func (c *Credential) Snapshot() CredentialSnapshot {
	return CredentialSnapshot{
		UserID:     c.userID,
		BusinessID: c.businessID,
		Phone:      c.number,
		PIN:        c.pin,
		CreatedAt:  c.createdAt,
		UpdatedAt:  c.updatedAt,
	}
}

// UserID returns the user this credential belongs to.
func (c *Credential) UserID() users.ID { return c.userID }

// BusinessID returns the business the credential is scoped to.
func (c *Credential) BusinessID() business.ID { return c.businessID }

// Phone returns the number the user logs in with.
func (c *Credential) Phone() phone.Number { return c.number }

// PINHash returns the stored hash, for persistence. The PIN itself is not kept.
func (c *Credential) PINHash() PINHash { return c.pin }

// CreatedAt returns when the credential was issued, in UTC.
func (c *Credential) CreatedAt() time.Time { return c.createdAt }

// UpdatedAt returns when it last changed, in UTC.
func (c *Credential) UpdatedAt() time.Time { return c.updatedAt }

// Verify reports whether a PIN matches.
//
// This answers only "is this the right PIN". Whether the account may then be
// used is a question for the user record, which holds the active flag and the
// permissions. Keeping the two apart means a suspended user's PIN still
// verifies, and the refusal comes from the place that knows why.
func (c *Credential) Verify(pin string) bool { return c.pin.Verify(pin) }

// NeedsRehash reports whether the stored hash was made with a weaker work
// factor than the package now uses, so a successful login can upgrade it.
func (c *Credential) NeedsRehash() bool { return c.pin.NeedsRehash() }

// ChangePIN replaces the PIN.
//
// The old PIN is not required here. Whether to demand it, or to demand some
// other proof, is a decision for the application service: an owner resetting a
// cashier's forgotten PIN cannot supply it, while a user changing their own
// should have to.
func (c *Credential) ChangePIN(pin string, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}

	hashed, err := HashPIN(pin)
	if err != nil {
		return err
	}

	c.pin = hashed
	c.updatedAt = at.UTC()
	return nil
}

// Rehash replaces the stored hash with one at the current work factor, keeping
// the same PIN.
//
// A login is the only moment the plaintext is available, so it is the only
// chance to do this. It fails if the PIN does not match, so a wrong attempt
// cannot quietly overwrite the credential.
func (c *Credential) Rehash(pin string, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if !c.Verify(pin) {
		return fmt.Errorf("%w: cannot rehash with a PIN that does not match", ErrInvalidPIN)
	}
	return c.ChangePIN(pin, at)
}

// ChangePhone replaces the login number.
//
// Because the number is the identity a user logs in with, changing it is an
// identity change and the caller is expected to write an audit record (§39).
func (c *Credential) ChangePhone(number phone.Number, at time.Time) error {
	if number.IsZero() {
		return ErrNoPhone
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if c.number.Equal(number) {
		return nil
	}

	c.number = number
	c.updatedAt = at.UTC()
	return nil
}
