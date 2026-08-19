// Package expenses is what a business spends that is not stock (§19).
//
// Rent, electricity, transport, a salary, packaging. Money leaves an account
// and nothing arrives on a shelf, which is exactly what distinguishes an expense
// from a purchase: a purchase raises inventory, an expense does not, and
// confusing the two would make the shop's goods look more expensive than they
// were.
//
// An expense is financial history and is never edited (§41, ADR-007). One
// entered in error is corrected by a reversal — a second row, negative, naming
// the one it undoes — so the day's cash still shows that the mistake was made
// and put right, rather than silently reading as though it never happened.
package expenses

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

// The ways an expense can be rejected.
var (
	// ErrInvalidID means an identifier is missing or malformed.
	ErrInvalidID = errors.New("expenses: invalid identifier")
	// ErrInvalidCategory means a category is empty or not one this system knows.
	ErrInvalidCategory = errors.New("expenses: invalid category")
	// ErrInvalidAmount means an amount is zero, has no currency, or is negative
	// without saying what it reverses.
	ErrInvalidAmount = errors.New("expenses: invalid amount")
	// ErrMissingDescription means an expense did not say what it was for.
	ErrMissingDescription = errors.New("expenses: this expense needs a description")
	// ErrInvalidReversal means a reversal does not undo an expense, or an
	// ordinary expense claims to.
	ErrInvalidReversal = errors.New("expenses: invalid reversal")
)

type expenseTag struct{}

// ID identifies one expense.
type ID = id.Typed[expenseTag]

// NewID draws a new expense identifier.
func NewID() ID { return id.NewTyped[expenseTag]() }

// IDFrom tags an identifier drawn from a generator.
func IDFrom(value id.ID) ID { return id.TypedFrom[expenseTag](value) }

// ParseID reads an expense identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[expenseTag](text) }

// Category is what a cost was for (§19).
//
// A fixed list, deliberately, and the one §19 enumerates. It is what reports
// group by, and free text would group nothing: "Transport", "transport" and
// "Transpor" are three lines in a report a shopkeeper reads as one cost. A
// business whose costs do not fit uses Other and writes what it was in the
// description.
//
// If a business ever needs its own categories, that is a configurable list like
// financial accounts and wants an ADR rather than a quiet change here — the two
// are not the same problem: §10 requires providers to be configurable, and §19
// does not.
type Category string

// The expense categories this system knows (§19).
const (
	Rent        Category = "RENT"
	Electricity Category = "ELECTRICITY"
	Water       Category = "WATER"
	Transport   Category = "TRANSPORT"
	Salary      Category = "SALARY"
	Packaging   Category = "PACKAGING"
	Maintenance Category = "MAINTENANCE"
	Internet    Category = "INTERNET"
	Marketing   Category = "MARKETING"
	// Other is everything else, and the description says what.
	Other Category = "OTHER"
)

var categories = []Category{
	Rent, Electricity, Water, Transport, Salary,
	Packaging, Maintenance, Internet, Marketing, Other,
}

// Categories returns every category, in a stable order.
func Categories() []Category { return slices.Clone(categories) }

// Defined reports whether c is a category this system knows.
func (c Category) Defined() bool { return slices.Contains(categories, c) }

// String implements fmt.Stringer.
func (c Category) String() string { return string(c) }

// NeedsDescription reports whether this category must say what the money went
// on.
//
// Only Other does. Every other category says it on its own; "OTHER, 15,000" says
// nothing at all, and is the line an owner will stare at in a month's report
// with no way to find out what it was.
func (c Category) NeedsDescription() bool { return c == Other }

// ParseCategory reads a category, refusing one this system does not know.
func ParseCategory(text string) (Category, error) {
	category := Category(text)
	if !category.Defined() {
		return "", fmt.Errorf("%w: %q", ErrInvalidCategory, text)
	}
	return category, nil
}

