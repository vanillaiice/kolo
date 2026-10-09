package finance_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

var (
	openedAt  = time.Date(2026, 8, 1, 8, 0, 0, 0, time.UTC)
	editedAt  = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	tenant    = business.NewID()
	somewhere = business.NewBranchID()
)

func anAccount(t *testing.T, mutate ...func(*finance.AccountSnapshot)) *finance.Account {
	t.Helper()

	snapshot := finance.AccountSnapshot{
		ID:         finance.NewAccountID(),
		BusinessID: tenant,
		Name:       "Caisse",
		Kind:       finance.Cash,
		Currency:   money.XAF,
		CreatedAt:  openedAt,
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	account, err := finance.NewAccount(snapshot)
	if err != nil {
		t.Fatalf("finance.NewAccount: %v", err)
	}
	return account
}

// A till needs a name, a kind, and a currency. Everything else is what a
// business fills in as it grows.
func TestAnAccountNeedsAName(t *testing.T) {
	account := anAccount(t)

	if account.Name() != "Caisse" {
		t.Errorf("Name = %q", account.Name())
	}
	if account.Kind() != finance.Cash {
		t.Errorf("Kind = %s", account.Kind())
	}
	if account.Currency() != money.XAF {
		t.Errorf("Currency = %s", account.Currency())
	}
	if account.Number() != "" || account.Notes() != "" {
		t.Errorf("number %q and notes %q, want both empty", account.Number(), account.Notes())
	}
	if !account.Active() {
		t.Error("a new account is not active")
	}
	if account.BusinessID() != tenant {
		t.Errorf("BusinessID = %s, want %s", account.BusinessID(), tenant)
	}
	if !account.CreatedAt().Equal(openedAt) || !account.UpdatedAt().Equal(openedAt) {
		t.Errorf("opened at %s and updated at %s, want both %s",
			account.CreatedAt(), account.UpdatedAt(), openedAt)
	}
	if account.BranchID() != (business.BranchID{}) {
		t.Errorf("BranchID = %s, want none: an account may belong to the whole business",
			account.BranchID())
	}
}

// The point of §10: which provider a wallet belongs to is its name, not a kind
// this build has to know. Adding Orange Money is a row, not a release.
func TestTwoWalletsDifferOnlyByName(t *testing.T) {
	mtn := anAccount(t, func(s *finance.AccountSnapshot) {
		s.Name = "MTN Mobile Money"
		s.Kind = finance.MobileMoney
		s.Number = "+237699123456"
	})
	orange := anAccount(t, func(s *finance.AccountSnapshot) {
		s.Name = "Orange Money"
		s.Kind = finance.MobileMoney
		s.Number = "+237699000000"
	})

	if mtn.Kind() != orange.Kind() {
		t.Errorf("two wallets have different kinds: %s and %s", mtn.Kind(), orange.Kind())
	}
	if mtn.ID() == orange.ID() {
		t.Error("two accounts share an identifier")
	}
	if mtn.Number() == orange.Number() {
		t.Error("two wallets share a number")
	}
}

// Cash is counted by hand against what the system says; an electronic balance
// cannot be miscounted, only disagreed with (§18).
func TestOnlyCashIsReconciled(t *testing.T) {
	till := anAccount(t)
	if !till.NeedsReconciliation() {
		t.Error("a cash account is not reconciled")
	}

	wallet := anAccount(t, func(s *finance.AccountSnapshot) { s.Kind = finance.MobileMoney })
	if wallet.NeedsReconciliation() {
		t.Error("a wallet is reconciled against a drawer it does not have")
	}
}

func TestEverythingAnAccountCarriesRoundTrips(t *testing.T) {
	account := anAccount(t, func(s *finance.AccountSnapshot) {
		s.BranchID = somewhere
		s.Name = "MTN Mobile Money"
		s.Kind = finance.MobileMoney
		s.Number = "+237699123456"
		s.Notes = "compte du patron"
		s.UpdatedByDevice = devices.NewID()
	})

	restored, err := finance.RestoreAccount(account.Snapshot())
	if err != nil {
		t.Fatalf("RestoreAccount: %v", err)
	}
	if restored.Snapshot() != account.Snapshot() {
		t.Errorf("restored %+v, want %+v", restored.Snapshot(), account.Snapshot())
	}
	if restored.Scope() != account.Scope() {
		t.Errorf("Scope = %v, want %v", restored.Scope(), account.Scope())
	}
}

// An account is state, like a product and a customer, so an edit has to be
// orderable against another device's (ADR-015).
func TestAnAccountRemembersWhoseEditIsInForce(t *testing.T) {
	till := devices.NewID()
	account := anAccount(t, func(s *finance.AccountSnapshot) { s.UpdatedByDevice = till })

	if account.UpdatedByDevice() != till {
		t.Errorf("UpdatedByDevice = %s, want %s", account.UpdatedByDevice(), till)
	}
	if anAccount(t).UpdatedByDevice() != (devices.ID{}) {
		t.Error("an account nobody edited names a device")
	}
}

func TestAnArchivedAccountStaysArchived(t *testing.T) {
	snapshot := anAccount(t).Snapshot()
	snapshot.Active = false
	snapshot.UpdatedAt = editedAt

	restored, err := finance.RestoreAccount(snapshot)
	if err != nil {
		t.Fatalf("RestoreAccount: %v", err)
	}
	if restored.Active() {
		t.Error("a closed account came back open")
	}
	if !restored.UpdatedAt().Equal(editedAt) {
		t.Errorf("UpdatedAt = %s, want %s", restored.UpdatedAt(), editedAt)
	}
}

func TestAnAccountThatCannotExistIsRefused(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		break_ func(*finance.AccountSnapshot)
		want   error
	}{
		{"no identifier", func(s *finance.AccountSnapshot) { s.ID = finance.AccountID{} }, finance.ErrInvalidID},
		{"no business", func(s *finance.AccountSnapshot) { s.BusinessID = business.ID{} }, finance.ErrInvalidID},
		{"no name", func(s *finance.AccountSnapshot) { s.Name = "   " }, validate.ErrInvalidName},
		{"a name with invisible characters", func(s *finance.AccountSnapshot) { s.Name = "Cai​sse" }, validate.ErrInvalidName},
		{"no kind", func(s *finance.AccountSnapshot) { s.Kind = "" }, finance.ErrInvalidAccountKind},
		{"a kind this build does not know", func(s *finance.AccountSnapshot) { s.Kind = "CRYPTO" }, finance.ErrInvalidAccountKind},
		{"no currency", func(s *finance.AccountSnapshot) { s.Currency = money.Currency{} }, finance.ErrInvalidCurrency},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := finance.AccountSnapshot{
				ID:         finance.NewAccountID(),
				BusinessID: tenant,
				Name:       "Caisse",
				Kind:       finance.Cash,
				Currency:   money.XAF,
				CreatedAt:  openedAt,
			}
			testCase.break_(&snapshot)

			if _, err := finance.NewAccount(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("NewAccount: got %v, want %v", err, testCase.want)
			}
			if _, err := finance.RestoreAccount(snapshot); !errors.Is(err, testCase.want) {
				t.Errorf("RestoreAccount: got %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestAnAccountWithoutAMomentIsRefused(t *testing.T) {
	snapshot := finance.AccountSnapshot{
		ID:         finance.NewAccountID(),
		BusinessID: tenant,
		Name:       "Caisse",
		Kind:       finance.Cash,
		Currency:   money.XAF,
	}
	if _, err := finance.NewAccount(snapshot); err == nil {
		t.Error("an account opened at no moment was accepted")
	}

	snapshot.CreatedAt = editedAt
	snapshot.UpdatedAt = openedAt
	if _, err := finance.RestoreAccount(snapshot); err == nil {
		t.Error("an account updated before it was opened was restored")
	}
}

// A wallet in francs cannot take euros. Refusing here is what keeps an
// account's transactions addable at all (ADR-010).
func TestAnAccountRefusesAnAmountItCannotHold(t *testing.T) {
	account := anAccount(t)

	if err := account.Accepts(money.FromXAF(5_000)); err != nil {
		t.Errorf("a franc account refused francs: %v", err)
	}
	if err := account.Accepts(money.Money{}); !errors.Is(err, finance.ErrInvalidCurrency) {
		t.Errorf("an amount with no currency was accepted: %v", err)
	}

	euros, err := money.New(5_000, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	if err := account.Accepts(euros); !errors.Is(err, finance.ErrInvalidCurrency) {
		t.Errorf("a franc account accepted euros: %v", err)
	}
}
