package quantity_test

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// TestTenthsSumExactly is the reason quantities are integers underneath. With
// floating point this fails, and a ledger whose entries do not sum back to what
// was counted is worse than no ledger.
func TestTenthsSumExactly(t *testing.T) {
	total := quantity.Zero
	for range 10 {
		var err error
		if total, err = total.Add(quantity.MustParse("0.1")); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if want := quantity.MustParse("1"); !total.Equal(want) {
		t.Errorf("ten tenths = %s, want exactly %s", total, want)
	}

	// And a third three times, which is where the scale's limit shows honestly.
	thirds := quantity.Zero
	for range 3 {
		var err error
		if thirds, err = thirds.Add(quantity.MustParse("0.333")); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if want := quantity.MustParse("0.999"); !thirds.Equal(want) {
		t.Errorf("three thirds = %s, want %s", thirds, want)
	}
}

func TestParse(t *testing.T) {
	tests := []struct {
		input string
		want  int64 // thousandths
	}{
		{"0", 0},
		{"1", 1_000},
		{"100", 100_000},
		{"0.5", 500},
		{".5", 500},
		{"0.001", 1},
		{"1.5", 1_500},
		{"2.25", 2_250},
		{"12.345", 12_345},
		{"-1", -1_000},
		{"-0.5", -500},
		{"+3", 3_000},
		{"  7  ", 7_000},
		{"1.500", 1_500},
		{"0.10", 100},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			parsed, err := quantity.Parse(tc.input)
			if err != nil {
				t.Fatalf("Parse(%q): %v", tc.input, err)
			}
			if got := parsed.Thousandths(); got != tc.want {
				t.Errorf("Parse(%q) = %d thousandths, want %d", tc.input, got, tc.want)
			}
		})
	}
}

// TestParseRefusesExtraPrecision matters because someone typing a fourth
// decimal means something by it, and silently rounding would make the ledger
// disagree with what they entered.
func TestParseRefusesExtraPrecision(t *testing.T) {
	for _, input := range []string{"0.0001", "1.2345", "0.5001"} {
		if _, err := quantity.Parse(input); !errors.Is(err, quantity.ErrInvalidFormat) {
			t.Errorf("Parse(%q): got %v, want ErrInvalidFormat", input, err)
		}
	}
}

func TestParseRefusesMalformedInput(t *testing.T) {
	tests := []string{
		"", "   ", "abc", "1.2.3", "--1", "1-", "1,5", "1 000",
		"+", "-", ".", "1e3", "0x10", "١٢٣", "NaN", "Infinity",
	}
	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			parsed, err := quantity.Parse(input)
			if err == nil {
				t.Errorf("Parse(%q) succeeded, giving %s", input, parsed)
			}
			if !parsed.IsZero() {
				t.Errorf("Parse(%q) returned %s alongside an error", input, parsed)
			}
		})
	}
}

