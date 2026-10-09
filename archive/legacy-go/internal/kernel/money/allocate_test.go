package money_test

import (
	"math"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// TestAllocateAtExtremeMagnitudes covers amounts and ratios where an
// implementation that summed ratios in int64, or multiplied before dividing,
// would wrap.
func TestAllocateAtExtremeMagnitudes(t *testing.T) {
	tests := []struct {
		name   string
		amount int64
		ratios []int64
	}{
		{"largest amount, even split", math.MaxInt64, []int64{1, 1}},
		{"largest amount, odd split", math.MaxInt64, []int64{1, 1, 1}},
		{"most negative amount, even split", math.MinInt64, []int64{1, 1}},
		{"most negative amount, odd split", math.MinInt64, []int64{1, 1, 1}},
		{"ratios that overflow int64 when summed", 1_000, []int64{math.MaxInt64, math.MaxInt64}},
		{"one huge ratio against a tiny one", 1_000, []int64{math.MaxInt64, 1}},
		{"largest amount with huge ratios", math.MaxInt64, []int64{math.MaxInt64, math.MaxInt64}},
		{"most negative amount with huge ratios", math.MinInt64, []int64{math.MaxInt64, 1}},
		{"single part takes the most negative amount", math.MinInt64, []int64{3}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			amount := money.FromXAF(tc.amount)

			parts, err := amount.Allocate(tc.ratios...)
			if err != nil {
				t.Fatalf("Allocate: %v", err)
			}
			assertPartsSumTo(t, parts, amount)
		})
	}
}

// TestAllocateWhenPartsOutnumberUnits checks that a remainder smaller than the
// number of parts is still distributed exactly, leaving some parts at zero.
func TestAllocateWhenPartsOutnumberUnits(t *testing.T) {
	tests := []struct {
		name   string
		amount int64
		parts  int
		want   []int64
	}{
		{"two francs over five ways", 2, 5, []int64{1, 1, 0, 0, 0}},
		{"one franc over three ways", 1, 3, []int64{1, 0, 0}},
		{"one negative franc over three ways", -1, 3, []int64{-1, 0, 0}},
		{"nothing over four ways", 0, 4, []int64{0, 0, 0, 0}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			parts, err := money.FromXAF(tc.amount).Split(tc.parts)
			if err != nil {
				t.Fatalf("Split: %v", err)
			}
			assertAmounts(t, parts, tc.want)
		})
	}
}

func TestAllocateOverManyParts(t *testing.T) {
	const parts = 1_000
	amount := money.FromXAF(1_000_003)

	split, err := amount.Split(parts)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	if len(split) != parts {
		t.Fatalf("got %d parts, want %d", len(split), parts)
	}
	assertPartsSumTo(t, split, amount)

	// Every part must be within one unit of every other, or the split is not
	// "as evenly as possible".
	lowest, highest := split[0].Amount(), split[0].Amount()
	for _, part := range split {
		lowest = min(lowest, part.Amount())
		highest = max(highest, part.Amount())
	}
	if highest-lowest > 1 {
		t.Errorf("parts range from %d to %d, want a spread of at most one unit", lowest, highest)
	}
}

func TestAllocatePreservesCurrency(t *testing.T) {
	parts, err := money.MustNew(1_000, money.EUR).Allocate(1, 1, 1)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	for i, part := range parts {
		if part.Currency() != money.EUR {
			t.Errorf("part %d has currency %s, want EUR", i, part.Currency())
		}
	}
}

func TestAllocateRejectsUndefinedCurrency(t *testing.T) {
	var undefined money.Money
	if _, err := undefined.Allocate(1, 1); err == nil {
		t.Error("Allocate on the zero Money succeeded, want an error")
	}
	if _, err := undefined.Split(2); err == nil {
		t.Error("Split on the zero Money succeeded, want an error")
	}
}

