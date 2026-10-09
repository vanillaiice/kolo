// Package phone provides a normalised, validated telephone number.
//
// A phone number is the login identity of a user (ADR-012) and the contact
// detail of a customer (SPECIFICATION.md §12) and supplier (§14). The same
// number written "677 123 456", "+237677123456", and "00237 677-123-456" must
// resolve to one value, or a user fails to log in and a customer is looked up
// twice under two records. Normalisation therefore has to be identical
// everywhere, which is why this is a shared value type rather than something
// each domain does for itself.
//
// Parsing is delegated to github.com/nyaruka/phonenumbers, the Go port of
// libphonenumber. Numbering plans change, and a hand-rolled pattern for one
// country would be wrong the first time an operator opened a new prefix.
package phone

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/nyaruka/phonenumbers"
)

// Errors reported by this package.
var (
	// ErrInvalidNumber means a number could not be parsed, or parsed but is not
	// a number that can be dialled.
	ErrInvalidNumber = errors.New("phone: invalid number")
	// ErrUnknownRegion means a region code is not one libphonenumber knows.
	ErrUnknownRegion = errors.New("phone: unknown region")
)

// DefaultRegion is the region assumed for numbers written without an
// international prefix. The target market is Cameroon (§44), where staff enter
// local numbers.
const DefaultRegion = "CM"

// Number is a validated telephone number held in E.164 form.
//
// The zero Number is unset and is rejected wherever a number is required.
type Number struct {
	e164 string
}

// Parse reads a number written for the default region.
//
// Local and international spellings are both accepted; the result is the same
// value either way.
func Parse(input string) (Number, error) {
	return ParseRegion(input, DefaultRegion)
}

// ParseRegion reads a number written for a given region, as a two-letter
// ISO 3166-1 code. The region only matters for numbers written without an
// international prefix.
func ParseRegion(input, region string) (Number, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return Number{}, fmt.Errorf("%w: number is empty", ErrInvalidNumber)
	}

	normalisedRegion := strings.ToUpper(strings.TrimSpace(region))
	if !isKnownRegion(normalisedRegion) {
		return Number{}, fmt.Errorf("%w: %q", ErrUnknownRegion, region)
	}

	// libphonenumber is built to pull a number out of surrounding prose, so it
	// happily ignores letters and symbols around the digits. That is the wrong
	// leniency for a field someone typed on purpose: it would turn a slip into a
	// valid but different number. Only the characters people actually use to
	// write a number are allowed through.
	if offending, found := firstUnexpectedCharacter(trimmed); found {
		return Number{}, fmt.Errorf("%w: %q contains %U", ErrInvalidNumber, input, offending)
	}

	parsed, err := phonenumbers.Parse(trimmed, normalisedRegion)
	if err != nil {
		return Number{}, fmt.Errorf("%w: %q: %w", ErrInvalidNumber, input, err)
	}
	// Parse accepts strings that are syntactically plausible but not dialable,
	// so validity has to be asked for separately.
	if !phonenumbers.IsValidNumber(parsed) {
		return Number{}, fmt.Errorf("%w: %q is not a dialable number", ErrInvalidNumber, input)
	}

	return Number{e164: phonenumbers.Format(parsed, phonenumbers.E164)}, nil
}

// MustParse is Parse for numbers known at compile time, such as fixtures. It
// panics on invalid input.
func MustParse(input string) Number {
	parsed, err := Parse(input)
	if err != nil {
		panic(err)
	}
	return parsed
}

func isKnownRegion(region string) bool {
	_, known := phonenumbers.GetSupportedRegions()[region]
	return known
}

// dialCharacters are the characters a person uses when writing a telephone
// number: the digits, the international prefix, and the separators that appear
// in printed and spoken forms.
const dialCharacters = "0123456789+-.()/ "

// firstUnexpectedCharacter returns the first character of input that is not one
// people write telephone numbers with.
func firstUnexpectedCharacter(input string) (rune, bool) {
	for _, character := range input {
		if !strings.ContainsRune(dialCharacters, character) {
			return character, true
		}
	}
	return 0, false
}

// String returns the number in E.164 form, for example "+237677123456". This is
// the stored and transmitted form.
func (n Number) String() string { return n.e164 }

// IsZero reports whether the number is unset.
func (n Number) IsZero() bool { return n.e164 == "" }

// reread parses the stored E.164 form back into the library's representation.
//
// It cannot fail for a value this package produced, because the stored form
// came from the library itself after validation. The failure branch exists so
// that a value somehow carrying nonsense degrades to a readable fallback
// instead of panicking on a display path.
func (n Number) reread() (*phonenumbers.PhoneNumber, bool) {
	if n.IsZero() {
		return nil, false
	}
	parsed, err := phonenumbers.Parse(n.e164, "")
	if err != nil {
		return nil, false
	}
	return parsed, true
}

// Region returns the two-letter region code the number belongs to, or the empty
// string if it is unset.
func (n Number) Region() string {
	parsed, ok := n.reread()
	if !ok {
		return ""
	}
	return phonenumbers.GetRegionCodeForNumber(parsed)
}

// format renders the number, falling back to the stored digits rather than
// losing it entirely if it cannot be reread.
func (n Number) format(as phonenumbers.PhoneNumberFormat) string {
	parsed, ok := n.reread()
	if !ok {
		return n.e164
	}
	return phonenumbers.Format(parsed, as)
}

// National returns the number formatted the way someone in its own country
// would write it, for display. Storage and comparison always use String.
func (n Number) National() string { return n.format(phonenumbers.NATIONAL) }

// International returns the number in the spaced international form, for
// display.
func (n Number) International() string { return n.format(phonenumbers.INTERNATIONAL) }

// Equal reports whether two numbers are the same. Because both are normalised,
// this is true whatever spelling each was parsed from.
func (n Number) Equal(other Number) bool { return n == other }

// MarshalText implements encoding.TextMarshaler, which also gives Number its
// JSON representation as an E.164 string.
func (n Number) MarshalText() ([]byte, error) {
	return []byte(n.e164), nil
}

// UnmarshalText implements encoding.TextUnmarshaler.
//
// A stored or transmitted number is already in E.164 form, so it carries its
// own country code and is parsed without assuming a region.
func (n *Number) UnmarshalText(text []byte) error {
	if len(text) == 0 {
		*n = Number{}
		return nil
	}
	parsed, err := ParseRegion(string(text), DefaultRegion)
	if err != nil {
		return err
	}
	*n = parsed
	return nil
}

// MarshalJSON implements json.Marshaler. An unset number encodes as null rather
// than an empty string, so an absent contact detail is distinguishable from a
// blank one.
func (n Number) MarshalJSON() ([]byte, error) {
	if n.IsZero() {
		return []byte("null"), nil
	}
	return json.Marshal(n.e164)
}

// UnmarshalJSON implements json.Unmarshaler. A null leaves the value untouched,
// following the encoding/json convention.
func (n *Number) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return fmt.Errorf("phone: decoding number: %w", err)
	}
	return n.UnmarshalText([]byte(text))
}
