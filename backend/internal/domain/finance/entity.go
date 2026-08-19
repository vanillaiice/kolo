package finance

import (
	"errors"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways an account can be rejected.
var (
	// ErrInvalidID means an identifier is missing or malformed.
	ErrInvalidID = errors.New("finance: invalid identifier")
	// ErrInvalidCurrency means an account has no currency, or one this system
	// does not know.
	ErrInvalidCurrency = errors.New("finance: invalid currency")
)

// Account is a place a business's money sits (§17).
//
// The till, the safe, an MTN wallet, an Orange wallet, a bank account. What
// makes one an account rather than a payment method is that money is *in* it,
// and can be counted, moved, and reconciled against what the system believes.
//
// It holds **no balance**. What an account holds is the sum of the transactions
// touching it — the payments taken into it, the cash paid out of it, the
// transfers between it and another — and a column here would be a second
// version of that, one that could disagree with the movements it came from
// (§59). §18's whole point is comparing what the system derives against what is
// actually in the drawer; a stored balance would make that comparison
// meaningless, since it would be the number being checked and the number
// checking.
//
// Which provider a wallet belongs to is the account's *name*, not its kind.
// That is what makes adding Orange Money a row rather than a release (§10).
type Account struct {
	id         AccountID
	businessID business.ID
	// branchID is optional. A till belongs to a branch; a bank account belongs
	// to the business (§42).
	branchID business.BranchID
	name     string
	kind     AccountKind
	currency money.Currency
	// number is the wallet number, account number, or till label — whatever a
	// person uses to tell this account from another of the same kind. Optional,
	// because a shop with one drawer needs nothing more than "Caisse".
	number string
	notes  string
	active bool
	// updatedByDevice is the device whose edit is in force, breaking a tie
	// between two edits stamped the same instant (ADR-015).
	updatedByDevice devices.ID
	createdAt       time.Time
	updatedAt       time.Time
}

// AccountSnapshot is the flat representation of an Account.
type AccountSnapshot struct {
	ID              AccountID
	BusinessID      business.ID
	BranchID        business.BranchID
	Name            string
	Kind            AccountKind
	Currency        money.Currency
	Number          string
	Notes           string
	Active          bool
	UpdatedByDevice devices.ID
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// NewAccount opens an account, active from the given moment.
func NewAccount(snapshot AccountSnapshot) (*Account, error) {
	cleaned, err := validateAccount(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Moment(snapshot.CreatedAt, "creation time"); err != nil {
		return nil, err
	}

	moment := snapshot.CreatedAt.UTC()
	account := buildAccount(cleaned)
	account.active = true
	account.createdAt = moment
	account.updatedAt = moment
	return account, nil
}

// RestoreAccount rebuilds an account from storage, validating it on the way in.
func RestoreAccount(snapshot AccountSnapshot) (*Account, error) {
	cleaned, err := validateAccount(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Timestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	account := buildAccount(cleaned)
	account.active = snapshot.Active
	account.createdAt = snapshot.CreatedAt.UTC()
	account.updatedAt = snapshot.UpdatedAt.UTC()
	return account, nil
}

func buildAccount(snapshot AccountSnapshot) *Account {
	return &Account{
		id:              snapshot.ID,
		businessID:      snapshot.BusinessID,
		branchID:        snapshot.BranchID,
		name:            snapshot.Name,
		kind:            snapshot.Kind,
		currency:        snapshot.Currency,
		number:          snapshot.Number,
		notes:           snapshot.Notes,
		updatedByDevice: snapshot.UpdatedByDevice,
	}
}

func validateAccount(snapshot AccountSnapshot) (AccountSnapshot, error) {
	if snapshot.ID.IsZero() {
		return AccountSnapshot{}, fmt.Errorf("%w: account", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return AccountSnapshot{}, fmt.Errorf("%w: business", ErrInvalidID)
	}

	name, err := validate.Name(snapshot.Name)
	if err != nil {
		return AccountSnapshot{}, err
	}
	snapshot.Name = name

	if !snapshot.Kind.Defined() {
		return AccountSnapshot{}, fmt.Errorf("%w: %q", ErrInvalidAccountKind, snapshot.Kind)
	}
	// An account with no currency could hold anything, and its transactions
	// would have nothing to be checked against (ADR-010).
	if !snapshot.Currency.Defined() {
		return AccountSnapshot{}, fmt.Errorf("%w: account %s", ErrInvalidCurrency, snapshot.ID)
	}
	return snapshot, nil
}

// Snapshot returns the flat representation of the account.
func (a *Account) Snapshot() AccountSnapshot {
	return AccountSnapshot{
		ID:              a.id,
		BusinessID:      a.businessID,
		BranchID:        a.branchID,
		Name:            a.name,
		Kind:            a.kind,
		Currency:        a.currency,
		Number:          a.number,
		Notes:           a.notes,
		Active:          a.active,
		UpdatedByDevice: a.updatedByDevice,
		CreatedAt:       a.createdAt,
		UpdatedAt:       a.updatedAt,
	}
}

// ID returns the immutable identifier.
func (a *Account) ID() AccountID { return a.id }

// BusinessID returns the business the account belongs to.
func (a *Account) BusinessID() business.ID { return a.businessID }

// BranchID returns the branch, which may be zero for an account the whole
// business shares.
func (a *Account) BranchID() business.BranchID { return a.branchID }

// Name returns what the account is called, which for a wallet is how a
// shopkeeper tells MTN from Orange.
func (a *Account) Name() string { return a.name }

// Kind returns what sort of place the money sits in.
func (a *Account) Kind() AccountKind { return a.kind }

// Currency returns what the account holds.
func (a *Account) Currency() money.Currency { return a.currency }

// Number returns the wallet or bank number, which may be empty.
func (a *Account) Number() string { return a.number }

// Notes returns whatever the shopkeeper wrote, which may be empty.
func (a *Account) Notes() string { return a.notes }

// Active reports whether the account is still in use.
func (a *Account) Active() bool { return a.active }

// NeedsReconciliation reports whether this account is counted by hand against
// what the system says (§18).
func (a *Account) NeedsReconciliation() bool { return a.kind.NeedsReconciliation() }

// UpdatedByDevice returns the device that last edited the account, which may be
// zero.
func (a *Account) UpdatedByDevice() devices.ID { return a.updatedByDevice }

// CreatedAt returns when the account was opened, in UTC.
func (a *Account) CreatedAt() time.Time { return a.createdAt }

// UpdatedAt returns when it last changed, in UTC.
func (a *Account) UpdatedAt() time.Time { return a.updatedAt }

// Scope returns the tenant scope the account belongs to.
func (a *Account) Scope() business.Scope {
	return business.ScopeOf(a.businessID, a.branchID)
}

// Accepts reports whether an amount can go into this account.
//
// A wallet in francs cannot take euros. Refusing here rather than at the sum is
// what keeps an account's transactions addable at all (ADR-010).
func (a *Account) Accepts(amount money.Money) error {
	if !amount.Valid() {
		return fmt.Errorf("%w: an amount with no currency", ErrInvalidCurrency)
	}
	if amount.Currency() != a.currency {
		return fmt.Errorf("%w: %s holds %s, not %s",
			ErrInvalidCurrency, a.name, a.currency, amount.Currency())
	}
	return nil
}
