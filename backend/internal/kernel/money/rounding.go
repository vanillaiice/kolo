package money

import "math/big"

// Rounding selects how a fractional result is resolved to a whole minor unit.
//
// The zero value is deliberately invalid: callers must state which rule
// applies, because that choice is part of the business rule being expressed.
type Rounding uint8

const (
	// RoundHalfUp rounds a tie away from zero. This is the usual commercial
	// expectation: half a franc becomes a whole franc.
	RoundHalfUp Rounding = iota + 1

	// RoundHalfEven rounds a tie to the nearest even unit, so that rounding
	// error does not accumulate in one direction across many calculations.
	RoundHalfEven

	// RoundDown truncates toward zero, never increasing the magnitude.
	RoundDown
)

func (r Rounding) valid() bool {
	switch r {
	case RoundHalfUp, RoundHalfEven, RoundDown:
		return true
	default:
		return false
	}
}

// String implements fmt.Stringer.
func (r Rounding) String() string {
	switch r {
	case RoundHalfUp:
		return "half-up"
	case RoundHalfEven:
		return "half-even"
	case RoundDown:
		return "down"
	default:
		return "invalid"
	}
}

// divRound divides num by den at arbitrary precision and resolves the
// remainder according to mode. den must be non-zero; mode must be valid.
func divRound(num, den *big.Int, mode Rounding) *big.Int {
	// Normalise so the divisor is positive; the sign then rides on the
	// dividend, which keeps the tie comparison below straightforward.
	n := new(big.Int).Set(num)
	d := new(big.Int).Set(den)
	if d.Sign() < 0 {
		n.Neg(n)
		d.Neg(d)
	}

	// QuoRem truncates toward zero and gives a remainder with the sign of n.
	quotient, remainder := new(big.Int).QuoRem(n, d, new(big.Int))
	if remainder.Sign() == 0 || mode == RoundDown {
		return quotient
	}

	// Compare twice the remainder against the divisor to classify the fraction
	// as below, exactly at, or above one half, without leaving the integers.
	doubled := new(big.Int).Abs(remainder)
	doubled.Lsh(doubled, 1)
	comparison := doubled.Cmp(d)

	roundAway := false
	switch mode {
	case RoundHalfUp:
		roundAway = comparison >= 0
	case RoundHalfEven:
		roundAway = comparison > 0 || (comparison == 0 && quotient.Bit(0) == 1)
	}
	if roundAway {
		quotient.Add(quotient, big.NewInt(int64(remainder.Sign())))
	}
	return quotient
}
