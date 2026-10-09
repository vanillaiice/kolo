// Package quantity provides an exact amount of stock.
//
// Quantities are fractional in real shops — half a kilo of rice, two and a half
// metres of cloth — but they are not floating point, for the same reason money
// is not (ADR-010). Adding a tenth of a kilo ten times must give exactly one
// kilo, and with a float it does not. A ledger whose entries do not sum back to
// what was counted is worse than no ledger.
//
// A quantity is therefore a whole number of thousandths. That is enough
// precision for anything sold by weight or measure and coarse enough that the
// arithmetic stays exact.
package quantity

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Errors reported by this package.
var (
	// ErrOverflow means a result does not fit in the representable range.
	ErrOverflow = errors.New("quantity: amount overflows the representable range")
	// ErrInvalidFormat means text could not be read as a quantity.
	ErrInvalidFormat = errors.New("quantity: not a quantity")
	// ErrDivideByZero means a ratio had a zero denominator.
	ErrDivideByZero = errors.New("quantity: division by zero")
)

// Scale is how many units of the underlying integer make up one whole item.
const Scale = 1000

// decimals is the number of decimal places Scale allows.
const decimals = 3

// Quantity is an exact amount of stock, held as thousandths of one unit.
//
// The zero Quantity is none, which is a meaningful value: a product with no
// stock has a quantity of zero rather than an absent one.
//
// Negative quantities are ordinary. A sale is a negative movement, and a stock
// level can legitimately be below zero when two devices each sold the last unit
// offline — a true statement about the business that the system surfaces rather
// than hides (ADR-009).
type Quantity struct {
	thousandths int64
}

// Zero is no stock.
var Zero Quantity

// FromUnits returns a whole number of units.
func FromUnits(units int64) (Quantity, error) {
	if units > math.MaxInt64/Scale || units < math.MinInt64/Scale {
		return Zero, fmt.Errorf("%w: %d units", ErrOverflow, units)
	}
	return Quantity{thousandths: units * Scale}, nil
}

// MustFromUnits is FromUnits for values known at compile time, such as tests
// and fixtures. It panics on an out-of-range value.
func MustFromUnits(units int64) Quantity {
	q, err := FromUnits(units)
	if err != nil {
		panic(err)
	}
	return q
}

// FromThousandths returns a quantity from the underlying integer, which is what
// storage holds.
func FromThousandths(thousandths int64) Quantity {
	return Quantity{thousandths: thousandths}
}

// Thousandths returns the underlying integer, for storage.
func (q Quantity) Thousandths() int64 { return q.thousandths }

// IsZero reports whether there is none.
func (q Quantity) IsZero() bool { return q.thousandths == 0 }

// IsPositive reports whether the quantity is above zero.
func (q Quantity) IsPositive() bool { return q.thousandths > 0 }

// IsNegative reports whether the quantity is below zero.
//
// A negative stock level is not corrupt data: it means more was sold than the
// system knew existed, which happens when devices trade offline (ADR-009).
func (q Quantity) IsNegative() bool { return q.thousandths < 0 }

// IsWhole reports whether the quantity is a whole number of units, which is
// what a product sold by the piece requires.
func (q Quantity) IsWhole() bool { return q.thousandths%Scale == 0 }

// Add returns q + other.
func (q Quantity) Add(other Quantity) (Quantity, error) {
	sum, err := addInt64(q.thousandths, other.thousandths)
	if err != nil {
		return Zero, err
	}
	return Quantity{thousandths: sum}, nil
}

// Sub returns q - other.
func (q Quantity) Sub(other Quantity) (Quantity, error) {
	difference, err := subInt64(q.thousandths, other.thousandths)
	if err != nil {
		return Zero, err
	}
	return Quantity{thousandths: difference}, nil
}

// Neg returns -q. This is how a sale's movement is derived from the quantity
// sold, and how a return reverses one.
func (q Quantity) Neg() (Quantity, error) {
	if q.thousandths == math.MinInt64 {
		return Zero, fmt.Errorf("%w: negating %d", ErrOverflow, q.thousandths)
	}
	return Quantity{thousandths: -q.thousandths}, nil
}

// Abs returns the magnitude.
func (q Quantity) Abs() (Quantity, error) {
	if q.thousandths >= 0 {
		return q, nil
	}
	return q.Neg()
}

// Mul returns the quantity repeated a whole number of times.
func (q Quantity) Mul(factor int64) (Quantity, error) {
	product, err := mulInt64(q.thousandths, factor)
	if err != nil {
		return Zero, err
	}
	return Quantity{thousandths: product}, nil
}

// Cmp compares two quantities, returning -1, 0, or 1.
func (q Quantity) Cmp(other Quantity) int {
	switch {
	case q.thousandths < other.thousandths:
		return -1
	case q.thousandths > other.thousandths:
		return 1
	default:
		return 0
	}
}

// Equal reports whether two quantities are the same.
func (q Quantity) Equal(other Quantity) bool { return q == other }