// Expense is money the business spent that did not become stock (§19).
type Expense struct {
	id         ID
	businessID business.ID
	branchID   business.BranchID

	category Category
	// accountID is where the money came from. An expense that named no account
	// would leave the business poorer with no drawer any lighter (§17).
	accountID finance.AccountID
	// amount is positive for a cost and negative for a reversal, so that summing
	// expenses — for a report, or for what an account holds — is plain addition.
	amount      money.Money
	description string
	// reference is the receipt or invoice number, when there is one.
	reference string
	// reverses names the expense this one undoes, and is zero otherwise.
	reverses ID

	userID     users.ID
	deviceID   devices.ID
	occurredAt time.Time
	recordedAt time.Time
}

// Snapshot is the flat representation of an Expense.
type Snapshot struct {
	ID          ID
	BusinessID  business.ID
	BranchID    business.BranchID
	Category    Category
	AccountID   finance.AccountID
	Amount      money.Money
	Description string
	Reference   string
	Reverses    ID
	UserID      users.ID
	DeviceID    devices.ID
	OccurredAt  time.Time
	RecordedAt  time.Time
}

// Record creates an expense.
func Record(snapshot Snapshot) (*Expense, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: expense", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if snapshot.AccountID.IsZero() {
		return nil, fmt.Errorf("%w: account", ErrInvalidID)
	}
	if snapshot.UserID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if snapshot.DeviceID.IsZero() {
		return nil, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if !snapshot.Category.Defined() {
		return nil, fmt.Errorf("%w: %q", ErrInvalidCategory, snapshot.Category)
	}
	if err := validate.Timestamps(snapshot.OccurredAt, snapshot.RecordedAt); err != nil {
		return nil, err
	}

	if !snapshot.Amount.Valid() {
		return nil, fmt.Errorf("%w: no currency", ErrInvalidAmount)
	}
	if snapshot.Amount.IsZero() {
		return nil, fmt.Errorf("%w: an expense of nothing", ErrInvalidAmount)
	}

	// A negative expense is a reversal and must say what it undoes. Otherwise it
	// is money appearing in the accounts with no explanation, which is the
	// shape of a mistake nobody can trace.
	switch {
	case snapshot.Amount.IsNegative() && snapshot.Reverses.IsZero():
		return nil, fmt.Errorf("%w: %s undoes nothing", ErrInvalidReversal, snapshot.Amount)
	case snapshot.Amount.IsPositive() && !snapshot.Reverses.IsZero():
		return nil, fmt.Errorf("%w: a cost cannot also be a reversal", ErrInvalidReversal)
	case snapshot.Reverses == snapshot.ID:
		return nil, fmt.Errorf("%w: an expense cannot reverse itself", ErrInvalidReversal)
	}

	if snapshot.Category.NeedsDescription() && strings.TrimSpace(snapshot.Description) == "" {
		return nil, fmt.Errorf("%w: %s", ErrMissingDescription, snapshot.Category)
	}

	return &Expense{
		id:          snapshot.ID,
		businessID:  snapshot.BusinessID,
		branchID:    snapshot.BranchID,
		category:    snapshot.Category,
		accountID:   snapshot.AccountID,
		amount:      snapshot.Amount,
		description: snapshot.Description,
		reference:   snapshot.Reference,
		reverses:    snapshot.Reverses,
		userID:      snapshot.UserID,
		deviceID:    snapshot.DeviceID,
		occurredAt:  snapshot.OccurredAt.UTC(),
		recordedAt:  snapshot.RecordedAt.UTC(),
	}, nil
}

// Restore rebuilds an expense from storage, validating it on the way in.
func Restore(snapshot Snapshot) (*Expense, error) { return Record(snapshot) }

