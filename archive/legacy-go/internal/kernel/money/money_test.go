package money_test

import (
	"encoding/json"
	"errors"
	"math"
	"math/rand"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

func TestNewRejectsUndefinedCurrency(t *testing.T) {
	if _, err := money.New(100, money.Currency{}); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Fatalf("New with zero currency: got %v, want ErrUndefinedCurrency", err)
	}
}

func TestFromXAFIsWholeFrancs(t *testing.T) {
	m := money.FromXAF(18_500)
	if got := m.Amount(); got != 18_500 {
		t.Errorf("Amount() = %d, want 18500", got)
	}
	if got := m.Currency(); got != money.XAF {
		t.Errorf("Currency() = %v, want XAF", got)
	}
	if got := money.XAF.Exponent(); got != 0 {
		t.Errorf("XAF exponent = %d, want 0: FCFA has no minor unit", got)
	}
}

func TestZeroValueIsInvalid(t *testing.T) {
	var m money.Money
	if m.Valid() {
		t.Fatal("zero Money reported valid")
	}
	if _, err := m.Add(money.FromXAF(1)); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("Add on zero Money: got %v, want ErrUndefinedCurrency", err)
	}
	if _, err := m.Mul(2); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("Mul on zero Money: got %v, want ErrUndefinedCurrency", err)
	}
}

func TestAdd(t *testing.T) {
	tests := []struct {
		name string
		a, b money.Money
		want int64
	}{
		{"positives", money.FromXAF(10_000), money.FromXAF(8_500), 18_500},
		{"negative operand", money.FromXAF(25_000), money.FromXAF(-10_000), 15_000},
		{"to zero", money.FromXAF(-5_000), money.FromXAF(5_000), 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.a.Add(tc.b)
			if err != nil {
				t.Fatalf("Add: %v", err)
			}
			if got.Amount() != tc.want {
				t.Errorf("Add = %d, want %d", got.Amount(), tc.want)
			}
		})
	}
}

func TestSub(t *testing.T) {
	// The customer credit example from SPECIFICATION.md §13.
	purchase := money.FromXAF(25_000)
	payment := money.FromXAF(10_000)
	outstanding, err := purchase.Sub(payment)
	if err != nil {
		t.Fatalf("Sub: %v", err)
	}
	if got := outstanding.Amount(); got != 15_000 {
		t.Errorf("outstanding = %d, want 15000", got)
	}
}

func TestArithmeticRejectsCurrencyMismatch(t *testing.T) {
	xaf := money.FromXAF(1_000)
	eur := money.MustNew(1_000, money.EUR)

	if _, err := xaf.Add(eur); !errors.Is(err, money.ErrCurrencyMismatch) {
		t.Errorf("Add across currencies: got %v, want ErrCurrencyMismatch", err)
	}
	if _, err := xaf.Sub(eur); !errors.Is(err, money.ErrCurrencyMismatch) {
		t.Errorf("Sub across currencies: got %v, want ErrCurrencyMismatch", err)
	}
	if _, err := xaf.Cmp(eur); !errors.Is(err, money.ErrCurrencyMismatch) {
		t.Errorf("Cmp across currencies: got %v, want ErrCurrencyMismatch", err)
	}
}

func TestOverflowIsReportedNotWrapped(t *testing.T) {
	max := money.FromXAF(math.MaxInt64)
	min := money.FromXAF(math.MinInt64)

	tests := []struct {
		name string
		call func() (money.Money, error)
	}{
		{"add past max", func() (money.Money, error) { return max.Add(money.FromXAF(1)) }},
		{"sub past min", func() (money.Money, error) { return min.Sub(money.FromXAF(1)) }},
		{"add past min", func() (money.Money, error) { return min.Add(money.FromXAF(-1)) }},
		{"sub past max", func() (money.Money, error) { return max.Sub(money.FromXAF(-1)) }},
		{"multiply past max", func() (money.Money, error) { return max.Mul(2) }},
		{"negate min", func() (money.Money, error) { return min.Neg() }},
		{"abs of min", func() (money.Money, error) { return min.Abs() }},
		{"min times minus one", func() (money.Money, error) { return min.Mul(-1) }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.call(); !errors.Is(err, money.ErrOverflow) {
				t.Errorf("got %v, want ErrOverflow", err)
			}
		})
	}
}

func TestAddAtTheBoundaryStillSucceeds(t *testing.T) {
	max := money.FromXAF(math.MaxInt64)
	got, err := max.Add(money.FromXAF(0))
	if err != nil {
		t.Fatalf("adding zero at the boundary: %v", err)
	}
	if got.Amount() != math.MaxInt64 {
		t.Errorf("got %d, want MaxInt64", got.Amount())
	}
}