func TestString(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"0", "0"},
		{"1", "1"},
		{"100", "100"},
		{"0.5", "0.5"},
		{"1.5", "1.5"},
		{"2.25", "2.25"},
		{"12.345", "12.345"},
		{"-1", "-1"},
		{"-0.5", "-0.5"},
		{"1.500", "1.5"},
		{"0.001", "0.001"},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			if got := quantity.MustParse(tc.input).String(); got != tc.want {
				t.Errorf("String() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseAndStringRoundTrip(t *testing.T) {
	for _, input := range []string{"0", "1", "0.5", "-0.5", "12.345", "-12.345", "1000000"} {
		parsed := quantity.MustParse(input)
		again, err := quantity.Parse(parsed.String())
		if err != nil {
			t.Fatalf("Parse(%q): %v", parsed.String(), err)
		}
		if !again.Equal(parsed) {
			t.Errorf("round trip of %q gave %s", input, again)
		}
	}
}

func TestArithmetic(t *testing.T) {
	ten := quantity.MustParse("10")
	half := quantity.MustParse("0.5")

	sum, err := ten.Add(half)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if want := quantity.MustParse("10.5"); !sum.Equal(want) {
		t.Errorf("Add = %s, want %s", sum, want)
	}

	difference, err := ten.Sub(half)
	if err != nil {
		t.Fatalf("Sub: %v", err)
	}
	if want := quantity.MustParse("9.5"); !difference.Equal(want) {
		t.Errorf("Sub = %s, want %s", difference, want)
	}

	negated, err := ten.Neg()
	if err != nil {
		t.Fatalf("Neg: %v", err)
	}
	if want := quantity.MustParse("-10"); !negated.Equal(want) {
		t.Errorf("Neg = %s, want %s", negated, want)
	}

	magnitude, err := negated.Abs()
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	if !magnitude.Equal(ten) {
		t.Errorf("Abs = %s, want %s", magnitude, ten)
	}
	if positive, err := ten.Abs(); err != nil || !positive.Equal(ten) {
		t.Errorf("Abs of a positive = %s, %v", positive, err)
	}

	product, err := half.Mul(4)
	if err != nil {
		t.Fatalf("Mul: %v", err)
	}
	if want := quantity.MustParse("2"); !product.Equal(want) {
		t.Errorf("Mul = %s, want %s", product, want)
	}
}

func TestOverflowIsReportedNotWrapped(t *testing.T) {
	most := quantity.FromThousandths(math.MaxInt64)
	least := quantity.FromThousandths(math.MinInt64)
	one := quantity.FromThousandths(1)

	tests := []struct {
		name string
		call func() (quantity.Quantity, error)
	}{
		{"add past the top", func() (quantity.Quantity, error) { return most.Add(one) }},
		{"subtract past the bottom", func() (quantity.Quantity, error) { return least.Sub(one) }},
		{"negate the most negative", func() (quantity.Quantity, error) { return least.Neg() }},
		{"abs the most negative", func() (quantity.Quantity, error) { return least.Abs() }},
		{"multiply past the top", func() (quantity.Quantity, error) { return most.Mul(2) }},
		{"most negative times minus one", func() (quantity.Quantity, error) { return least.Mul(-1) }},
		{"units past the top", func() (quantity.Quantity, error) { return quantity.FromUnits(math.MaxInt64) }},
		{"units past the bottom", func() (quantity.Quantity, error) { return quantity.FromUnits(math.MinInt64) }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.call(); !errors.Is(err, quantity.ErrOverflow) {
				t.Errorf("got %v, want ErrOverflow", err)
			}
		})
	}

	if _, err := quantity.Parse(strings.Repeat("9", 25)); !errors.Is(err, quantity.ErrOverflow) {
		t.Errorf("parsing an enormous number: got %v, want ErrOverflow", err)
	}
}

func TestSigns(t *testing.T) {
	tests := []struct {
		input                    string
		zero, positive, negative bool
		whole                    bool
	}{
		{"0", true, false, false, true},
		{"1", false, true, false, true},
		{"-1", false, false, true, true},
		{"0.5", false, true, false, false},
		{"-0.5", false, false, true, false},
		{"100", false, true, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			q := quantity.MustParse(tc.input)
			if q.IsZero() != tc.zero || q.IsPositive() != tc.positive || q.IsNegative() != tc.negative {
				t.Errorf("%s: zero=%v positive=%v negative=%v", tc.input,
					q.IsZero(), q.IsPositive(), q.IsNegative())
			}
			if q.IsWhole() != tc.whole {
				t.Errorf("%s: IsWhole() = %v, want %v", tc.input, q.IsWhole(), tc.whole)
			}
		})
	}
}

func TestCmp(t *testing.T) {
	small, large := quantity.MustParse("1"), quantity.MustParse("2")

	if got := small.Cmp(large); got != -1 {
		t.Errorf("Cmp(1, 2) = %d, want -1", got)
	}
	if got := large.Cmp(small); got != 1 {
		t.Errorf("Cmp(2, 1) = %d, want 1", got)
	}
	if got := small.Cmp(quantity.MustParse("1")); got != 0 {
		t.Errorf("Cmp(1, 1) = %d, want 0", got)
	}
	if !small.Equal(quantity.MustParse("1.000")) {
		t.Error("1 and 1.000 compared unequal")
	}
}

