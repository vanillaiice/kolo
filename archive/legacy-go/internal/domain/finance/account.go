// Package finance is where a business's money sits (§17).
//
// An account is a place money is held or received: the till, a bank account, an
// MTN Mobile Money wallet, an Orange Money wallet. Balances are derived from
// transactions and never stored, for the same reason stock is (§59).
//
// Mobile Money providers are accounts, not payment types. §10 is explicit that
// they must be configurable rather than hard-coded, because a business will use
// a provider this build has never heard of, and adding one should be a row
// rather than a release.
//
// Only what payments need exists so far. The account entity and its
// transactions are §17 and §18 and arrive with them.
package finance

import (
	"errors"
	"fmt"
	"slices"

	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

// ErrInvalidAccountKind means an account kind is empty or not one this system
// knows.
var ErrInvalidAccountKind = errors.New("finance: invalid account kind")

type accountTag struct{}

// AccountID identifies a financial account.
type AccountID = id.Typed[accountTag]

// NewAccountID draws a new account identifier.
func NewAccountID() AccountID { return id.NewTyped[accountTag]() }

// AccountIDFrom tags an identifier drawn from a generator.
func AccountIDFrom(value id.ID) AccountID { return id.TypedFrom[accountTag](value) }

// ParseAccountID reads an account identifier from its text form.
func ParseAccountID(text string) (AccountID, error) { return id.ParseTyped[accountTag](text) }

// AccountKind is what sort of place money sits in.
//
// The kind is how the system reasons about an account — cash needs reconciling
// against a drawer, a wallet does not. Which provider a wallet belongs to is
// the account's own name, not a kind here. That is the whole point of §10:
// adding Orange Money must be a row, not a release.
type AccountKind string

// The account kinds this system knows (§10, §17).
const (
	// Cash is physical money, in a till or a safe.
	Cash AccountKind = "CASH"
	// MobileMoney is a wallet with a provider such as MTN or Orange.
	MobileMoney AccountKind = "MOBILE_MONEY"
	// Bank is a bank account.
	Bank AccountKind = "BANK"
	// Card is money taken by card.
	Card AccountKind = "CARD"
	// Other is anything a business uses that is none of the above.
	Other AccountKind = "OTHER"
)

var accountKinds = []AccountKind{Cash, MobileMoney, Bank, Card, Other}

// AccountKinds returns every kind, in a stable order.
func AccountKinds() []AccountKind { return slices.Clone(accountKinds) }

// Defined reports whether k is a kind this system knows.
func (k AccountKind) Defined() bool { return slices.Contains(accountKinds, k) }

// NeedsReconciliation reports whether this kind is counted by hand against what
// the system says (§18).
//
// Cash is, because a drawer can be short. An electronic balance cannot be
// miscounted, only disagreed with, which is a different problem.
func (k AccountKind) NeedsReconciliation() bool { return k == Cash }

// String implements fmt.Stringer.
func (k AccountKind) String() string { return string(k) }

// ParseAccountKind reads a kind, refusing one this system does not know.
func ParseAccountKind(text string) (AccountKind, error) {
	kind := AccountKind(text)
	if !kind.Defined() {
		return "", fmt.Errorf("%w: %q", ErrInvalidAccountKind, text)
	}
	return kind, nil
}