func TestMul(t *testing.T) {
	// A sale line: 20 units at 400 FCFA, from SPECIFICATION.md §15.
	line, err := money.FromXAF(400).Mul(20)
	if err != nil {
		t.Fatalf("Mul: %v", err)
	}
	if got := line.Amount(); got != 8_000 {
		t.Errorf("line total = %d, want 8000", got)
	}

	zero, err := money.FromXAF(math.MaxInt64).Mul(0)
	if err != nil {
		t.Fatalf("multiplying by zero: %v", err)
	}
	if !zero.IsZero() {
		t.Errorf("MaxInt64 * 0 = %d, want 0", zero.Amount())
	}
}

func TestNegProducesCompensatingAmount(t *testing.T) {
	original := money.FromXAF(25_000)
	reversal, err := original.Neg()
	if err != nil {
		t.Fatalf("Neg: %v", err)
	}
	if got := reversal.Amount(); got != -25_000 {
		t.Errorf("reversal = %d, want -25000", got)
	}

	net, err := original.Add(reversal)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if !net.IsZero() {
		t.Errorf("original plus its reversal = %d, want 0", net.Amount())
	}
}

func TestSigns(t *testing.T) {
	tests := []struct {
		amount                   int64
		zero, positive, negative bool
	}{
		{0, true, false, false},
		{1, false, true, false},
		{-1, false, false, true},
	}
	for _, tc := range tests {
		m := money.FromXAF(tc.amount)
		if m.IsZero() != tc.zero || m.IsPositive() != tc.positive || m.IsNegative() != tc.negative {
			t.Errorf("%d: zero=%v positive=%v negative=%v, want %v/%v/%v",
				tc.amount, m.IsZero(), m.IsPositive(), m.IsNegative(),
				tc.zero, tc.positive, tc.negative)
		}
	}
}

func TestCmpAndEqual(t *testing.T) {
	a, b := money.FromXAF(100), money.FromXAF(200)

	if got, _ := a.Cmp(b); got != -1 {
		t.Errorf("Cmp(100, 200) = %d, want -1", got)
	}
	if got, _ := b.Cmp(a); got != 1 {
		t.Errorf("Cmp(200, 100) = %d, want 1", got)
	}
	if got, _ := a.Cmp(money.FromXAF(100)); got != 0 {
		t.Errorf("Cmp(100, 100) = %d, want 0", got)
	}

	if !a.Equal(money.FromXAF(100)) {
		t.Error("equal amounts in the same currency reported unequal")
	}
	if a.Equal(money.MustNew(100, money.EUR)) {
		t.Error("equal amounts in different currencies reported equal")
	}
}

func TestSum(t *testing.T) {
	// Split payment from SPECIFICATION.md §11.
	total, err := money.Sum(money.XAF, money.FromXAF(10_000), money.FromXAF(8_500))
	if err != nil {
		t.Fatalf("Sum: %v", err)
	}
	if got := total.Amount(); got != 18_500 {
		t.Errorf("Sum = %d, want 18500", got)
	}
}

func TestSumOfNothingIsZeroInTheGivenCurrency(t *testing.T) {
	total, err := money.Sum(money.XAF)
	if err != nil {
		t.Fatalf("Sum of nothing: %v", err)
	}
	if !total.IsZero() || total.Currency() != money.XAF {
		t.Errorf("Sum of nothing = %v, want 0 XAF", total)
	}
}

func TestSumRejectsForeignAmount(t *testing.T) {
	_, err := money.Sum(money.XAF, money.FromXAF(100), money.MustNew(100, money.EUR))
	if !errors.Is(err, money.ErrCurrencyMismatch) {
		t.Errorf("got %v, want ErrCurrencyMismatch", err)
	}
}

