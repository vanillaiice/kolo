// Package validate holds value rules shared by more than one domain.
//
// It exists to keep a single definition of rules that several entities must
// agree on — what counts as a usable name, what counts as a coherent pair of
// timestamps. A rule belongs here only once a second domain genuinely needs it;
// rules specific to one entity stay with that entity.
package validate

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Errors reported by this package.
var (
	// ErrInvalidName means a name is empty, too long, or contains characters
	// that would not be visible to the person reading it.
	ErrInvalidName = errors.New("validate: invalid name")
	// ErrInvalidTime means a timestamp is unset or inconsistent.
	ErrInvalidTime = errors.New("validate: invalid timestamp")
)

// MaxNameLength is the longest name any entity may carry, in runes. It is
// generous enough for a real trading or personal name, and short enough to
// render in a list on a small screen.
const MaxNameLength = 120

// Name trims a name and checks it is usable, returning the trimmed form.
//
// Names arrive from a phone keyboard, so surrounding whitespace is trimmed
// rather than rejected. Length is counted in runes, so French accents and other
// multi-byte characters are not charged double against the limit.
//
// Invisible characters are refused — not only control characters (Cc) but the
// whole Unicode "other" category: format characters (Cf), private use (Co), and
// surrogates (Cs). Two names that render identically but compare differently
// are a real problem for a shop: staff cannot tell them apart in a list, and a
// bidirectional override can make a receipt display a name other than the one
// stored. The cost is that emoji joined by a zero-width joiner cannot appear in
// a name, which is an acceptable trade.
func Name(value string) (string, error) {
	cleaned := strings.TrimSpace(value)

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

// Moment checks that a single timestamp is set, describing it as label in any
// error.
func Moment(at time.Time, label string) error {
	if at.IsZero() {
		return fmt.Errorf("%w: %s is unset", ErrInvalidTime, label)
	}
	return nil
}

// Timestamps checks a stored pair of creation and update times.
//
// An update recorded before the creation it belongs to means the record is
// corrupt rather than that a clock drifted, because both values are written by
// the same device.
func Timestamps(createdAt, updatedAt time.Time) error {
	if err := Moment(createdAt, "creation time"); err != nil {
		return err
	}
	if err := Moment(updatedAt, "update time"); err != nil {
		return err
	}
	if updatedAt.Before(createdAt) {
		return fmt.Errorf("%w: updated at %s precedes created at %s", ErrInvalidTime, updatedAt, createdAt)
	}
	return nil
}
