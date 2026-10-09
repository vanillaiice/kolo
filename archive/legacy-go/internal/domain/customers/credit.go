package customers

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
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways a credit transaction can be rejected.
var (
	// ErrInvalidTransactionType means a type is empty or not one this system
	// knows.
	ErrInvalidTransactionType = errors.New("customers: invalid transaction type")
	// ErrInvalidAmount means an amount is zero, has no currency, or has the
	// wrong sign for its type.
	ErrInvalidAmount = errors.New("customers: invalid amount")
	// ErrMissingReason means a correction did not say why.
	ErrMissingReason = errors.New("customers: this transaction needs a reason")
	// ErrMissingReference means a transaction does not name what caused it.
	ErrMissingReference = errors.New("customers: this transaction needs a reference")
	// ErrCurrencyMismatch means one customer's ledger mixes currencies.
	ErrCurrencyMismatch = errors.New("customers: mixed currencies")
	// ErrCreditLimitExceeded means a sale would put a customer past their limit.
	ErrCreditLimitExceeded = errors.New("customers: credit limit exceeded")
	// ErrInvalidAccount means money moved with no account to move it into, or an
	// account was named where no money moved.
	ErrInvalidAccount = errors.New("customers: invalid account")
)

type transactionTag struct{}

// TransactionID identifies one entry in a customer's credit ledger.
type TransactionID = id.Typed[transactionTag]

// NewTransactionID draws a new transaction identifier.
func NewTransactionID() TransactionID { return id.NewTyped[transactionTag]() }

// TransactionIDFrom tags an identifier drawn from a generator.
func TransactionIDFrom(value id.ID) TransactionID { return id.TypedFrom[transactionTag](value) }

// ParseTransactionID reads a transaction identifier from its text form.
func ParseTransactionID(text string) (TransactionID, error) {
	return id.ParseTyped[transactionTag](text)
}

// TransactionType says why a customer's balance moved (§13).
type TransactionType string

// The transaction types this system records.
const (
	// CreditSale is goods taken now and owed for. It increases the balance.
	CreditSale TransactionType = "CREDIT_SALE"
	// Payment is the customer settling some or all of what they owe.
	Payment TransactionType = "PAYMENT"
	// Return is goods coming back, reducing what they owe.
	Return TransactionType = "RETURN"
	// Adjustment is a correction someone made deliberately, in either
	// direction. It needs a reason.
	Adjustment TransactionType = "ADJUSTMENT"
	// OpeningBalance is what a customer already owed when the business started
	// using the system — the debt carried over from the paper book.
	OpeningBalance TransactionType = "OPENING_BALANCE"
	// WriteOff is a debt the business has given up on. It reduces the balance
	// and needs a reason, because it is money the business has decided to lose.
	WriteOff TransactionType = "WRITE_OFF"
)

var transactionTypes = []TransactionType{
	CreditSale, Payment, Return, Adjustment, OpeningBalance, WriteOff,
}

// TransactionTypes returns every type, in a stable order.
func TransactionTypes() []TransactionType { return slices.Clone(transactionTypes) }

// Defined reports whether t is a type this system knows.
func (t TransactionType) Defined() bool { return slices.Contains(transactionTypes, t) }

// String implements fmt.Stringer.
func (t TransactionType) String() string { return string(t) }

// Increases reports whether this type adds to what a customer owes.
func (t TransactionType) Increases() bool {
	return t == CreditSale || t == OpeningBalance
}

// Decreases reports whether this type reduces what a customer owes.
func (t TransactionType) Decreases() bool {
	return t == Payment || t == Return || t == WriteOff
}

// RequiresReason reports whether this type must say why.
//
// A correction and a write-off change what someone owes with no purchase or
// payment to explain it, which is precisely when a shopkeeper looking at the
// statement months later needs to be told (§39).
func (t TransactionType) RequiresReason() bool {
	return t == Adjustment || t == WriteOff
}

// RequiresReference reports whether this type must name what caused it.
//
// A credit sale without its sale, or a return without its return, is
// untraceable, and §13 expects a statement a customer can be walked through.
func (t TransactionType) RequiresReference() bool {
	return t == CreditSale || t == Return
}

// MovesMoney reports whether this type is money actually changing hands.
//
// Only a payment is. A write-off costs the business money but nobody hands
// anything over; a return brings goods back; an adjustment corrects a figure.
// That distinction is why an account is required on a payment and refused on
// everything else: an account records where money went, and naming one where
// none moved would put cash in a till that never saw it (§17, §18).
func (t TransactionType) MovesMoney() bool { return t == Payment }

