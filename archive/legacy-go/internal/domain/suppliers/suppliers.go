// Package suppliers is who a business buys from, and what it owes them (§14).
//
// The mirror of customers, and deliberately its own domain rather than a flag on
// one: what a customer owes the shop and what the shop owes a supplier are
// opposite obligations, and a single table with a sign would make it possible to
// pay a customer's debt with a supplier's payment.
//
// A supplier balance is **derived from purchases and payments** (§16), exactly
// as a customer's is derived from their ledger. Nothing here stores a total.
package suppliers

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways a supplier or an entry can be rejected.
var (
	// ErrInvalidID means an identifier is missing or malformed.
	ErrInvalidID = errors.New("suppliers: invalid identifier")
	// ErrInvalidTransactionType means a type is empty or not one this system
	// knows.
	ErrInvalidTransactionType = errors.New("suppliers: invalid transaction type")
	// ErrInvalidAmount means an amount is zero, has no currency, or has the
	// wrong sign for its type.
	ErrInvalidAmount = errors.New("suppliers: invalid amount")
	// ErrMissingReason means a correction did not say why.
	ErrMissingReason = errors.New("suppliers: this transaction needs a reason")
	// ErrMissingReference means a transaction does not name what caused it.
	ErrMissingReference = errors.New("suppliers: this transaction needs a reference")
	// ErrInvalidAccount means money moved with no account, or an account was
	// named where none moved.
	ErrInvalidAccount = errors.New("suppliers: invalid account")
	// ErrCurrencyMismatch means one supplier's ledger mixes currencies.
	ErrCurrencyMismatch = errors.New("suppliers: mixed currencies")
)

type supplierTag struct{}

// ID identifies a supplier.
type ID = id.Typed[supplierTag]

// NewID draws a new supplier identifier.
func NewID() ID { return id.NewTyped[supplierTag]() }

// IDFrom tags an identifier drawn from a generator.
func IDFrom(value id.ID) ID { return id.TypedFrom[supplierTag](value) }

// ParseID reads a supplier identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[supplierTag](text) }

// Supplier is someone a business buys from (§14).
//
// Only a name is required, for the same reason a customer needs only one: a
// shopkeeper writing down a delivery at the door should not have to fill in a
// form first. It holds no balance — what is owed is the sum of the ledger.
type Supplier struct {
	id         ID
	businessID business.ID
	name       string
	number     phone.Number
	address    string
	// contact is the person to ask for, which for a wholesaler is not the
	// business's name and is what a shopkeeper actually remembers (§14).
	contact string
	notes   string
	active  bool
	// updatedByDevice is the device whose edit is in force (ADR-015).
	updatedByDevice devices.ID
	createdAt       time.Time
	updatedAt       time.Time
}

