package money_test

import (
	"errors"
	"math"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

func TestMulRatioRounding(t *testing.T) {
	tests := []struct {
		name     string
		amount   int64
		num, den int64
		mode     money.Rounding
		want     int64
	}{
		// Exact results are unaffected by the mode.
		{"ten percent of 10000, exact", 10_000, 10, 100, money.RoundHalfUp, 1_000},
		{"ten percent of 10000, half-even", 10_000, 10, 100, money.RoundHalfEven, 1_000},
		{"ten percent of 10000, down", 10_000, 10, 100, money.RoundDown, 1_000},

		// A fraction strictly below one half.
		{"below half, half-up", 100, 4, 30, money.RoundHalfUp, 13},
		{"below half, half-even", 100, 4, 30, money.RoundHalfEven, 13},
		{"below half, down", 100, 4, 30, money.RoundDown, 13},

		// A fraction strictly above one half.
		{"above half, half-up", 100, 2, 3, money.RoundHalfUp, 67},
		{"above half, half-even", 100, 2, 3, money.RoundHalfEven, 67},
		{"above half, down", 100, 2, 3, money.RoundDown, 66},

		// Exact ties, where the modes separate.
		{"tie up to odd, half-up", 5, 1, 2, money.RoundHalfUp, 3},
		{"tie to even, half-even", 5, 1, 2, money.RoundHalfEven, 2},
		{"tie truncated, down", 5, 1, 2, money.RoundDown, 2},
		{"tie already even, half-even", 7, 1, 2, money.RoundHalfEven, 4},

		// Negative amounts round symmetrically about zero.
		{"negative tie, half-up", -5, 1, 2, money.RoundHalfUp, -3},
		{"negative tie, half-even", -5, 1, 2, money.RoundHalfEven, -2},
		{"negative tie, down", -5, 1, 2, money.RoundDown, -2},
		{"negative above half, half-up", -100, 2, 3, money.RoundHalfUp, -67},
		{"negative above half, down", -100, 2, 3, money.RoundDown, -66},

		// A negative denominator is equivalent to negating the numerator.
		{"negative denominator", 100, 1, -2, money.RoundHalfUp, -50},
		{"both negative", -100, -1, -2, money.RoundHalfUp, -50},

		// Scaling up is allowed; the ratio need not be a fraction.
		{"scaled up", 1_000, 3, 1, money.RoundHalfUp, 3_000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := money.FromXAF(tc.amount).MulRatio(tc.num, tc.den, tc.mode)
			if err != nil {
				t.Fatalf("MulRatio: %v", err)
			}
			if got.Amount() != tc.want {
				t.Errorf("%d * %d/%d (%s) = %d, want %d",
					tc.amount, tc.num, tc.den, tc.mode, got.Amount(), tc.want)
			}
		})
	}
}

// TestMulRatioAppliesRealisticDiscount covers the POS path from
// SPECIFICATION.md §9: a percentage discount on a line total.
func TestMulRatioAppliesRealisticDiscount(t *testing.T) {
	lineTotal := money.FromXAF(18_500)

	discount, err := lineTotal.MulRatio(15, 100, money.RoundHalfUp)
	if err != nil {
		t.Fatalf("MulRatio: %v", err)
	}
	if got := discount.Amount(); got != 2_775 {
		t.Errorf("15%% of 18500 = %d, want 2775", got)
	}

	payable, err := lineTotal.Sub(discount)
	if err != nil {
		t.Fatalf("Sub: %v", err)
	}
	if got := payable.Amount(); got != 15_725 {
		t.Errorf("discounted total = %d, want 15725", got)
	}
}

// TestMulRatioDoesNotOverflowIntermediates checks that a product far beyond
// int64 is carried at full precision as long as the final result fits.
func TestMulRatioDoesNotOverflowIntermediates(t *testing.T) {
	got, err := money.FromXAF(math.MaxInt64).MulRatio(1_000_000, 1_000_000, money.RoundHalfUp)
	if err != nil {
		t.Fatalf("MulRatio: %v", err)
	}
	if got.Amount() != math.MaxInt64 {
		t.Errorf("got %d, want MaxInt64", got.Amount())
	}
}

func TestMulRatioReportsOutOfRangeResult(t *testing.T) {
	if _, err := money.FromXAF(math.MaxInt64).MulRatio(3, 1, money.RoundHalfUp); !errors.Is(err, money.ErrOverflow) {
		t.Errorf("got %v, want ErrOverflow", err)
	}
}

func TestMulRatioRejectsZeroDenominator(t *testing.T) {
	if _, err := money.FromXAF(100).MulRatio(1, 0, money.RoundHalfUp); !errors.Is(err, money.ErrDivideByZero) {
		t.Errorf("got %v, want ErrDivideByZero", err)
	}
}

// TestMulRatioRequiresAnExplicitRoundingMode pins ADR-010: the mode is a
// business decision, so the zero value must not quietly pick one.
func TestMulRatioRequiresAnExplicitRoundingMode(t *testing.T) {
	var unset money.Rounding
	if _, err := money.FromXAF(100).MulRatio(1, 3, unset); !errors.Is(err, money.ErrInvalidRounding) {
		t.Errorf("got %v, want ErrInvalidRounding", err)
	}
	if _, err := money.FromXAF(100).MulRatio(1, 3, money.Rounding(99)); !errors.Is(err, money.ErrInvalidRounding) {
		t.Errorf("unrecognised mode: got %v, want ErrInvalidRounding", err)
	}
}

func TestRoundingString(t *testing.T) {
	tests := []struct {
		mode money.Rounding
		want string
	}{
		{money.RoundHalfUp, "half-up"},
		{money.RoundHalfEven, "half-even"},
		{money.RoundDown, "down"},
		{money.Rounding(0), "invalid"},
	}
	for _, tc := range tests {
		if got := tc.mode.String(); got != tc.want {
			t.Errorf("Rounding(%d).String() = %q, want %q", uint8(tc.mode), got, tc.want)
		}
	}
}

// TestHalfEvenDoesNotDriftUpward is the reason the mode exists: repeated ties
// resolved half-up accumulate a bias that half-even avoids.
func TestHalfEvenDoesNotDriftUpward(t *testing.T) {
	var halfUpTotal, halfEvenTotal int64
	for amount := int64(1); amount <= 100; amount += 2 { // odd amounts always tie on /2
		up, err := money.FromXAF(amount).MulRatio(1, 2, money.RoundHalfUp)
		if err != nil {
			t.Fatalf("MulRatio: %v", err)
		}
		even, err := money.FromXAF(amount).MulRatio(1, 2, money.RoundHalfEven)
		if err != nil {
			t.Fatalf("MulRatio: %v", err)
		}
		halfUpTotal += up.Amount()
		halfEvenTotal += even.Amount()
	}

	// The odd amounts 1..99 sum to 2500, so the exact total of amount/2 is 1250.
	// Half-up rounds all fifty ties away from zero and overshoots by 25.
	const exact = 1_250
	if halfUpTotal <= exact {
		t.Errorf("half-up total = %d, expected it to exceed the exact %d", halfUpTotal, exact)
	}
	if halfEvenTotal != exact {
		t.Errorf("half-even total = %d, want the exact %d", halfEvenTotal, exact)
	}
}
