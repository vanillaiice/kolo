package money_test

import (
	"math"
	"math/big"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// This file checks MulRatio against an independent reference.
//
// The reference is deliberately built a different way from the implementation.
// MulRatio resolves a fraction by doubling the division remainder and comparing
// it to the divisor; the reference computes the exact rational value, takes the
// integers either side of it, and compares the two distances. Agreement between
// two unrelated methods is evidence the rounding is right, in a way that
// re-deriving the same algorithm in the test would not be.

var allRoundingModes = []money.Rounding{
	money.RoundHalfUp,
	money.RoundHalfEven,
	money.RoundDown,
}

// referenceRound returns the correctly rounded value of amount*num/den.
func referenceRound(amount, num, den int64, mode money.Rounding) *big.Int {
	exact := new(big.Rat).SetFrac(
		new(big.Int).Mul(big.NewInt(amount), big.NewInt(num)),
		big.NewInt(den),
	)

	// Div is Euclidean and the rational's denominator is always positive, so
	// this is the floor of the exact value.
	floor := new(big.Int).Div(exact.Num(), exact.Denom())
	if exact.IsInt() {
		return floor
	}
	ceiling := new(big.Int).Add(floor, big.NewInt(1))

	floorRat := new(big.Rat).SetInt(floor)
	ceilingRat := new(big.Rat).SetInt(ceiling)
	toFloor := new(big.Rat).Sub(exact, floorRat)
	toCeiling := new(big.Rat).Sub(ceilingRat, exact)
	nearest := toFloor.Cmp(toCeiling)

	switch mode {
	case money.RoundDown:
		// Toward zero: the floor for positive values, the ceiling for negative.
		if exact.Sign() >= 0 {
			return floor
		}
		return ceiling

	case money.RoundHalfUp:
		if nearest < 0 {
			return floor
		}
		if nearest > 0 {
			return ceiling
		}
		// A tie goes away from zero.
		if exact.Sign() >= 0 {
			return ceiling
		}
		return floor

	case money.RoundHalfEven:
		if nearest < 0 {
			return floor
		}
		if nearest > 0 {
			return ceiling
		}
		// A tie goes to whichever neighbour is even.
		if floor.Bit(0) == 0 {
			return floor
		}
		return ceiling
	}

	panic("unreachable: invalid rounding mode")
}

// TestMulRatioMatchesReferenceAcrossAGrid sweeps a dense grid of amounts and
// ratios, including negatives and exact ties, against the reference.
func TestMulRatioMatchesReferenceAcrossAGrid(t *testing.T) {
	amounts := []int64{
		-1_000_001, -100_000, -18_500, -101, -100, -51, -50, -49, -3, -2, -1,
		0,
		1, 2, 3, 49, 50, 51, 100, 101, 18_500, 100_000, 1_000_001,
	}
	numerators := []int64{-7, -3, -2, -1, 0, 1, 2, 3, 5, 7, 15, 100, 175, 1_000}
	denominators := []int64{-7, -3, -2, -1, 1, 2, 3, 6, 7, 8, 100, 1_000, 10_000}

	checked := 0
	for _, amount := range amounts {
		for _, num := range numerators {
			for _, den := range denominators {
				for _, mode := range allRoundingModes {
					got, err := money.FromXAF(amount).MulRatio(num, den, mode)
					if err != nil {
						t.Fatalf("MulRatio(%d, %d/%d, %s): %v", amount, num, den, mode, err)
					}
					want := referenceRound(amount, num, den, mode)
					if !want.IsInt64() || got.Amount() != want.Int64() {
						t.Fatalf("MulRatio(%d, %d/%d, %s) = %d, want %s",
							amount, num, den, mode, got.Amount(), want)
					}
					checked++
				}
			}
		}
	}

	if checked == 0 {
		t.Fatal("the grid checked nothing")
	}
	t.Logf("checked %d combinations against the reference", checked)
}

// TestMulRatioMatchesReferenceAtExtremes covers magnitudes where an
// implementation that multiplied in int64 would already have wrapped.
func TestMulRatioMatchesReferenceAtExtremes(t *testing.T) {
	tests := []struct {
		name             string
		amount, num, den int64
	}{
		{"max scaled down by a large denominator", math.MaxInt64, 1, 1_000_000},
		{"min scaled down by a large denominator", math.MinInt64, 1, 1_000_000},
		{"max scaled by a huge numerator and denominator", math.MaxInt64, 999_999, 1_000_000},
		{"min scaled by a huge numerator and denominator", math.MinInt64, 999_999, 1_000_000},
		{"max halved", math.MaxInt64, 1, 2},
		{"min halved", math.MinInt64, 1, 2},
		{"max times one", math.MaxInt64, 1, 1},
		{"min times one", math.MinInt64, 1, 1},
		{"max negated by ratio", math.MaxInt64, -1, 1},
		{"large numerator against large denominator", math.MaxInt64, math.MaxInt64, math.MaxInt64},
	}
	for _, tc := range tests {
		for _, mode := range allRoundingModes {
			t.Run(tc.name+"/"+mode.String(), func(t *testing.T) {
				got, err := money.FromXAF(tc.amount).MulRatio(tc.num, tc.den, mode)
				if err != nil {
					t.Fatalf("MulRatio: %v", err)
				}
				want := referenceRound(tc.amount, tc.num, tc.den, mode)
				if !want.IsInt64() {
					t.Fatalf("the reference itself overflowed: %s", want)
				}
				if got.Amount() != want.Int64() {
					t.Errorf("MulRatio(%d, %d/%d, %s) = %d, want %s",
						tc.amount, tc.num, tc.den, mode, got.Amount(), want)
				}
			})
		}
	}
}

// FuzzMulRatio checks against the reference on arbitrary inputs, and that an
// out-of-range result is reported rather than wrapped.
func FuzzMulRatio(f *testing.F) {
	f.Add(int64(18_500), int64(15), int64(100), uint8(money.RoundHalfUp))
	f.Add(int64(-5), int64(1), int64(2), uint8(money.RoundHalfEven))
	f.Add(int64(math.MaxInt64), int64(3), int64(1), uint8(money.RoundDown))
	f.Add(int64(0), int64(0), int64(1), uint8(money.RoundHalfUp))
	f.Add(int64(math.MinInt64), int64(-1), int64(1), uint8(money.RoundHalfUp))

	f.Fuzz(func(t *testing.T, amount, num, den int64, rawMode uint8) {
		mode := money.Rounding(rawMode)
		got, err := money.FromXAF(amount).MulRatio(num, den, mode)

		if den == 0 {
			if err == nil {
				t.Fatalf("MulRatio with a zero denominator returned %d, want an error", got.Amount())
			}
			return
		}
		if mode != money.RoundHalfUp && mode != money.RoundHalfEven && mode != money.RoundDown {
			if err == nil {
				t.Fatalf("MulRatio with mode %d returned %d, want an error", rawMode, got.Amount())
			}
			return
		}

		want := referenceRound(amount, num, den, mode)
		if !want.IsInt64() {
			if err == nil {
				t.Fatalf("MulRatio(%d, %d/%d, %s) = %d, want an overflow error since the exact value is %s",
					amount, num, den, mode, got.Amount(), want)
			}
			return
		}
		if err != nil {
			t.Fatalf("MulRatio(%d, %d/%d, %s): %v", amount, num, den, mode, err)
		}
		if got.Amount() != want.Int64() {
			t.Fatalf("MulRatio(%d, %d/%d, %s) = %d, want %s",
				amount, num, den, mode, got.Amount(), want)
		}
		if got.Currency() != money.XAF {
			t.Fatalf("MulRatio changed the currency to %s", got.Currency())
		}
	})
}