// Snapshot is the flat representation of a Supplier.
type Snapshot struct {
	ID              ID
	BusinessID      business.ID
	Name            string
	Phone           phone.Number
	Address         string
	Contact         string
	Notes           string
	Active          bool
	UpdatedByDevice devices.ID
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// New creates a supplier, active from the given moment.
func New(snapshot Snapshot) (*Supplier, error) {
	cleaned, err := validateSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Moment(snapshot.CreatedAt, "creation time"); err != nil {
		return nil, err
	}

	moment := snapshot.CreatedAt.UTC()
	supplier := build(cleaned)
	supplier.active = true
	supplier.createdAt = moment
	supplier.updatedAt = moment
	return supplier, nil
}

// Restore rebuilds a supplier from storage, validating it on the way in.
func Restore(snapshot Snapshot) (*Supplier, error) {
	cleaned, err := validateSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Timestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	supplier := build(cleaned)
	supplier.active = snapshot.Active
	supplier.createdAt = snapshot.CreatedAt.UTC()
	supplier.updatedAt = snapshot.UpdatedAt.UTC()
	return supplier, nil
}

func build(snapshot Snapshot) *Supplier {
	return &Supplier{
		id:              snapshot.ID,
		businessID:      snapshot.BusinessID,
		name:            snapshot.Name,
		number:          snapshot.Phone,
		address:         snapshot.Address,
		contact:         snapshot.Contact,
		notes:           snapshot.Notes,
		updatedByDevice: snapshot.UpdatedByDevice,
	}
}

func validateSnapshot(snapshot Snapshot) (Snapshot, error) {
	if snapshot.ID.IsZero() {
		return Snapshot{}, fmt.Errorf("%w: supplier", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return Snapshot{}, fmt.Errorf("%w: business", ErrInvalidID)
	}

	name, err := validate.Name(snapshot.Name)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot.Name = name
	return snapshot, nil
}

// Snapshot returns the flat representation of the supplier.
func (s *Supplier) Snapshot() Snapshot {
	return Snapshot{
		ID:              s.id,
		BusinessID:      s.businessID,
		Name:            s.name,
		Phone:           s.number,
		Address:         s.address,
		Contact:         s.contact,
		Notes:           s.notes,
		Active:          s.active,
		UpdatedByDevice: s.updatedByDevice,
		CreatedAt:       s.createdAt,
		UpdatedAt:       s.updatedAt,
	}
}

// ID returns the immutable identifier.
func (s *Supplier) ID() ID { return s.id }

// BusinessID returns the business that buys from them.
func (s *Supplier) BusinessID() business.ID { return s.businessID }

// Name returns what they are called.
func (s *Supplier) Name() string { return s.name }

// Phone returns their number, and whether one was recorded.
func (s *Supplier) Phone() (phone.Number, bool) { return s.number, !s.number.IsZero() }

// Address returns where they are, which may be empty.
func (s *Supplier) Address() string { return s.address }

// Contact returns the person to ask for, which may be empty.
func (s *Supplier) Contact() string { return s.contact }

// Notes returns whatever the shopkeeper wrote, which may be empty.
func (s *Supplier) Notes() string { return s.notes }

// Active reports whether the business still buys from them.
func (s *Supplier) Active() bool { return s.active }

// UpdatedByDevice returns the device whose edit is in force, which may be zero.
func (s *Supplier) UpdatedByDevice() devices.ID { return s.updatedByDevice }

// CreatedAt returns when the record was made, in UTC.
func (s *Supplier) CreatedAt() time.Time { return s.createdAt }

// UpdatedAt returns when it last changed, in UTC.
func (s *Supplier) UpdatedAt() time.Time { return s.updatedAt }

// Scope returns the tenant scope the supplier belongs to.
func (s *Supplier) Scope() business.Scope {
	return business.ScopeOf(s.businessID, business.BranchID{})
}

type transactionTag struct{}

// TransactionID identifies one entry in a supplier's ledger.
type TransactionID = id.Typed[transactionTag]

// NewTransactionID draws a new transaction identifier.
func NewTransactionID() TransactionID { return id.NewTyped[transactionTag]() }

// TransactionIDFrom tags an identifier drawn from a generator.
func TransactionIDFrom(value id.ID) TransactionID { return id.TypedFrom[transactionTag](value) }

// ParseTransactionID reads a transaction identifier from its text form.
func ParseTransactionID(text string) (TransactionID, error) {
	return id.ParseTyped[transactionTag](text)
}

// TransactionType says why what the business owes a supplier moved (§16).
type TransactionType string

// The transaction types this system records.
const (
	// Purchase is goods taken now and owed for. It increases what is owed.
	Purchase TransactionType = "PURCHASE"
	// Payment is the business settling some or all of the bill. It decreases it.
	Payment TransactionType = "PAYMENT"
	// Return is goods going back to the supplier, reducing what is owed.
	Return TransactionType = "RETURN"
	// Adjustment is a correction someone made deliberately, in either
	// direction. It needs a reason.
	Adjustment TransactionType = "ADJUSTMENT"
	// OpeningBalance is what the business already owed when it started using
	// the system.
	OpeningBalance TransactionType = "OPENING_BALANCE"
)

var transactionTypes = []TransactionType{
	Purchase, Payment, Return, Adjustment, OpeningBalance,
}

// TransactionTypes returns every type, in a stable order.
func TransactionTypes() []TransactionType { return slices.Clone(transactionTypes) }

// Defined reports whether t is a type this system knows.
func (t TransactionType) Defined() bool { return slices.Contains(transactionTypes, t) }

// String implements fmt.Stringer.
func (t TransactionType) String() string { return string(t) }

// Increases reports whether this type adds to what the business owes.
func (t TransactionType) Increases() bool {
	return t == Purchase || t == OpeningBalance
}

// Decreases reports whether this type reduces it.
func (t TransactionType) Decreases() bool { return t == Payment || t == Return }

// MovesMoney reports whether this type is money actually changing hands.
//
// Only a payment is, which is why only a payment names a financial account:
// goods going back reduce the bill without a franc moving (§16, §17).
func (t TransactionType) MovesMoney() bool { return t == Payment }

// RequiresReason reports whether this type must say why (§39).
func (t TransactionType) RequiresReason() bool { return t == Adjustment }

// RequiresReference reports whether this type must name what caused it.
func (t TransactionType) RequiresReference() bool { return t == Purchase || t == Return }

// IsSensitive reports whether this type needs an audit record (§39).
func (t TransactionType) IsSensitive() bool { return t == Adjustment }

// ParseTransactionType reads a type, refusing one this system does not know.
func ParseTransactionType(text string) (TransactionType, error) {
	transactionType := TransactionType(text)
	if !transactionType.Defined() {
		return "", fmt.Errorf("%w: %q", ErrInvalidTransactionType, text)
	}
	return transactionType, nil
}

// Reference is what caused a transaction.
type Reference struct {
	Kind string
	ID   string
}

// IsZero reports whether the reference is unset.
func (r Reference) IsZero() bool { return r.Kind == "" && r.ID == "" }

// String implements fmt.Stringer.
func (r Reference) String() string {
	if r.IsZero() {
		return ""
	}
	return r.Kind + ":" + r.ID
}

// Transaction is one entry in a supplier's ledger (§16).
//
// Immutable and append-only, like the customer ledger it mirrors: this is
// financial history, and a correction is another entry rather than an edit.
type Transaction struct {
	id              TransactionID
	supplierID      ID
	businessID      business.ID
	branchID        business.BranchID
	transactionType TransactionType
	// amount is signed: positive adds to what the business owes, negative
	// reduces it. Summing is then plain addition.
	amount money.Money
	// accountID is where a payment's money came from, and is set only on a
	// payment.
	accountID  finance.AccountID
	reference  Reference
	reason     string
	userID     users.ID
	deviceID   devices.ID
	occurredAt time.Time
	recordedAt time.Time
}

// TransactionSnapshot is the flat representation of a Transaction.
type TransactionSnapshot struct {
	ID         TransactionID
	SupplierID ID
	BusinessID business.ID
	BranchID   business.BranchID
	Type       TransactionType
	Amount     money.Money
	AccountID  finance.AccountID
	Reference  Reference
	Reason     string
	UserID     users.ID
	DeviceID   devices.ID
	OccurredAt time.Time
	RecordedAt time.Time
}

// RecordTransaction creates one entry in a supplier's ledger.
func RecordTransaction(snapshot TransactionSnapshot) (*Transaction, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: transaction", ErrInvalidID)
	}
	if snapshot.SupplierID.IsZero() {
		return nil, fmt.Errorf("%w: supplier", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if snapshot.UserID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if snapshot.DeviceID.IsZero() {
		return nil, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if !snapshot.Type.Defined() {
		return nil, fmt.Errorf("%w: %q", ErrInvalidTransactionType, snapshot.Type)
	}
	if err := validate.Timestamps(snapshot.OccurredAt, snapshot.RecordedAt); err != nil {
		return nil, err
	}

	if !snapshot.Amount.Valid() {
		return nil, fmt.Errorf("%w: no currency", ErrInvalidAmount)
	}
	if snapshot.Amount.IsZero() {
		return nil, fmt.Errorf("%w: an entry of nothing", ErrInvalidAmount)
	}

	// The sign has to agree with the type. A payment that increased a bill is
	// invisible in a total and unarguable in a statement.
	switch {
	case snapshot.Type.Increases() && !snapshot.Amount.IsPositive():
		return nil, fmt.Errorf("%w: %s adds to what is owed, so %s must be positive",
			ErrInvalidAmount, snapshot.Type, snapshot.Amount)
	case snapshot.Type.Decreases() && !snapshot.Amount.IsNegative():
		return nil, fmt.Errorf("%w: %s reduces what is owed, so %s must be negative",
			ErrInvalidAmount, snapshot.Type, snapshot.Amount)
	}

	// Money that moved has to have moved from somewhere, and money that did not
	// must not claim an account: goods going back reduce the bill without a
	// franc leaving the till.
	switch {
	case snapshot.Type.MovesMoney() && snapshot.AccountID.IsZero():
		return nil, fmt.Errorf("%w: %s is money changing hands and needs an account",
			ErrInvalidAccount, snapshot.Type)
	case !snapshot.Type.MovesMoney() && !snapshot.AccountID.IsZero():
		return nil, fmt.Errorf("%w: %s moves no money, so it names no account",
			ErrInvalidAccount, snapshot.Type)
	}

	if snapshot.Type.RequiresReason() && strings.TrimSpace(snapshot.Reason) == "" {
		return nil, fmt.Errorf("%w: %s", ErrMissingReason, snapshot.Type)
	}
	if snapshot.Type.RequiresReference() && snapshot.Reference.IsZero() {
		return nil, fmt.Errorf("%w: %s", ErrMissingReference, snapshot.Type)
	}

	return &Transaction{
		id:              snapshot.ID,
		supplierID:      snapshot.SupplierID,
		businessID:      snapshot.BusinessID,
		branchID:        snapshot.BranchID,
		transactionType: snapshot.Type,
		amount:          snapshot.Amount,
		accountID:       snapshot.AccountID,
		reference:       snapshot.Reference,
		reason:          snapshot.Reason,
		userID:          snapshot.UserID,
		deviceID:        snapshot.DeviceID,
		occurredAt:      snapshot.OccurredAt.UTC(),
		recordedAt:      snapshot.RecordedAt.UTC(),
	}, nil
}

// RestoreTransaction rebuilds a transaction from storage, validating it on the
// way in.
func RestoreTransaction(snapshot TransactionSnapshot) (*Transaction, error) {
	return RecordTransaction(snapshot)
}

// Snapshot returns the flat representation of the transaction.
func (t *Transaction) Snapshot() TransactionSnapshot {
	return TransactionSnapshot{
		ID:         t.id,
		SupplierID: t.supplierID,
		BusinessID: t.businessID,
		BranchID:   t.branchID,
		Type:       t.transactionType,
		Amount:     t.amount,
		AccountID:  t.accountID,
		Reference:  t.reference,
		Reason:     t.reason,
		UserID:     t.userID,
		DeviceID:   t.deviceID,
		OccurredAt: t.occurredAt,
		RecordedAt: t.recordedAt,
	}
}

// ID returns the transaction's identifier.
func (t *Transaction) ID() TransactionID { return t.id }

// SupplierID returns whose ledger this belongs to.
func (t *Transaction) SupplierID() ID { return t.supplierID }

// BusinessID returns the business the transaction belongs to.
func (t *Transaction) BusinessID() business.ID { return t.businessID }

// BranchID returns the branch, which may be zero.
func (t *Transaction) BranchID() business.BranchID { return t.branchID }

// Type returns why the balance moved.
func (t *Transaction) Type() TransactionType { return t.transactionType }

// Amount returns the signed amount.
func (t *Transaction) Amount() money.Money { return t.amount }

// Account returns where the money came from, and whether any did.
func (t *Transaction) Account() (finance.AccountID, bool) {
	return t.accountID, !t.accountID.IsZero()
}

// Reference returns what caused it, and whether anything was named.
func (t *Transaction) Reference() (Reference, bool) { return t.reference, !t.reference.IsZero() }

// Reason returns why, which may be empty.
func (t *Transaction) Reason() string { return t.reason }

// UserID returns who recorded it.
func (t *Transaction) UserID() users.ID { return t.userID }

// DeviceID returns the device it was recorded on.
func (t *Transaction) DeviceID() devices.ID { return t.deviceID }

// OccurredAt returns when it happened, in UTC.
func (t *Transaction) OccurredAt() time.Time { return t.occurredAt }

// RecordedAt returns when the record was written, in UTC.
func (t *Transaction) RecordedAt() time.Time { return t.recordedAt }

// Balance is what a business owes a supplier, worked out from the ledger (§16).
//
// Never stored, for the reason the whole system repeats: a stored copy could
// disagree with the entries it came from.
type Balance struct {
	SupplierID ID
	// Outstanding is what is owed. Positive is a debt to the supplier; negative
	// means the business has paid ahead.
	Outstanding money.Money
	Entries     int
	LastMovedAt time.Time
}

// Owes reports whether the business owes this supplier anything.
func (b Balance) Owes() bool { return b.Outstanding.IsPositive() }

// InCredit reports whether the business has paid more than it was billed.
func (b Balance) InCredit() bool { return b.Outstanding.IsNegative() }

// HasHistory reports whether any transaction was ever recorded.
func (b Balance) HasHistory() bool { return b.Entries > 0 }

// DeriveBalance sums a supplier's transactions into what is owed.
//
// Order does not matter: addition does not care, and a device syncing a week
// late inserts entries among ones already recorded.
func DeriveBalance(supplierID ID, transactions []*Transaction) (Balance, error) {
	if supplierID.IsZero() {
		return Balance{}, fmt.Errorf("%w: supplier", ErrInvalidID)
	}

	balance := Balance{SupplierID: supplierID}
	for i, transaction := range transactions {
		if transaction == nil {
			return Balance{}, fmt.Errorf("%w: transaction %d is missing", ErrInvalidID, i)
		}
		if transaction.supplierID != supplierID {
			return Balance{}, fmt.Errorf("%w: transaction %s belongs to supplier %s, not %s",
				ErrInvalidID, transaction.id, transaction.supplierID, supplierID)
		}

		if i == 0 {
			balance.Outstanding = transaction.amount
		} else {
			sum, err := balance.Outstanding.Add(transaction.amount)
			if err != nil {
				return Balance{}, fmt.Errorf("%w: transaction %d: %w", ErrCurrencyMismatch, i, err)
			}
			balance.Outstanding = sum
		}

		balance.Entries++
		if transaction.occurredAt.After(balance.LastMovedAt) {
			balance.LastMovedAt = transaction.occurredAt
		}
	}
	return balance, nil
}