// FuzzAllocate checks the invariant that matters on arbitrary input: the parts
// must sum back to the original, and no part may exceed it in magnitude.
func FuzzAllocate(f *testing.F) {
	f.Add(int64(18_500), int64(1), int64(1), int64(0), int64(0))
	f.Add(int64(-100), int64(1), int64(1), int64(1), int64(0))
	f.Add(int64(math.MaxInt64), int64(math.MaxInt64), int64(1), int64(0), int64(0))
	f.Add(int64(math.MinInt64), int64(3), int64(5), int64(7), int64(11))
	f.Add(int64(0), int64(0), int64(0), int64(0), int64(1))

	f.Fuzz(func(t *testing.T, amount, r0, r1, r2, r3 int64) {
		ratios := []int64{r0, r1, r2, r3}

		original := money.FromXAF(amount)
		parts, err := original.Allocate(ratios...)

		// Negative ratios and an all-zero set are the only rejected inputs.
		unusable := r0 < 0 || r1 < 0 || r2 < 0 || r3 < 0 || (r0 == 0 && r1 == 0 && r2 == 0 && r3 == 0)
		if unusable {
			if err == nil {
				t.Fatalf("Allocate(%d, %v) succeeded, want an error", amount, ratios)
			}
			return
		}
		if err != nil {
			t.Fatalf("Allocate(%d, %v): %v", amount, ratios, err)
		}

		if len(parts) != len(ratios) {
			t.Fatalf("got %d parts, want %d", len(parts), len(ratios))
		}

		total, err := money.Sum(money.XAF, parts...)
		if err != nil {
			t.Fatalf("summing the parts of %d %v: %v", amount, ratios, err)
		}
		if !total.Equal(original) {
			t.Fatalf("Allocate(%d, %v) parts sum to %d", amount, ratios, total.Amount())
		}

		for i, part := range parts {
			// A part never exceeds the whole, and never opposes its sign.
			if amount >= 0 && (part.Amount() < 0 || part.Amount() > amount) {
				t.Fatalf("Allocate(%d, %v) part %d = %d, outside [0, %d]", amount, ratios, i, part.Amount(), amount)
			}
			if amount < 0 && (part.Amount() > 0 || part.Amount() < amount) {
				t.Fatalf("Allocate(%d, %v) part %d = %d, outside [%d, 0]", amount, ratios, i, part.Amount(), amount)
			}
			// A party allocated nothing receives nothing.
			if ratios[i] == 0 && part.Amount() != 0 {
				t.Fatalf("Allocate(%d, %v) gave %d to part %d, which has a zero ratio", amount, ratios, part.Amount(), i)
			}
		}
	})
}

// FuzzSplit checks the same invariant for even splits over an arbitrary count.
func FuzzSplit(f *testing.F) {
	f.Add(int64(1_000), 3)
	f.Add(int64(-1), 7)
	f.Add(int64(math.MinInt64), 2)
	f.Add(int64(math.MaxInt64), 1)
	f.Add(int64(0), 0)

	f.Fuzz(func(t *testing.T, amount int64, parts int) {
		// Keep the part count to something a business could plausibly ask for,
		// so the fuzzer spends its budget on the arithmetic rather than on
		// allocating enormous slices.
		if parts > 512 {
			parts = 512
		}

		original := money.FromXAF(amount)
		split, err := original.Split(parts)

		if parts <= 0 {
			if err == nil {
				t.Fatalf("Split(%d) succeeded, want an error", parts)
			}
			return
		}
		if err != nil {
			t.Fatalf("Split(%d, %d): %v", amount, parts, err)
		}
		if len(split) != parts {
			t.Fatalf("got %d parts, want %d", len(split), parts)
		}

		total, err := money.Sum(money.XAF, split...)
		if err != nil {
			t.Fatalf("summing: %v", err)
		}
		if !total.Equal(original) {
			t.Fatalf("Split(%d, %d) parts sum to %d", amount, parts, total.Amount())
		}
	})
}

func assertPartsSumTo(t *testing.T, parts []money.Money, want money.Money) {
	t.Helper()
	total, err := money.Sum(want.Currency(), parts...)
	if err != nil {
		t.Fatalf("summing the parts: %v", err)
	}
	if !total.Equal(want) {
		t.Errorf("parts sum to %s, want %s", total, want)
	}
}
