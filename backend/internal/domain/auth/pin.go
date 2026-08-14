// Package auth proves who a user is.
//
// It is separate from the users domain, which says what a user may do
// (SPECIFICATION.md §5 lists Authentication and Users & Roles as distinct
// domains). A Credential belongs to a user identifier but knows nothing else
// about the person; nothing here decides authorization.
//
// The model is phone-and-PIN, verified by the server, with a long-lived session
// cached on the device — see ADR-012.
package auth

import (
	"errors"
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/crypto/bcrypt"
)

// Errors reported when a PIN is unusable.
var (
	// ErrInvalidPIN means a PIN is the wrong length, contains something other
	// than digits, or is too easily guessed.
	ErrInvalidPIN = errors.New("auth: invalid PIN")
	// ErrWeakPIN means a PIN is well formed but trivially guessable.
	ErrWeakPIN = errors.New("auth: PIN is too easily guessed")
)

// PIN length bounds. Four digits is what a cashier expects at a till; allowing
// more lets a business that wants a longer secret choose one.
const (
	MinPINLength = 4
	MaxPINLength = 8
)

// hashCost is the bcrypt work factor.
//
// A PIN has very little entropy — four digits is one of ten thousand values —
// so the hash is not what makes it safe. ADR-012 puts that job on keeping
// hashes server-side and rate limiting attempts. The cost here still matters
// for the case those fail: it decides how long a leaked table takes to crack.
const hashCost = bcrypt.DefaultCost

// PINHash is the stored form of a PIN. The PIN itself is never retained.
//
// The zero PINHash is unset and verifies nothing.
type PINHash struct {
	encoded string
}

// HashPIN validates a PIN and returns its stored form.
func HashPIN(pin string) (PINHash, error) {
	return hashPINAtCost(pin, hashCost)
}

// hashPINAtCost is HashPIN with the work factor given explicitly, so that the
// cost-dependent behaviour can be exercised without waiting on the production
// factor.
func hashPINAtCost(pin string, cost int) (PINHash, error) {
	if err := ValidatePIN(pin); err != nil {
		return PINHash{}, err
	}

	encoded, err := bcrypt.GenerateFromPassword([]byte(pin), cost)
	if err != nil {
		return PINHash{}, fmt.Errorf("auth: hashing PIN: %w", err)
	}
	return PINHash{encoded: string(encoded)}, nil
}

// RestorePINHash rebuilds a stored hash read back from the database.
//
// It checks the value is a hash this package could have produced, so a column
// holding a plaintext PIN — from a bad migration, say — is refused rather than
// compared against as though it were a hash.
func RestorePINHash(encoded string) (PINHash, error) {
	if strings.TrimSpace(encoded) == "" {
		return PINHash{}, fmt.Errorf("%w: stored hash is empty", ErrInvalidPIN)
	}
	if _, err := bcrypt.Cost([]byte(encoded)); err != nil {
		return PINHash{}, fmt.Errorf("%w: stored value is not a bcrypt hash: %w", ErrInvalidPIN, err)
	}
	return PINHash{encoded: encoded}, nil
}

// String returns the stored hash, for persistence.
//
// It is named String rather than Hash so that a PINHash printed into a log line
// is at least obviously a hash and not a PIN. There is no accessor for a
// plaintext PIN because none is kept.
func (p PINHash) String() string { return p.encoded }

// IsZero reports whether the hash is unset.
func (p PINHash) IsZero() bool { return p.encoded == "" }

// Verify reports whether a PIN matches the hash.
//
// The comparison is constant-time with respect to the hash contents, which is
// bcrypt's own guarantee. An unset hash never matches, so a user with no
// credential cannot be logged in by supplying an empty PIN.
func (p PINHash) Verify(pin string) bool {
	if p.IsZero() {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(p.encoded), []byte(pin)) == nil
}

// NeedsRehash reports whether the hash was made with a weaker work factor than
// the package now uses.
//
// Work factors are raised over time as hardware improves. A login is the only
// moment the plaintext PIN is available, so it is the only chance to upgrade a
// stored hash in place.
func (p PINHash) NeedsRehash() bool {
	if p.IsZero() {
		return true
	}
	cost, err := bcrypt.Cost([]byte(p.encoded))
	if err != nil {
		return true
	}
	return cost < hashCost
}

// ValidatePIN checks that a PIN is well formed and not trivially guessable.
//
// The rules are deliberately modest. A PIN is entered many times a day on a
// touchscreen, and demanding complexity from a four-digit number mostly
// produces PINs written on the side of the till. What is refused is the small
// set an attacker would try first.
func ValidatePIN(pin string) error {
	if length := len(pin); length < MinPINLength || length > MaxPINLength {
		return fmt.Errorf("%w: a PIN is %d to %d digits, got %d",
			ErrInvalidPIN, MinPINLength, MaxPINLength, length)
	}
	for _, character := range pin {
		if !unicode.IsDigit(character) || character > unicode.MaxASCII {
			return fmt.Errorf("%w: a PIN is digits only", ErrInvalidPIN)
		}
	}
	if isRepeatedDigit(pin) {
		return fmt.Errorf("%w: every digit is the same", ErrWeakPIN)
	}
	if isSequential(pin) {
		return fmt.Errorf("%w: the digits run in sequence", ErrWeakPIN)
	}
	return nil
}

func isRepeatedDigit(pin string) bool {
	for i := 1; i < len(pin); i++ {
		if pin[i] != pin[0] {
			return false
		}
	}
	return true
}

// isSequential reports whether the digits ascend or descend by one throughout,
// covering 1234 and 4321 alike.
func isSequential(pin string) bool {
	ascending, descending := true, true
	for i := 1; i < len(pin); i++ {
		step := int(pin[i]) - int(pin[i-1])
		if step != 1 {
			ascending = false
		}
		if step != -1 {
			descending = false
		}
	}
	return ascending || descending
}
