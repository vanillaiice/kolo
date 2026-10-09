package money_test

import (
	"errors"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

func TestByCode(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  money.Currency
	}{
		{"primary currency", "XAF", money.XAF},
		{"lower case", "xaf", money.XAF},
		{"surrounding space", "  XAF  ", money.XAF},
		{"euro", "EUR", money.EUR},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := money.ByCode(tc.input)
			if err != nil {
				t.Fatalf("ByCode(%q): %v", tc.input, err)
			}
			if got != tc.want {
				t.Errorf("ByCode(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestByCodeRejectsUnknown(t *testing.T) {
	for _, code := range []string{"", "ZZZ", "XA"} {
		if _, err := money.ByCode(code); !errors.Is(err, money.ErrUnknownCurrency) {
			t.Errorf("ByCode(%q): got %v, want ErrUnknownCurrency", code, err)
		}
	}
}

func TestCurrencyAccessors(t *testing.T) {
	if got := money.XAF.Code(); got != "XAF" {
		t.Errorf("XAF.Code() = %q, want %q", got, "XAF")
	}
	if got := money.EUR.Exponent(); got != 2 {
		t.Errorf("EUR.Exponent() = %d, want 2", got)
	}
	if !money.XAF.Defined() {
		t.Error("XAF reported undefined")
	}
}

func TestZeroCurrencyIsUndefined(t *testing.T) {
	var c money.Currency
	if c.Defined() {
		t.Error("zero Currency reported defined")
	}
	if got := c.Code(); got != "" {
		t.Errorf("zero Currency Code() = %q, want empty", got)
	}
	if got := c.String(); got != "undefined" {
		t.Errorf("zero Currency String() = %q, want %q", got, "undefined")
	}
}

// Zero is the total form of New(0, c): the caller already holds a currency, so
// there is no error to handle.
func TestZeroIsNothingInACurrency(t *testing.T) {
	nothing := money.XAF.Zero()

	if !nothing.Valid() || !nothing.IsZero() {
		t.Errorf("XAF.Zero() = %s, want nothing in francs", nothing)
	}
	if nothing.Currency() != money.XAF {
		t.Errorf("Currency = %s, want XAF", nothing.Currency())
	}

	// It fails closed: an undefined currency gives the invalid zero Money,
	// which every operation refuses, rather than an amount in no currency.
	var undefined money.Currency
	if undefined.Zero().Valid() {
		t.Error("an undefined currency produced a valid amount")
	}
	if _, err := undefined.Zero().Add(money.FromXAF(1)); err == nil {
		t.Error("an amount in no currency was added to francs")
	}
}
