// Package money provides an exact, immutable representation of monetary
// amounts as integer minor units paired with a currency.
//
// Money is never a float and never a bare number. Arithmetic across currencies
// is an error rather than a silent coercion, and any result that would exceed
// the int64 range is reported instead of wrapping.
//
// See docs/adr/ADR-010-integer-minor-units-for-money.md.
package money

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
)

// Errors reported by this package. They are wrapped with context, so callers
// should match them with errors.Is.
var (
	// ErrUnknownCurrency means a currency code is not in the registry.
	ErrUnknownCurrency = errors.New("money: unknown currency")
	// ErrUndefinedCurrency means an operation was given the zero Currency.
	ErrUndefinedCurrency = errors.New("money: undefined currency")
	// ErrCurrencyMismatch means two amounts in different currencies were combined.
	ErrCurrencyMismatch = errors.New("money: currency mismatch")
	// ErrOverflow means a result does not fit in int64 minor units.
	ErrOverflow = errors.New("money: amount overflows int64 minor units")
	// ErrInvalidRatios means an allocation was given unusable ratios.
	ErrInvalidRatios = errors.New("money: invalid allocation ratios")
	// ErrInvalidRounding means a rounding mode was not specified or not recognised.
	ErrInvalidRounding = errors.New("money: invalid rounding mode")
	// ErrDivideByZero means a ratio had a zero denominator.
	ErrDivideByZero = errors.New("money: division by zero")
)

// Money is an immutable amount in a currency's minor units.
//
// The zero Money has an undefined currency and is rejected by every operation.
// Construct values with New, MustNew, or FromXAF.
type Money struct {
	minor    int64
	currency Currency
}

// New returns amount minor units in currency c.
func New(minor int64, c Currency) (Money, error) {
	if !c.Defined() {
		return Money{}, ErrUndefinedCurrency
	}
	return Money{minor: minor, currency: c}, nil
}

// MustNew is New for currencies known at compile time. It panics if c is
// undefined, so it is only appropriate with a package currency constant.
func MustNew(minor int64, c Currency) Money {
	m, err := New(minor, c)
	if err != nil {
		panic(err)
	}
	return m
}

// FromXAF returns an amount of whole FCFA, the platform's primary currency.
func FromXAF(francs int64) Money {
	return Money{minor: francs, currency: XAF}
}

// Amount returns the amount in minor units.
func (m Money) Amount() int64 { return m.minor }

// Currency returns the currency of m.
func (m Money) Currency() Currency { return m.currency }

// Valid reports whether m has a defined currency.
func (m Money) Valid() bool { return m.currency.Defined() }

// IsZero reports whether the amount is zero, regardless of currency.
func (m Money) IsZero() bool { return m.minor == 0 }

// IsPositive reports whether the amount is greater than zero.
func (m Money) IsPositive() bool { return m.minor > 0 }

// IsNegative reports whether the amount is less than zero.
func (m Money) IsNegative() bool { return m.minor < 0 }

// sameCurrency validates that m and o can be combined.
func (m Money) sameCurrency(o Money) error {
	if !m.Valid() || !o.Valid() {
		return ErrUndefinedCurrency
	}
	if m.currency != o.currency {
		return fmt.Errorf("%w: %s and %s", ErrCurrencyMismatch, m.currency, o.currency)
	}
	return nil
}

// Add returns m + o.
func (m Money) Add(o Money) (Money, error) {
	if err := m.sameCurrency(o); err != nil {
		return Money{}, err
	}
	sum, err := addInt64(m.minor, o.minor)
	if err != nil {
		return Money{}, err
	}
	return Money{minor: sum, currency: m.currency}, nil
}

// Sub returns m - o.
func (m Money) Sub(o Money) (Money, error) {
	if err := m.sameCurrency(o); err != nil {
		return Money{}, err
	}
	diff, err := subInt64(m.minor, o.minor)
	if err != nil {
		return Money{}, err
	}
	return Money{minor: diff, currency: m.currency}, nil
}

// Neg returns -m. This is how a compensating entry is derived from the
// transaction it reverses.
func (m Money) Neg() (Money, error) {
	if !m.Valid() {
		return Money{}, ErrUndefinedCurrency
	}
	if m.minor == math.MinInt64 {
		return Money{}, ErrOverflow
	}
	return Money{minor: -m.minor, currency: m.currency}, nil
}

// Abs returns the magnitude of m.
func (m Money) Abs() (Money, error) {
	if m.minor >= 0 {
		if !m.Valid() {
			return Money{}, ErrUndefinedCurrency
		}
		return m, nil
	}
	return m.Neg()
}

// Mul returns m multiplied by a whole factor, as in a line total of quantity
// times unit price.
func (m Money) Mul(factor int64) (Money, error) {
	if !m.Valid() {
		return Money{}, ErrUndefinedCurrency
	}
	product, err := mulInt64(m.minor, factor)
	if err != nil {
		return Money{}, err
	}
	return Money{minor: product, currency: m.currency}, nil
}

