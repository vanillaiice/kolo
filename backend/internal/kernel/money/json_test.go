package money_test

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

func TestMarshalJSON(t *testing.T) {
	tests := []struct {
		name string
		m    money.Money
		want string
	}{
		{"whole francs", money.FromXAF(18_500), `{"amount":18500,"currency":"XAF"}`},
		{"zero", money.FromXAF(0), `{"amount":0,"currency":"XAF"}`},
		{"negative", money.FromXAF(-25_000), `{"amount":-25000,"currency":"XAF"}`},
		{"largest", money.FromXAF(math.MaxInt64), `{"amount":9223372036854775807,"currency":"XAF"}`},
		{"most negative", money.FromXAF(math.MinInt64), `{"amount":-9223372036854775808,"currency":"XAF"}`},
		{"minor units", money.MustNew(18_550, money.EUR), `{"amount":18550,"currency":"EUR"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := json.Marshal(tc.m)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if string(encoded) != tc.want {
				t.Errorf("Marshal = %s, want %s", encoded, tc.want)
			}
		})
	}
}

// TestMarshalJSONEmitsAnIntegerNotAFloat guards ADR-010 at the wire boundary:
// an amount serialised as a float would be re-read by a JavaScript client as an
// inexact double.
func TestMarshalJSONEmitsAnIntegerNotAFloat(t *testing.T) {
	amounts := []int64{18_500, 0, -25_000, math.MaxInt64, math.MinInt64}
	for _, amount := range amounts {
		encoded, err := json.Marshal(money.FromXAF(amount))
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}

		// Inspect the amount token itself; the surrounding object contains
		// letters that a naive scan of the whole document would trip over.
		var fields struct {
			Amount json.RawMessage `json:"amount"`
		}
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatalf("re-reading %s: %v", encoded, err)
		}

		token := string(fields.Amount)
		if strings.ContainsAny(token, ".eE") {
			t.Errorf("amount encoded as %s, want a plain integer", token)
		}
		if want := strconv.FormatInt(amount, 10); token != want {
			t.Errorf("amount encoded as %s, want %s", token, want)
		}
	}
}

func TestUnmarshalJSON(t *testing.T) {
	tests := []struct {
		name         string
		input        string
		wantAmount   int64
		wantCurrency money.Currency
	}{
		{"canonical", `{"amount":18500,"currency":"XAF"}`, 18_500, money.XAF},
		{"negative amount", `{"amount":-25000,"currency":"XAF"}`, -25_000, money.XAF},
		{"largest amount", `{"amount":9223372036854775807,"currency":"XAF"}`, math.MaxInt64, money.XAF},
		{"most negative amount", `{"amount":-9223372036854775808,"currency":"XAF"}`, math.MinInt64, money.XAF},
		{"lower-case currency", `{"amount":100,"currency":"xaf"}`, 100, money.XAF},
		{"padded currency", `{"amount":100,"currency":"  XAF "}`, 100, money.XAF},
		{"unknown fields ignored", `{"amount":100,"currency":"XAF","note":"ignored"}`, 100, money.XAF},
		{"field order swapped", `{"currency":"XAF","amount":100}`, 100, money.XAF},
		{"missing amount defaults to zero", `{"currency":"XAF"}`, 0, money.XAF},
		{"minor units", `{"amount":18550,"currency":"EUR"}`, 18_550, money.EUR},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var decoded money.Money
			if err := json.Unmarshal([]byte(tc.input), &decoded); err != nil {
				t.Fatalf("Unmarshal(%s): %v", tc.input, err)
			}
			if decoded.Amount() != tc.wantAmount {
				t.Errorf("amount = %d, want %d", decoded.Amount(), tc.wantAmount)
			}
			if decoded.Currency() != tc.wantCurrency {
				t.Errorf("currency = %s, want %s", decoded.Currency(), tc.wantCurrency)
			}
		})
	}
}

func TestUnmarshalJSONRejectsMalformedInput(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"empty object", `{}`},
		{"null currency", `{"amount":100,"currency":null}`},
		{"empty currency", `{"amount":100,"currency":""}`},
		{"unknown currency", `{"amount":100,"currency":"ZZZ"}`},
		{"numeric currency", `{"amount":100,"currency":840}`},
		{"fractional amount", `{"amount":185.5,"currency":"XAF"}`},
		{"amount in exponent form", `{"amount":1.85e2,"currency":"XAF"}`},
		{"amount as a string", `{"amount":"100","currency":"XAF"}`},
		{"amount past int64", `{"amount":9223372036854775808,"currency":"XAF"}`},
		{"amount below int64", `{"amount":-9223372036854775809,"currency":"XAF"}`},
		{"bare number", `100`},
		{"bare string", `"100 XAF"`},
		{"array", `[100,"XAF"]`},
		{"truncated", `{"amount":100,`},
		{"not json", `nonsense`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var decoded money.Money
			if err := json.Unmarshal([]byte(tc.input), &decoded); err == nil {
				t.Errorf("Unmarshal(%s) succeeded, giving %v, want an error", tc.input, decoded)
			}
		})
	}
}

// TestUnmarshalJSONAcceptsNullAsAbsent matches encoding/json's convention: a
// null literal leaves the destination untouched rather than erroring.
func TestUnmarshalJSONAcceptsNullAsAbsent(t *testing.T) {
	decoded := money.FromXAF(500)
	if err := json.Unmarshal([]byte(`null`), &decoded); err != nil {
		t.Fatalf("Unmarshal(null): %v", err)
	}
	if !decoded.Equal(money.FromXAF(500)) {
		t.Errorf("null overwrote the value with %v", decoded)
	}
}

func TestUnmarshalJSONReportsTheUnderlyingError(t *testing.T) {
	var decoded money.Money

	err := json.Unmarshal([]byte(`{"amount":100,"currency":"ZZZ"}`), &decoded)
	if !errors.Is(err, money.ErrUnknownCurrency) {
		t.Errorf("got %v, want ErrUnknownCurrency", err)
	}
}

// TestJSONRoundTripInsideAStruct is how amounts actually travel: as a field of
// a sync event payload, not on their own.
func TestJSONRoundTripInsideAStruct(t *testing.T) {
	type salePayload struct {
		Total    money.Money `json:"total"`
		Discount money.Money `json:"discount"`
	}
	original := salePayload{
		Total:    money.FromXAF(18_500),
		Discount: money.FromXAF(-2_775),
	}

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded salePayload
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded != original {
		t.Errorf("round trip gave %+v, want %+v", decoded, original)
	}
}

// TestMarshalJSONRefusesAPartiallyConstructedValue keeps an amount with no
// currency from reaching storage or the wire, where its meaning would be lost.
func TestMarshalJSONRefusesAPartiallyConstructedValue(t *testing.T) {
	type payload struct {
		Total money.Money `json:"total"`
	}

	if _, err := json.Marshal(payload{}); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("got %v, want ErrUndefinedCurrency", err)
	}
}

// FuzzUnmarshalJSON checks that decoding never panics and that anything it
// accepts re-encodes to something that decodes back to the same value.
func FuzzUnmarshalJSON(f *testing.F) {
	f.Add(`{"amount":18500,"currency":"XAF"}`)
	f.Add(`{"amount":-1,"currency":"eur"}`)
	f.Add(`{"amount":0,"currency":""}`)
	f.Add(`{}`)
	f.Add(`null`)
	f.Add(`[]`)
	f.Add(`{"amount":9223372036854775808,"currency":"XAF"}`)

	f.Fuzz(func(t *testing.T, input string) {
		var decoded money.Money
		if err := json.Unmarshal([]byte(input), &decoded); err != nil {
			return
		}
		if !decoded.Valid() {
			// The only way to decode without error and stay invalid is a null
			// literal, which leaves the zero value in place.
			if strings.TrimSpace(input) != "null" {
				t.Fatalf("Unmarshal(%q) succeeded but left an invalid value", input)
			}
			return
		}

		encoded, err := json.Marshal(decoded)
		if err != nil {
			t.Fatalf("re-encoding %v decoded from %q: %v", decoded, input, err)
		}
		var reDecoded money.Money
		if err := json.Unmarshal(encoded, &reDecoded); err != nil {
			t.Fatalf("re-decoding %s: %v", encoded, err)
		}
		if !reDecoded.Equal(decoded) {
			t.Fatalf("round trip of %q gave %v, want %v", input, reDecoded, decoded)
		}
	})
}