// Sum totals quantities. Summing nothing is zero, so an empty ledger needs no
// special case.
func Sum(quantities ...Quantity) (Quantity, error) {
	total := Zero
	for i, q := range quantities {
		var err error
		if total, err = total.Add(q); err != nil {
			return Zero, fmt.Errorf("summing quantity %d: %w", i, err)
		}
	}
	return total, nil
}

// String renders the quantity with its decimal places trimmed, so a whole
// number of units reads as one.
func (q Quantity) String() string {
	whole := q.thousandths / Scale
	fraction := q.thousandths % Scale

	if fraction == 0 {
		return strconv.FormatInt(whole, 10)
	}

	sign := ""
	if q.thousandths < 0 {
		sign = "-"
		// Work with magnitudes so the sign is not lost when the whole part is
		// zero, as in -0.5.
		whole, fraction = -whole, -fraction
	}
	text := fmt.Sprintf("%s%d.%03d", sign, whole, fraction)
	return strings.TrimRight(text, "0")
}

// Parse reads a quantity written as a decimal number.
//
// More than three decimal places is refused rather than rounded: someone typing
// a fourth digit means something by it, and silently discarding it would make
// the ledger disagree with what they entered.
func Parse(text string) (Quantity, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return Zero, fmt.Errorf("%w: empty", ErrInvalidFormat)
	}

	negative := false
	switch trimmed[0] {
	case '-':
		negative = true
		trimmed = trimmed[1:]
	case '+':
		trimmed = trimmed[1:]
	}

	wholeText, fractionText, _ := strings.Cut(trimmed, ".")
	// Neither "" nor "." nor "-." is a number. A bare separator with no digits
	// on either side would otherwise read as zero.
	if wholeText == "" && fractionText == "" {
		return Zero, fmt.Errorf("%w: %q", ErrInvalidFormat, text)
	}
	if len(fractionText) > decimals {
		return Zero, fmt.Errorf("%w: %q has more than %d decimal places", ErrInvalidFormat, text, decimals)
	}
	// Digits only. The sign was taken off the front above, so anything else
	// here — a second sign, a space, a letter — means this is not a number.
	// strconv would accept "+5" as a fraction, which would make "1.+5" read as
	// one and a half.
	if !isDigits(wholeText) || !isDigits(fractionText) {
		return Zero, fmt.Errorf("%w: %q", ErrInvalidFormat, text)
	}

	whole := int64(0)
	if wholeText != "" {
		parsed, err := strconv.ParseInt(wholeText, 10, 64)
		if err != nil {
			// Too many digits to represent is an overflow rather than a
			// malformed number: the caller wrote a number, just not one that
			// fits.
			if errors.Is(err, strconv.ErrRange) {
				return Zero, fmt.Errorf("%w: %q", ErrOverflow, text)
			}
			return Zero, fmt.Errorf("%w: %q", ErrInvalidFormat, text)
		}
		whole = parsed
	}

	fraction := int64(0)
	if fractionText != "" {
		padded := fractionText + strings.Repeat("0", decimals-len(fractionText))
		parsed, err := strconv.ParseInt(padded, 10, 64)
		if err != nil {
			return Zero, fmt.Errorf("%w: %q", ErrInvalidFormat, text)
		}
		fraction = parsed
	}

	scaled, err := mulInt64(whole, Scale)
	if err != nil {
		return Zero, fmt.Errorf("%w: %q", ErrOverflow, text)
	}
	total, err := addInt64(scaled, fraction)
	if err != nil {
		return Zero, fmt.Errorf("%w: %q", ErrOverflow, text)
	}

	if negative {
		if total == math.MinInt64 {
			return Zero, fmt.Errorf("%w: %q", ErrOverflow, text)
		}
		total = -total
	}
	return Quantity{thousandths: total}, nil
}

// MustParse is Parse for values known at compile time. It panics on invalid
// input.
func MustParse(text string) Quantity {
	q, err := Parse(text)
	if err != nil {
		panic(err)
	}
	return q
}

// isDigits reports whether every character is an ASCII digit. An empty string
// is treated as digits, since an absent whole or fraction part is allowed.
func isDigits(text string) bool {
	for i := range len(text) {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}

func addInt64(a, b int64) (int64, error) {
	if (b > 0 && a > math.MaxInt64-b) || (b < 0 && a < math.MinInt64-b) {
		return 0, fmt.Errorf("%w: %d + %d", ErrOverflow, a, b)
	}
	return a + b, nil
}

func subInt64(a, b int64) (int64, error) {
	if (b < 0 && a > math.MaxInt64+b) || (b > 0 && a < math.MinInt64+b) {
		return 0, fmt.Errorf("%w: %d - %d", ErrOverflow, a, b)
	}
	return a - b, nil
}

func mulInt64(a, b int64) (int64, error) {
	if a == 0 || b == 0 {
		return 0, nil
	}
	if (a == math.MinInt64 && b == -1) || (b == math.MinInt64 && a == -1) {
		return 0, fmt.Errorf("%w: %d * %d", ErrOverflow, a, b)
	}
	product := a * b
	if product/b != a {
		return 0, fmt.Errorf("%w: %d * %d", ErrOverflow, a, b)
	}
	return product, nil
}
