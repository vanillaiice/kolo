package money_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// The zero Money is what a struct field looks like before anything assigns to
// it. Every operation must reject it, so a value that was never given a
// currency cannot drift through a calculation and come out looking like a real
// amount. These tests cover that surface exhaustively rather than by sampling.

func TestEveryOperationRejectsTheZeroMoney(t *testing.T) {
	var undefined money.Money
	valid := money.FromXAF(100)

	tests := []struct {
		name string
		call func() error
	}{
		{"Add to a valid amount", func() error { _, err := undefined.Add(valid); return err }},
		{"Add a zero Money", func() error { _, err := valid.Add(undefined); return err }},
		{"Sub from a valid amount", func() error { _, err := undefined.Sub(valid); return err }},
		{"Sub a zero Money", func() error { _, err := valid.Sub(undefined); return err }},
		{"Neg", func() error { _, err := undefined.Neg(); return err }},
		{"Abs", func() error { _, err := undefined.Abs(); return err }},
		{"Mul", func() error { _, err := undefined.Mul(2); return err }},
		{"MulRatio", func() error { _, err := undefined.MulRatio(1, 2, money.RoundHalfUp); return err }},
		{"Allocate", func() error { _, err := undefined.Allocate(1, 1); return err }},
		{"Split", func() error { _, err := undefined.Split(2); return err }},
		{"Cmp against a valid amount", func() error { _, err := undefined.Cmp(valid); return err }},
		{"Cmp a zero Money", func() error { _, err := valid.Cmp(undefined); return err }},
		{"two zero Money values", func() error { _, err := undefined.Add(undefined); return err }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.call(); !errors.Is(err, money.ErrUndefinedCurrency) {
				t.Errorf("got %v, want ErrUndefinedCurrency", err)
			}
		})
	}
}

// TestAbsRejectsTheZeroMoneyOnBothBranches covers the sign split inside Abs: a
// zero amount takes the non-negative path, so that path needs its own check.
func TestAbsRejectsTheZeroMoneyOnBothBranches(t *testing.T) {
	var undefined money.Money

	// Amount zero, undefined currency: the non-negative branch.
	if _, err := undefined.Abs(); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("Abs of a zero-amount undefined value: got %v, want ErrUndefinedCurrency", err)
	}

	// A valid amount must still pass through untouched.
	positive, err := money.FromXAF(100).Abs()
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	if positive.Amount() != 100 {
		t.Errorf("Abs(100) = %d, want 100", positive.Amount())
	}

	negative, err := money.FromXAF(-100).Abs()
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	if negative.Amount() != 100 {
		t.Errorf("Abs(-100) = %d, want 100", negative.Amount())
	}
}

func TestSumRejectsAnUndefinedTargetCurrency(t *testing.T) {
	if _, err := money.Sum(money.Currency{}); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("Sum into an undefined currency: got %v, want ErrUndefinedCurrency", err)
	}
	if _, err := money.Sum(money.Currency{}, money.FromXAF(100)); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("Sum of a valid amount into an undefined currency: got %v, want ErrUndefinedCurrency", err)
	}
}

func TestSumRejectsAZeroMoneyAmongItsInputs(t *testing.T) {
	var undefined money.Money

	if _, err := money.Sum(money.XAF, money.FromXAF(100), undefined); !errors.Is(err, money.ErrUndefinedCurrency) {
		t.Errorf("got %v, want ErrUndefinedCurrency", err)
	}
}

// TestSumReportsWhichAmountFailed matters for diagnosing a bad payload: the
// error has to say where in the list the problem is.
func TestSumReportsWhichAmountFailed(t *testing.T) {
	_, err := money.Sum(money.XAF, money.FromXAF(1), money.FromXAF(2), money.MustNew(3, money.EUR))
	if err == nil {
		t.Fatal("Sum succeeded, want an error")
	}
	if got := err.Error(); !strings.Contains(got, "amount 2") {
		t.Errorf("error %q does not identify the offending amount", got)
	}
}

func TestMustNewPanicsOnAnUndefinedCurrency(t *testing.T) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("MustNew did not panic")
		}
		err, ok := recovered.(error)
		if !ok || !errors.Is(err, money.ErrUndefinedCurrency) {
			t.Errorf("panicked with %v, want ErrUndefinedCurrency", recovered)
		}
	}()

	money.MustNew(100, money.Currency{})
}

func TestMustNewAcceptsAKnownCurrency(t *testing.T) {
	if got := money.MustNew(100, money.XAF).Amount(); got != 100 {
		t.Errorf("MustNew = %d, want 100", got)
	}
}

// TestZeroMoneyIsInertButInspectable checks the accessors stay safe on an
// invalid value, so error reporting never panics on the way to the message.
func TestZeroMoneyIsInertButInspectable(t *testing.T) {
	var undefined money.Money

	if undefined.Valid() {
		t.Error("Valid() = true")
	}
	if !undefined.IsZero() {
		t.Error("IsZero() = false")
	}
	if undefined.IsPositive() || undefined.IsNegative() {
		t.Error("an undefined value reported a sign")
	}
	if got := undefined.Amount(); got != 0 {
		t.Errorf("Amount() = %d, want 0", got)
	}
	if got := undefined.Currency().Defined(); got {
		t.Error("Currency().Defined() = true")
	}
	if got := undefined.String(); got != "invalid money" {
		t.Errorf("String() = %q", got)
	}
	if !undefined.Equal(money.Money{}) {
		t.Error("two zero Money values reported unequal")
	}
	if undefined.Equal(money.FromXAF(0)) {
		t.Error("a zero Money compared equal to a real zero amount")
	}
}