func TestSum(t *testing.T) {
	total, err := quantity.Sum(
		quantity.MustParse("100"),
		quantity.MustParse("-3"),
		quantity.MustParse("1"),
		quantity.MustParse("-2"),
		quantity.MustParse("5"),
	)
	if err != nil {
		t.Fatalf("Sum: %v", err)
	}
	if want := quantity.MustParse("101"); !total.Equal(want) {
		t.Errorf("Sum = %s, want %s", total, want)
	}

	empty, err := quantity.Sum()
	if err != nil {
		t.Fatalf("Sum of nothing: %v", err)
	}
	if !empty.IsZero() {
		t.Errorf("Sum of nothing = %s, want zero", empty)
	}

	if _, err := quantity.Sum(quantity.FromThousandths(math.MaxInt64), quantity.FromThousandths(1)); !errors.Is(err, quantity.ErrOverflow) {
		t.Errorf("got %v, want ErrOverflow", err)
	}
}

func TestFromUnitsAndThousandths(t *testing.T) {
	fromUnits, err := quantity.FromUnits(7)
	if err != nil {
		t.Fatalf("FromUnits: %v", err)
	}
	if got := fromUnits.Thousandths(); got != 7_000 {
		t.Errorf("Thousandths() = %d, want 7000", got)
	}
	if !quantity.MustFromUnits(7).Equal(fromUnits) {
		t.Error("MustFromUnits disagreed with FromUnits")
	}
	if got := quantity.FromThousandths(1_500); !got.Equal(quantity.MustParse("1.5")) {
		t.Errorf("FromThousandths(1500) = %s, want 1.5", got)
	}
	if !quantity.Zero.IsZero() {
		t.Error("Zero is not zero")
	}
}

func TestMustPanicsOnBadInput(t *testing.T) {
	for name, call := range map[string]func(){
		"MustParse":     func() { quantity.MustParse("nonsense") },
		"MustFromUnits": func() { quantity.MustFromUnits(math.MaxInt64) },
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Errorf("%s did not panic", name)
				}
			}()
			call()
		})
	}
}

// FuzzParse checks that parsing never panics and that anything it accepts
// round-trips through its own rendering.
func FuzzParse(f *testing.F) {
	for _, seed := range []string{"0", "1", "0.5", "-12.345", "", "abc", "1.2345", "999999999999999999999"} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, input string) {
		parsed, err := quantity.Parse(input)
		if err != nil {
			if !parsed.IsZero() {
				t.Fatalf("Parse(%q) returned %s alongside an error", input, parsed)
			}
			return
		}

		rendered := parsed.String()
		again, err := quantity.Parse(rendered)
		if err != nil {
			t.Fatalf("Parse rejected its own rendering %q of %q: %v", rendered, input, err)
		}
		if !again.Equal(parsed) {
			t.Fatalf("round trip of %q gave %s via %q", input, again, rendered)
		}
	})
}

// FuzzArithmeticNeverWraps checks that no pair of quantities produces a result
// that silently wrapped, which is the failure integers are chosen to avoid.
func FuzzArithmeticNeverWraps(f *testing.F) {
	f.Add(int64(1_000), int64(500))
	f.Add(int64(math.MaxInt64), int64(1))
	f.Add(int64(math.MinInt64), int64(-1))

	f.Fuzz(func(t *testing.T, left, right int64) {
		a, b := quantity.FromThousandths(left), quantity.FromThousandths(right)

		if sum, err := a.Add(b); err == nil {
			// The result must be reachable by going back the other way.
			back, err := sum.Sub(b)
			if err == nil && !back.Equal(a) {
				t.Fatalf("(%d + %d) - %d gave %s, want %s", left, right, right, back, a)
			}
		}
		if difference, err := a.Sub(b); err == nil {
			back, err := difference.Add(b)
			if err == nil && !back.Equal(a) {
				t.Fatalf("(%d - %d) + %d gave %s, want %s", left, right, right, back, a)
			}
		}
	})
}

// TestParseRejectsANonNumericFraction covers the decimal half separately from
// the whole half, since each is parsed on its own.
func TestParseRejectsANonNumericFraction(t *testing.T) {
	for _, input := range []string{"1.abc", "1.-5", "1.+5", "1. 5"} {
		if _, err := quantity.Parse(input); !errors.Is(err, quantity.ErrInvalidFormat) {
			t.Errorf("Parse(%q): got %v, want ErrInvalidFormat", input, err)
		}
	}
}

// TestParseRejectsANonNumericWholePart is the same for the other half.
func TestParseRejectsANonNumericWholePart(t *testing.T) {
	for _, input := range []string{"abc.5", "-.5-", "1-2"} {
		if _, err := quantity.Parse(input); err == nil {
			t.Errorf("Parse(%q) succeeded", input)
		}
	}
}