func TestString(t *testing.T) {
	tests := []struct {
		name string
		m    money.Money
		want string
	}{
		{"whole francs", money.FromXAF(18_500), "18500 XAF"},
		{"negative francs", money.FromXAF(-5_000), "-5000 XAF"},
		{"zero francs", money.FromXAF(0), "0 XAF"},
		{"euros with cents", money.MustNew(18_550, money.EUR), "185.50 EUR"},
		{"euros under one", money.MustNew(7, money.EUR), "0.07 EUR"},
		{"negative euros", money.MustNew(-18_550, money.EUR), "-185.50 EUR"},
		{"invalid", money.Money{}, "invalid money"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.m.String(); got != tc.want {
				t.Errorf("String() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestStringHandlesMostNegativeAmount(t *testing.T) {
	// Rendering must not negate MinInt64, which would overflow.
	if got := money.MustNew(math.MinInt64, money.EUR).String(); got != "-92233720368547758.08 EUR" {
		t.Errorf("String() = %q, want %q", got, "-92233720368547758.08 EUR")
	}
}

func TestJSONRoundTrip(t *testing.T) {
	original := money.FromXAF(18_500)

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(encoded) != `{"amount":18500,"currency":"XAF"}` {
		t.Errorf("encoded as %s", encoded)
	}

	var decoded money.Money
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !decoded.Equal(original) {
		t.Errorf("round trip gave %v, want %v", decoded, original)
	}
}

func TestMarshalJSONRejectsUndefinedCurrency(t *testing.T) {
	_, err := json.Marshal(money.Money{})
	if !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("got %v, want ErrUndefinedCurrency", err)
	}
}

func TestUnmarshalJSONRejectsUnknownCurrency(t *testing.T) {
	var m money.Money
	err := json.Unmarshal([]byte(`{"amount":100,"currency":"ZZZ"}`), &m)
	if !errors.Is(err, money.ErrUnknownCurrency) {
		t.Errorf("got %v, want ErrUnknownCurrency", err)
	}
}

func TestUnmarshalJSONRejectsFloatAmount(t *testing.T) {
	// A float amount means the value was produced by something that does not
	// respect ADR-010, and must not be silently truncated.
	var m money.Money
	if err := json.Unmarshal([]byte(`{"amount":185.5,"currency":"XAF"}`), &m); err == nil {
		t.Error("accepted a fractional amount, want an error")
	}
}

// TestAllocateSumsBackToTheWhole is the property that matters: a split may
// distribute a remainder however it likes, but it may never create or lose a
// minor unit.
func TestAllocateSumsBackToTheWhole(t *testing.T) {
	generator := rand.New(rand.NewSource(1))
	for i := 0; i < 2_000; i++ {
		amount := money.FromXAF(generator.Int63n(2_000_001) - 1_000_000)

		ratios := make([]int64, 1+generator.Intn(7))
		nonZero := false
		for j := range ratios {
			ratios[j] = generator.Int63n(100)
			nonZero = nonZero || ratios[j] > 0
		}
		if !nonZero {
			ratios[0] = 1
		}

		parts, err := amount.Allocate(ratios...)
		if err != nil {
			t.Fatalf("Allocate(%d, %v): %v", amount.Amount(), ratios, err)
		}
		total, err := money.Sum(money.XAF, parts...)
		if err != nil {
			t.Fatalf("Sum: %v", err)
		}
		if !total.Equal(amount) {
			t.Fatalf("Allocate(%d, %v) parts sum to %d", amount.Amount(), ratios, total.Amount())
		}
	}
}

func TestAllocate(t *testing.T) {
	tests := []struct {
		name   string
		amount int64
		ratios []int64
		want   []int64
	}{
		{"exact halves", 1_000, []int64{1, 1}, []int64{500, 500}},
		{"remainder to the first part", 1_001, []int64{1, 1}, []int64{501, 500}},
		{"remainder spread over three", 100, []int64{1, 1, 1}, []int64{34, 33, 33}},
		{"weighted", 10_000, []int64{7, 3}, []int64{7_000, 3_000}},
		{"single part takes everything", 999, []int64{5}, []int64{999}},
		{"negative amount keeps its sign", -100, []int64{1, 1, 1}, []int64{-34, -33, -33}},
		{"zero amount", 0, []int64{1, 2}, []int64{0, 0}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			parts, err := money.FromXAF(tc.amount).Allocate(tc.ratios...)
			if err != nil {
				t.Fatalf("Allocate: %v", err)
			}
			assertAmounts(t, parts, tc.want)
		})
	}
}

// TestAllocateSkipsZeroRatioParts guards a subtle case: a party allocated
// nothing must not receive a stray unit of the remainder.
func TestAllocateSkipsZeroRatioParts(t *testing.T) {
	parts, err := money.FromXAF(100).Allocate(0, 3, 3, 3)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	assertAmounts(t, parts, []int64{0, 34, 33, 33})
}

func TestAllocateRejectsUnusableRatios(t *testing.T) {
	tests := []struct {
		name   string
		ratios []int64
	}{
		{"none given", nil},
		{"all zero", []int64{0, 0}},
		{"negative", []int64{1, -1}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := money.FromXAF(100).Allocate(tc.ratios...); !errors.Is(err, money.ErrInvalidRatios) {
				t.Errorf("got %v, want ErrInvalidRatios", err)
			}
		})
	}
}

func TestSplit(t *testing.T) {
	parts, err := money.FromXAF(1_000).Split(3)
	if err != nil {
		t.Fatalf("Split: %v", err)
	}
	assertAmounts(t, parts, []int64{334, 333, 333})

	if _, err := money.FromXAF(100).Split(0); !errors.Is(err, money.ErrInvalidRatios) {
		t.Errorf("Split(0): got %v, want ErrInvalidRatios", err)
	}
	if _, err := money.FromXAF(100).Split(-1); !errors.Is(err, money.ErrInvalidRatios) {
		t.Errorf("Split(-1): got %v, want ErrInvalidRatios", err)
	}
}

func assertAmounts(t *testing.T, parts []money.Money, want []int64) {
	t.Helper()
	if len(parts) != len(want) {
		t.Fatalf("got %d parts, want %d", len(parts), len(want))
	}
	for i, part := range parts {
		if part.Amount() != want[i] {
			got := make([]int64, len(parts))
			for j, p := range parts {
				got[j] = p.Amount()
			}
			t.Fatalf("parts = %v, want %v", got, want)
		}
	}
}
