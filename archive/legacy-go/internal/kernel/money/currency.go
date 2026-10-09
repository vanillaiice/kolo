package money

import (
	"fmt"
	"strings"
)

// Currency identifies a currency and how many minor units make up one major
// unit, expressed as a power of ten.
//
// The zero Currency is undefined and is rejected by every operation, so an
// amount can never silently acquire a currency it was not given.
type Currency struct {
	code     string
	exponent uint8
}

// Code returns the ISO 4217 alphabetic code, or the empty string if c is
// undefined.
func (c Currency) Code() string { return c.code }

// Exponent returns the power of ten separating minor units from the major unit.
// XAF has exponent 0: one minor unit is one whole franc.
func (c Currency) Exponent() uint8 { return c.exponent }

// Defined reports whether c is a real currency rather than the zero value.
func (c Currency) Defined() bool { return c.code != "" }

// Zero returns nothing, in this currency.
//
// The total form of New(0, c), for callers that already hold a currency and
// would otherwise have to handle an error that cannot happen. It fails closed:
// an undefined currency yields the invalid zero Money, which every operation
// refuses, rather than a valid-looking amount in no currency.
func (c Currency) Zero() Money {
	if !c.Defined() {
		return Money{}
	}
	return Money{currency: c}
}

// String implements fmt.Stringer.
func (c Currency) String() string {
	if !c.Defined() {
		return "undefined"
	}
	return c.code
}

var (
	// XAF is the Central African CFA franc, the platform's primary currency
	// (SPECIFICATION.md §44). It has no minor unit in circulation, so amounts
	// are whole francs.
	XAF = Currency{code: "XAF", exponent: 0}

	// EUR is the euro, to which XAF is pegged at a fixed rate. It is registered
	// so that the exponent handling is exercised by a currency that actually
	// has minor units; the product itself operates in XAF.
	EUR = Currency{code: "EUR", exponent: 2}
)

// registry maps ISO 4217 codes to the currencies this system understands.
// Adding a currency here is the only supported way to introduce one, so an
// amount read from storage or the network can never carry an unknown exponent.
var registry = map[string]Currency{
	XAF.code: XAF,
	EUR.code: EUR,
}

// ByCode looks up a currency by its ISO 4217 alphabetic code, case
// insensitively. It reports an error for codes the system does not know, rather
// than inventing a currency with a guessed exponent.
func ByCode(code string) (Currency, error) {
	c, ok := registry[strings.ToUpper(strings.TrimSpace(code))]
	if !ok {
		return Currency{}, fmt.Errorf("%w: %q", ErrUnknownCurrency, code)
	}
	return c, nil
}
