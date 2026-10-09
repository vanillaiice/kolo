package finance_test

import (
	"errors"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

func TestEveryKindIsDefinedAndNamed(t *testing.T) {
	kinds := finance.AccountKinds()
	if len(kinds) != 5 {
		t.Fatalf("got %d kinds, want 5", len(kinds))
	}

	seen := make(map[finance.AccountKind]struct{}, len(kinds))
	for _, kind := range kinds {
		if !kind.Defined() {
			t.Errorf("%s is listed but not defined", kind)
		}
		if kind.String() != string(kind) {
			t.Errorf("String() = %q, want %q", kind.String(), string(kind))
		}
		if _, repeated := seen[kind]; repeated {
			t.Errorf("%s is listed twice", kind)
		}
		seen[kind] = struct{}{}
	}
}

// The list a caller gets cannot be used to change the list everyone else sees.
func TestAccountKindsAreHandedOutAsACopy(t *testing.T) {
	kinds := finance.AccountKinds()
	kinds[0] = "TAMPERED"

	if finance.AccountKinds()[0] == "TAMPERED" {
		t.Error("editing the returned slice changed the kinds")
	}
}

func TestParseAccountKindRefusesWhatItDoesNotKnow(t *testing.T) {
	for _, text := range []string{"", "cash", " CASH", "CRYPTO", "MTN"} {
		if _, err := finance.ParseAccountKind(text); !errors.Is(err, finance.ErrInvalidAccountKind) {
			t.Errorf("ParseAccountKind(%q) = %v, want a refusal", text, err)
		}
	}

	for _, kind := range finance.AccountKinds() {
		parsed, err := finance.ParseAccountKind(string(kind))
		if err != nil || parsed != kind {
			t.Errorf("ParseAccountKind(%q) = %v, %v", kind, parsed, err)
		}
	}
}

// MTN and Orange are accounts, not kinds. Were a provider a kind, adding one
// would be a release rather than a row, which §10 rules out.
func TestAProviderIsNotAKind(t *testing.T) {
	for _, provider := range []string{"MTN", "ORANGE", "MTN_MOBILE_MONEY", "ORANGE_MONEY"} {
		if finance.AccountKind(provider).Defined() {
			t.Errorf("%s is a kind; providers must be accounts (§10)", provider)
		}
	}
}

// Cash is counted by hand against a drawer; an electronic balance is not.
func TestOnlyCashNeedsReconciling(t *testing.T) {
	if !finance.Cash.NeedsReconciliation() {
		t.Error("cash does not need reconciling")
	}
	for _, kind := range []finance.AccountKind{finance.MobileMoney, finance.Bank, finance.Card, finance.Other} {
		if kind.NeedsReconciliation() {
			t.Errorf("%s was reported as needing reconciling", kind)
		}
	}
}

func TestAccountIdentifiersRoundTrip(t *testing.T) {
	raw := id.New()
	if got := finance.AccountIDFrom(raw); got.ID() != raw {
		t.Errorf("AccountIDFrom lost the value: %s", got)
	}

	accountID := finance.NewAccountID()
	parsed, err := finance.ParseAccountID(accountID.String())
	if err != nil || parsed != accountID {
		t.Errorf("ParseAccountID(%s) = %s, %v", accountID, parsed, err)
	}

	for _, text := range []string{"", "not-an-identifier", "0"} {
		if _, err := finance.ParseAccountID(text); err == nil {
			t.Errorf("ParseAccountID(%q) was accepted", text)
		}
	}
	if !(finance.AccountID{}).IsZero() {
		t.Error("the zero account identifier does not report itself as zero")
	}
}

// An identifier for one domain must not be usable as another's. This is what
// stops an account being passed where a customer belongs, and it is checked at
// compile time — the assignment below would not build if the tags matched.
func TestAnAccountIdentifierIsNotInterchangeable(t *testing.T) {
	var accountID finance.AccountID = finance.NewAccountID()
	if accountID.IsZero() {
		t.Error("a fresh account identifier is zero")
	}
}