// IsSensitive reports whether this type needs an audit record (§39).
//
// Adjusting or writing off a debt is exactly the operation §39 lists as
// requiring one: it moves money with no business event behind it.
func (t TransactionType) IsSensitive() bool {
	return t == Adjustment || t == WriteOff
}

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
	// Kind is the sort of thing, such as "SALE".
	Kind string
	// ID is that thing's identifier, as text: the ledger refers to several
	// kinds of record and does not depend on any of their packages.
	ID string
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

// Transaction is one entry in a customer's credit ledger (§13).
//
// It is immutable and append-only, exactly as the stock ledger is, and for the
// same reason: this is financial history, and a correction is another entry
// rather than an edit to this one (§41, ADR-007).
type Transaction struct {
	id              TransactionID
	customerID      ID
	businessID      business.ID
	branchID        business.BranchID
	transactionType TransactionType
	// amount is signed: positive adds to what the customer owes, negative
	// reduces it. Summing the ledger is then plain addition, with no per-type
	// rule to remember at every call site.
	amount money.Money
	// accountID is where the money went, and is set only on a payment — the one
	// type where money changes hands.
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
	CustomerID ID
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

// RecordTransaction creates one entry in a customer's ledger.
func RecordTransaction(snapshot TransactionSnapshot) (*Transaction, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: transaction", ErrInvalidID)
	}
	if snapshot.CustomerID.IsZero() {
		return nil, fmt.Errorf("%w: customer", ErrInvalidID)
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
	// An entry of nothing is not an entry. It would appear on a statement
	// saying nothing happened, which is worse than not appearing.
	if snapshot.Amount.IsZero() {
		return nil, fmt.Errorf("%w: an entry of nothing", ErrInvalidAmount)
	}

	// The sign has to agree with the type. A payment that increased a debt is
	// the kind of mistake that is invisible in a total and unarguable in a
	// statement, so it is caught here rather than found months later.
	switch {
	case snapshot.Type.Increases() && !snapshot.Amount.IsPositive():
		return nil, fmt.Errorf("%w: %s adds to what is owed, so %s must be positive",
			ErrInvalidAmount, snapshot.Type, snapshot.Amount)
	case snapshot.Type.Decreases() && !snapshot.Amount.IsNegative():
		return nil, fmt.Errorf("%w: %s reduces what is owed, so %s must be negative",
			ErrInvalidAmount, snapshot.Type, snapshot.Amount)
	}

	// Money that moved has to have moved somewhere. A payment with no account
	// is cash nobody can find the next morning, and an account on a write-off
	// claims a till took money it never saw (§17, §18).
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
		customerID:      snapshot.CustomerID,
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
		CustomerID: t.customerID,
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

// CustomerID returns whose ledger this belongs to.
func (t *Transaction) CustomerID() ID { return t.customerID }

// BusinessID returns the business the transaction belongs to.
func (t *Transaction) BusinessID() business.ID { return t.businessID }

// BranchID returns the branch, which may be zero.
func (t *Transaction) BranchID() business.BranchID { return t.branchID }

// Type returns why the balance moved.
func (t *Transaction) Type() TransactionType { return t.transactionType }

// Amount returns the signed amount.
func (t *Transaction) Amount() money.Money { return t.amount }

// Account returns where the money went, and whether any was named. Only a
// payment names one.
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

// Balance is what a customer owes, worked out from their transactions.
//
// Never stored. §13 says balances are derived from transactions rather than
// edited, and a stored copy could disagree with the entries it came from — over
// the one number a shopkeeper and a customer will actually argue about.
type Balance struct {
	CustomerID ID
	// Outstanding is what they owe. Positive is a debt; negative means they are
	// in credit, having paid more than they took.
	Outstanding money.Money
	// Entries is how many transactions the sum came from, so a caller can tell
	// "owes nothing because they always pay" from "owes nothing because they
	// have never bought anything".
	Entries int
	// LastMovedAt is when the most recent transaction occurred, or the zero
	// time if there were none.
	LastMovedAt time.Time
}

// Owes reports whether the customer owes anything.
func (b Balance) Owes() bool { return b.Outstanding.IsPositive() }

// InCredit reports whether they have paid more than they took.
//
// This is not an error. A customer who overpays to clear a debt they were about
// to add to, or one whose return exceeded what was left owing, is in credit —
// and the honest answer is a negative balance rather than a zero one that
// quietly loses their money.
func (b Balance) InCredit() bool { return b.Outstanding.IsNegative() }

// HasHistory reports whether any transaction was ever recorded.
func (b Balance) HasHistory() bool { return b.Entries > 0 }

// DeriveBalance sums a customer's transactions into their balance.
//
// The transactions need not be in any order: addition does not care, and a
// device syncing a week late inserts entries among ones already recorded. That
// is the property that makes an append-only ledger work offline — a late
// arrival changes the total without disturbing anything already there.
func DeriveBalance(customerID ID, transactions []*Transaction) (Balance, error) {
	if customerID.IsZero() {
		return Balance{}, fmt.Errorf("%w: customer", ErrInvalidID)
	}

	balance := Balance{CustomerID: customerID}
	for i, transaction := range transactions {
		if transaction == nil {
			return Balance{}, fmt.Errorf("%w: transaction %d is missing", ErrInvalidID, i)
		}
		if transaction.customerID != customerID {
			return Balance{}, fmt.Errorf("%w: transaction %s belongs to customer %s, not %s",
				ErrInvalidID, transaction.id, transaction.customerID, customerID)
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

// CheckCreditLimit reports whether a further amount would put a customer past
// their limit.
//
// It is a question rather than a rule the ledger enforces, deliberately. A
// shopkeeper who decides to let a regular go over their limit is making a
// business decision, and the system's job is to tell them, not to stop them —
// §13 lists credit limits alongside statements and histories, as information.
// What the caller must not do is ask and then ignore the answer silently.
//
// A customer with no limit set is never over it: no limit means the shopkeeper
// has not decided, and refusing on that basis would block every regular who has
// never been given one.
func CheckCreditLimit(customer *Customer, balance Balance, further money.Money) error {
	if customer == nil {
		return fmt.Errorf("%w: customer", ErrInvalidID)
	}
	limit, set := customer.CreditLimit()
	if !set {
		return nil
	}

	after := further
	if balance.Entries > 0 {
		sum, err := balance.Outstanding.Add(further)
		if err != nil {
			return fmt.Errorf("%w: %w", ErrCurrencyMismatch, err)
		}
		after = sum
	}

	order, err := after.Cmp(limit)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrCurrencyMismatch, err)
	}
	if order > 0 {
		return fmt.Errorf("%w: %s would owe %s against a limit of %s",
			ErrCreditLimitExceeded, customer.name, after, limit)
	}
	return nil
}

// Statement is a customer's transactions with the balance after each, which is
// what §13 means by an account statement.
type Statement struct {
	CustomerID ID
	Lines      []StatementLine
	// Closing is the balance after every line.
	Closing money.Money
}

// StatementLine is one entry with the running balance after it.
type StatementLine struct {
	Transaction *Transaction
	// Balance is what was owed immediately after this entry.
	Balance money.Money
}

// BuildStatement puts a customer's transactions in order and runs the balance
// down them.
//
// Ordered by when each happened, not when it was recorded: a statement is a
// story about the customer's dealings with the shop, and a payment made on
// Monday belongs before a purchase made on Tuesday even if the till syncing
// them arrived the other way round.
func BuildStatement(customerID ID, transactions []*Transaction) (Statement, error) {
	if customerID.IsZero() {
		return Statement{}, fmt.Errorf("%w: customer", ErrInvalidID)
	}

	// Ordered on a copy: the caller may still be holding the slice in the order
	// it fetched, and reordering under it would be a surprise.
	ordered := slices.Clone(transactions)
	slices.SortStableFunc(ordered, func(a, b *Transaction) int {
		if a == nil || b == nil {
			return 0
		}
		if order := a.occurredAt.Compare(b.occurredAt); order != 0 {
			return order
		}
		// Two entries at the same instant are ordered by identifier, so a
		// statement reads the same on every device (ADR-011: identifiers sort
		// by creation time, so this is usually the order they were made in).
		return strings.Compare(a.id.String(), b.id.String())
	})

	// One pass, which both validates and sums. Deriving the balance separately
	// would sum the same entries twice and leave a second failure path that
	// nothing could ever reach.
	statement := Statement{CustomerID: customerID, Lines: make([]StatementLine, 0, len(ordered))}
	running := money.Money{}
	for i, transaction := range ordered {
		if transaction == nil {
			return Statement{}, fmt.Errorf("%w: transaction %d is missing", ErrInvalidID, i)
		}
		if transaction.customerID != customerID {
			return Statement{}, fmt.Errorf("%w: transaction %s belongs to customer %s, not %s",
				ErrInvalidID, transaction.id, transaction.customerID, customerID)
		}

		if i == 0 {
			running = transaction.amount
		} else {
			sum, err := running.Add(transaction.amount)
			if err != nil {
				return Statement{}, fmt.Errorf("%w: transaction %d: %w", ErrCurrencyMismatch, i, err)
			}
			running = sum
		}
		statement.Lines = append(statement.Lines,
			StatementLine{Transaction: transaction, Balance: running})
	}

	statement.Closing = running
	return statement, nil
}