// Reverse builds the expense that undoes this one.
//
// The correction is another row rather than a deletion, so the day's cash still
// shows that the mistake was made and put right (§41). It keeps the original's
// category and account, because it has to land back where the money came from
// to be worth anything.
func (e *Expense) Reverse(snapshot Snapshot) (*Expense, error) {
	// The arithmetic first, because it is the one thing here that can fail on a
	// value rather than on a rule: the most negative amount has no positive
	// counterpart, and a row carrying one could only have come from an older
	// build or a bad migration.
	negated, err := e.amount.Neg()
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidAmount, err)
	}
	if !e.reverses.IsZero() {
		return nil, fmt.Errorf("%w: %s is itself a reversal", ErrInvalidReversal, e.id)
	}

	snapshot.BusinessID = e.businessID
	snapshot.BranchID = e.branchID
	snapshot.Category = e.category
	snapshot.AccountID = e.accountID
	snapshot.Amount = negated
	snapshot.Reverses = e.id
	if strings.TrimSpace(snapshot.Description) == "" {
		snapshot.Description = e.description
	}
	if snapshot.OccurredAt.IsZero() {
		snapshot.OccurredAt = e.occurredAt
	}

	return Record(snapshot)
}

// Snapshot returns the flat representation of the expense.
func (e *Expense) Snapshot() Snapshot {
	return Snapshot{
		ID:          e.id,
		BusinessID:  e.businessID,
		BranchID:    e.branchID,
		Category:    e.category,
		AccountID:   e.accountID,
		Amount:      e.amount,
		Description: e.description,
		Reference:   e.reference,
		Reverses:    e.reverses,
		UserID:      e.userID,
		DeviceID:    e.deviceID,
		OccurredAt:  e.occurredAt,
		RecordedAt:  e.recordedAt,
	}
}

// ID returns the expense's identifier.
func (e *Expense) ID() ID { return e.id }

// BusinessID returns the business that spent it.
func (e *Expense) BusinessID() business.ID { return e.businessID }

// BranchID returns the branch, which may be zero.
func (e *Expense) BranchID() business.BranchID { return e.branchID }

// Category returns what the money went on.
func (e *Expense) Category() Category { return e.category }

// AccountID returns which account it came out of.
func (e *Expense) AccountID() finance.AccountID { return e.accountID }

// Amount returns the signed amount: positive for a cost, negative for a
// reversal.
func (e *Expense) Amount() money.Money { return e.amount }

// Description returns what it was for, which may be empty except on Other.
func (e *Expense) Description() string { return e.description }

// Reference returns the receipt or invoice number, which may be empty.
func (e *Expense) Reference() string { return e.reference }

// Reverses returns the expense this one undoes, and whether it undoes one.
func (e *Expense) Reverses() (ID, bool) { return e.reverses, !e.reverses.IsZero() }

// IsReversal reports whether this expense undoes another.
func (e *Expense) IsReversal() bool { return !e.reverses.IsZero() }

// UserID returns who recorded it.
func (e *Expense) UserID() users.ID { return e.userID }

// DeviceID returns the device it was recorded on.
func (e *Expense) DeviceID() devices.ID { return e.deviceID }

// OccurredAt returns when the money was spent, in UTC.
func (e *Expense) OccurredAt() time.Time { return e.occurredAt }

// RecordedAt returns when the record was written, in UTC.
func (e *Expense) RecordedAt() time.Time { return e.recordedAt }

// Scope returns the tenant scope the expense belongs to.
func (e *Expense) Scope() business.Scope {
	return business.ScopeOf(e.businessID, e.branchID)
}

// Total sums expenses, which is what every report of them starts from.
//
// Reversals are negative, so they cancel the costs they undo by plain addition —
// there is no rule to remember about skipping them, which is the whole reason
// the sign is stored rather than derived from a flag.
func Total(spent []*Expense) (money.Money, error) {
	total := money.Money{}
	for i, expense := range spent {
		if expense == nil {
			return money.Money{}, fmt.Errorf("%w: expense %d is missing", ErrInvalidID, i)
		}
		if i == 0 {
			total = expense.amount
			continue
		}
		sum, err := total.Add(expense.amount)
		if err != nil {
			return money.Money{}, fmt.Errorf("%w: expense %d: %w", ErrInvalidAmount, i, err)
		}
		total = sum
	}
	return total, nil
}