// MulRatio returns m scaled by the fraction num/den, rounded according to mode.
//
// This is the only way to apply a percentage — a discount, a tax rate, a
// margin. The rounding mode is required rather than defaulted, because where a
// fraction of a unit lands is a business decision and not an artefact of the
// arithmetic. The intermediate product is computed at arbitrary precision, so
// only a genuinely out-of-range result overflows.
func (m Money) MulRatio(num, den int64, mode Rounding) (Money, error) {
	if !m.Valid() {
		return Money{}, ErrUndefinedCurrency
	}
	if den == 0 {
		return Money{}, ErrDivideByZero
	}
	if !mode.valid() {
		return Money{}, fmt.Errorf("%w: %d", ErrInvalidRounding, uint8(mode))
	}

	product := new(big.Int).Mul(big.NewInt(m.minor), big.NewInt(num))
	quotient := divRound(product, big.NewInt(den), mode)
	if !quotient.IsInt64() {
		return Money{}, fmt.Errorf("%w: %s", ErrOverflow, quotient)
	}
	return Money{minor: quotient.Int64(), currency: m.currency}, nil
}

// Allocate splits m into len(ratios) parts in proportion to ratios.
//
// The parts always sum back to m: no minor unit is created or lost. Any
// remainder left by the proportional division is handed out one unit at a time
// to the parts with a non-zero ratio, in order, so the split is deterministic
// and reproducible on any device.
func (m Money) Allocate(ratios ...int64) ([]Money, error) {
	if !m.Valid() {
		return nil, ErrUndefinedCurrency
	}
	if len(ratios) == 0 {
		return nil, fmt.Errorf("%w: no ratios given", ErrInvalidRatios)
	}

	total := new(big.Int)
	for i, r := range ratios {
		if r < 0 {
			return nil, fmt.Errorf("%w: ratio %d is negative", ErrInvalidRatios, i)
		}
		total.Add(total, big.NewInt(r))
	}
	if total.Sign() == 0 {
		return nil, fmt.Errorf("%w: ratios sum to zero", ErrInvalidRatios)
	}

	amount := big.NewInt(m.minor)
	parts := make([]Money, len(ratios))
	allocated := new(big.Int)
	for i, r := range ratios {
		// Truncating toward zero keeps every share no larger in magnitude than
		// the total, so the int64 conversion below cannot overflow.
		share := new(big.Int).Mul(amount, big.NewInt(r))
		share.Quo(share, total)
		parts[i] = Money{minor: share.Int64(), currency: m.currency}
		allocated.Add(allocated, share)
	}

	// The remainder is smaller in magnitude than the number of parts, and
	// carries the sign of the amount.
	remainder := new(big.Int).Sub(amount, allocated)
	step := int64(1)
	if remainder.Sign() < 0 {
		step = -1
	}
	left := new(big.Int).Abs(remainder).Int64()
	for i := range parts {
		if left == 0 {
			break
		}
		if ratios[i] == 0 {
			continue
		}
		parts[i].minor += step
		left--
	}

	return parts, nil
}

// Split divides m into n parts as evenly as possible, distributing any
// remainder to the earliest parts. The parts always sum back to m.
func (m Money) Split(n int) ([]Money, error) {
	if n <= 0 {
		return nil, fmt.Errorf("%w: cannot split into %d parts", ErrInvalidRatios, n)
	}
	ratios := make([]int64, n)
	for i := range ratios {
		ratios[i] = 1
	}
	return m.Allocate(ratios...)
}

// Sum totals amounts in currency c. Summing nothing yields zero in c, so an
// empty cart or a customer with no transactions needs no special case.
func Sum(c Currency, amounts ...Money) (Money, error) {
	total, err := New(0, c)
	if err != nil {
		return Money{}, err
	}
	for i, a := range amounts {
		total, err = total.Add(a)
		if err != nil {
			return Money{}, fmt.Errorf("summing amount %d: %w", i, err)
		}
	}
	return total, nil
}

// Cmp compares m and o, returning -1, 0, or 1.
func (m Money) Cmp(o Money) (int, error) {
	if err := m.sameCurrency(o); err != nil {
		return 0, err
	}
	switch {
	case m.minor < o.minor:
		return -1, nil
	case m.minor > o.minor:
		return 1, nil
	default:
		return 0, nil
	}
}

// Equal reports whether m and o have the same currency and amount. Amounts in
// different currencies are never equal.
func (m Money) Equal(o Money) bool { return m == o }

// String renders the amount with its currency's decimal places, for logs and
// diagnostics. Presenting an amount to a user is a locale-aware concern and
// belongs at the presentation edge, not here.
func (m Money) String() string {
	if !m.Valid() {
		return "invalid money"
	}
	if m.currency.exponent == 0 {
		return strconv.FormatInt(m.minor, 10) + " " + m.currency.code
	}

	digits := int(m.currency.exponent)
	sign := ""
	magnitude := m.minor
	if magnitude < 0 {
		sign = "-"
		// Negating MinInt64 overflows, so work with the unsigned magnitude.
		text := strconv.FormatUint(uint64(-(magnitude+1))+1, 10)
		return sign + withDecimalPoint(text, digits) + " " + m.currency.code
	}
	return withDecimalPoint(strconv.FormatInt(magnitude, 10), digits) + " " + m.currency.code
}

// withDecimalPoint inserts a decimal point digits places from the right of a
// non-negative decimal string, padding with leading zeroes when needed.
func withDecimalPoint(text string, digits int) string {
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	split := len(text) - digits
	return text[:split] + "." + text[split:]
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
	// The reciprocal check below cannot detect this case, because negating
	// MinInt64 wraps back to itself.
	if (a == math.MinInt64 && b == -1) || (b == math.MinInt64 && a == -1) {
		return 0, fmt.Errorf("%w: %d * %d", ErrOverflow, a, b)
	}
	product := a * b
	if product/b != a {
		return 0, fmt.Errorf("%w: %d * %d", ErrOverflow, a, b)
	}
	return product, nil
}
