package finance

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways a movement can be rejected.
var (
	// ErrInvalidMovementType means a type is empty or not one this system knows.
	ErrInvalidMovementType = errors.New("finance: invalid movement type")
	// ErrInvalidAmount means an amount is zero, has no currency, or has the
	// wrong sign for its type.
	ErrInvalidAmount = errors.New("finance: invalid amount")
	// ErrMissingReason means a movement did not say why.
	ErrMissingReason = errors.New("finance: this movement needs a reason")
	// ErrMissingCounterpart means a transfer does not say where the money went.
	ErrMissingCounterpart = errors.New("finance: a transfer needs a counterpart account")
	// ErrSameAccount means a transfer moves money to where it already is.
	ErrSameAccount = errors.New("finance: a transfer needs two accounts")
)

type movementTag struct{}

// MovementID identifies one movement of money into or out of an account.
type MovementID = id.Typed[movementTag]

// NewMovementID draws a new movement identifier.
func NewMovementID() MovementID { return id.NewTyped[movementTag]() }

// MovementIDFrom tags an identifier drawn from a generator.
func MovementIDFrom(value id.ID) MovementID { return id.TypedFrom[movementTag](value) }

// ParseMovementID reads a movement identifier from its text form.
func ParseMovementID(text string) (MovementID, error) { return id.ParseTyped[movementTag](text) }

// MovementType says why money entered or left an account (§18).
//
// These are the movements a *person* makes: the float put in at opening, cash
// taken to the bank, a transfer from the till to a wallet, the correction after
// a count. Money a sale or a customer payment moved is not here — those are
// recorded once, where they happened, and an account's balance sums them from
// there rather than keeping a second copy.
type MovementType string

// The movement types this system records.
const (
	// OpeningBalance is what was in an account when the business started using
	// the system, or the float put into a drawer at the start of a session.
	OpeningBalance MovementType = "OPENING_BALANCE"
	// CashIn is money put in from outside the business's own trade — the
	// owner's own money, a loan.
	CashIn MovementType = "CASH_IN"
	// CashOut is money taken out: to the bank, to the owner's pocket.
	CashOut MovementType = "CASH_OUT"
	// TransferIn is money arriving from another of the business's accounts.
	TransferIn MovementType = "TRANSFER_IN"
	// TransferOut is money leaving for another of the business's accounts.
	TransferOut MovementType = "TRANSFER_OUT"
	// Adjustment is the correction after a count, in either direction. It needs
	// a reason, because it is money appearing or vanishing with no event behind
	// it (§39).
	Adjustment MovementType = "ADJUSTMENT"
)

var movementTypes = []MovementType{
	OpeningBalance, CashIn, CashOut, TransferIn, TransferOut, Adjustment,
}

// MovementTypes returns every type, in a stable order.
func MovementTypes() []MovementType { return slices.Clone(movementTypes) }

// Defined reports whether t is a type this system knows.
func (t MovementType) Defined() bool { return slices.Contains(movementTypes, t) }

// String implements fmt.Stringer.
func (t MovementType) String() string { return string(t) }

// Increases reports whether this type adds to what an account holds.
func (t MovementType) Increases() bool {
	return t == OpeningBalance || t == CashIn || t == TransferIn
}

// Decreases reports whether this type takes money out.
func (t MovementType) Decreases() bool { return t == CashOut || t == TransferOut }

// IsTransfer reports whether this type moves money between two of the
// business's own accounts, which is the one case with a counterpart.
func (t MovementType) IsTransfer() bool { return t == TransferIn || t == TransferOut }

// RequiresReason reports whether this type must say why.
//
// A correction is money appearing or vanishing with no business event behind
// it, which is exactly when the owner reading the day's cash needs to be told
// (§18, §39). So is cash taken out of the business.
func (t MovementType) RequiresReason() bool { return t == Adjustment || t == CashOut }

// IsSensitive reports whether this type needs an audit record (§39).
func (t MovementType) IsSensitive() bool { return t == Adjustment || t == CashOut }

// ParseMovementType reads a type, refusing one this system does not know.
func ParseMovementType(text string) (MovementType, error) {
	movementType := MovementType(text)
	if !movementType.Defined() {
		return "", fmt.Errorf("%w: %q", ErrInvalidMovementType, text)
	}
	return movementType, nil
}

// Movement is money entering or leaving an account by someone's hand (§18).
//
// Append-only, like every other ledger here. A cash count that finds the drawer
// short does not edit yesterday's movements; it records an adjustment saying so,
// which is what leaves an owner able to see that the drawer was short at all
// (§41, ADR-007).
type Movement struct {
	id         MovementID
	accountID  AccountID
	businessID business.ID
	branchID   business.BranchID

	movementType MovementType
	// amount is signed: positive puts money in, negative takes it out. Summing
	// an account is then plain addition with no per-type rule to remember.
	amount money.Money
	// counterpartID is the other account in a transfer, and zero otherwise. A
	// transfer is two movements — out of one account and into the other — each
	// naming the other side, so neither half can be read as money vanishing.
	counterpartID AccountID
	reason        string

	userID     users.ID
	deviceID   devices.ID
	occurredAt time.Time
	recordedAt time.Time
}

// MovementSnapshot is the flat representation of a Movement.
type MovementSnapshot struct {
	ID            MovementID
	AccountID     AccountID
	BusinessID    business.ID
	BranchID      business.BranchID
	Type          MovementType
	Amount        money.Money
	CounterpartID AccountID
	Reason        string
	UserID        users.ID
	DeviceID      devices.ID
	OccurredAt    time.Time
	RecordedAt    time.Time
}

// RecordMovement creates one movement of money into or out of an account.
func RecordMovement(snapshot MovementSnapshot) (*Movement, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: movement", ErrInvalidID)
	}
	if snapshot.AccountID.IsZero() {
		return nil, fmt.Errorf("%w: account", ErrInvalidID)
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
		return nil, fmt.Errorf("%w: %q", ErrInvalidMovementType, snapshot.Type)
	}
	if err := validate.Timestamps(snapshot.OccurredAt, snapshot.RecordedAt); err != nil {
		return nil, err
	}

	if !snapshot.Amount.Valid() {
		return nil, fmt.Errorf("%w: no currency", ErrInvalidAmount)
	}
	// A movement of nothing says nothing, and would appear in a day's cash
	// report as an event that did not happen.
	if snapshot.Amount.IsZero() {
		return nil, fmt.Errorf("%w: a movement of nothing", ErrInvalidAmount)
	}

	// The sign has to agree with the type. Cash taken out that read as money in
	// would make a drawer look full that is empty, and only a count would ever
	// find it.
	switch {
	case snapshot.Type.Increases() && !snapshot.Amount.IsPositive():
		return nil, fmt.Errorf("%w: %s puts money in, so %s must be positive",
			ErrInvalidAmount, snapshot.Type, snapshot.Amount)
	case snapshot.Type.Decreases() && !snapshot.Amount.IsNegative():
		return nil, fmt.Errorf("%w: %s takes money out, so %s must be negative",
			ErrInvalidAmount, snapshot.Type, snapshot.Amount)
	}

	if snapshot.Type.RequiresReason() && strings.TrimSpace(snapshot.Reason) == "" {
		return nil, fmt.Errorf("%w: %s", ErrMissingReason, snapshot.Type)
	}

	// A transfer names both ends. Half a transfer is money vanishing from one
	// account with nothing to show where it went.
	switch {
	case snapshot.Type.IsTransfer() && snapshot.CounterpartID.IsZero():
		return nil, fmt.Errorf("%w: %s", ErrMissingCounterpart, snapshot.Type)
	case !snapshot.Type.IsTransfer() && !snapshot.CounterpartID.IsZero():
		return nil, fmt.Errorf("%w: %s moves nothing between accounts",
			ErrMissingCounterpart, snapshot.Type)
	case snapshot.CounterpartID == snapshot.AccountID:
		return nil, fmt.Errorf("%w: %s", ErrSameAccount, snapshot.AccountID)
	}

	return &Movement{
		id:            snapshot.ID,
		accountID:     snapshot.AccountID,
		businessID:    snapshot.BusinessID,
		branchID:      snapshot.BranchID,
		movementType:  snapshot.Type,
		amount:        snapshot.Amount,
		counterpartID: snapshot.CounterpartID,
		reason:        snapshot.Reason,
		userID:        snapshot.UserID,
		deviceID:      snapshot.DeviceID,
		occurredAt:    snapshot.OccurredAt.UTC(),
		recordedAt:    snapshot.RecordedAt.UTC(),
	}, nil
}

// RestoreMovement rebuilds a movement from storage, validating it on the way in.
func RestoreMovement(snapshot MovementSnapshot) (*Movement, error) {
	return RecordMovement(snapshot)
}

// Snapshot returns the flat representation of the movement.
func (m *Movement) Snapshot() MovementSnapshot {
	return MovementSnapshot{
		ID:            m.id,
		AccountID:     m.accountID,
		BusinessID:    m.businessID,
		BranchID:      m.branchID,
		Type:          m.movementType,
		Amount:        m.amount,
		CounterpartID: m.counterpartID,
		Reason:        m.reason,
		UserID:        m.userID,
		DeviceID:      m.deviceID,
		OccurredAt:    m.occurredAt,
		RecordedAt:    m.recordedAt,
	}
}

// ID returns the movement's identifier.
func (m *Movement) ID() MovementID { return m.id }

// AccountID returns which account moved.
func (m *Movement) AccountID() AccountID { return m.accountID }

// BusinessID returns the business the movement belongs to.
func (m *Movement) BusinessID() business.ID { return m.businessID }

// BranchID returns the branch, which may be zero.
func (m *Movement) BranchID() business.BranchID { return m.branchID }

// Type returns why the money moved.
func (m *Movement) Type() MovementType { return m.movementType }

// Amount returns the signed amount.
func (m *Movement) Amount() money.Money { return m.amount }

// Counterpart returns the other account in a transfer, and whether there is one.
func (m *Movement) Counterpart() (AccountID, bool) {
	return m.counterpartID, !m.counterpartID.IsZero()
}

// Reason returns why, which may be empty.
func (m *Movement) Reason() string { return m.reason }

// UserID returns who moved it.
func (m *Movement) UserID() users.ID { return m.userID }

// DeviceID returns the device it was recorded on.
func (m *Movement) DeviceID() devices.ID { return m.deviceID }

// OccurredAt returns when the money moved, in UTC.
func (m *Movement) OccurredAt() time.Time { return m.occurredAt }

// RecordedAt returns when the record was written, in UTC.
func (m *Movement) RecordedAt() time.Time { return m.recordedAt }

// Transfer builds the two halves of moving money between two accounts.
//
// Two movements rather than one, because an account's balance is the sum of the
// movements naming it: one row could only ever be counted by one of the two
// accounts. Each names the other, so neither half can be read as money
// appearing or vanishing.
//
// They are recorded together or not at all, which is the repository's job. Half
// a transfer is the money genuinely lost.
func Transfer(from, to MovementSnapshot) (out, in *Movement, err error) {
	if from.AccountID == to.AccountID {
		return nil, nil, fmt.Errorf("%w: %s", ErrSameAccount, from.AccountID)
	}

	from.Type, to.Type = TransferOut, TransferIn
	from.CounterpartID, to.CounterpartID = to.AccountID, from.AccountID

	// The amount is given as what leaves, signed as it will be stored: negative.
	// Flipping a positive one silently would be the only place in this domain
	// where a sign that contradicts its meaning is corrected rather than
	// refused, and a caller that meant to move money the other way should say
	// so by naming the other account.
	if !from.Amount.Valid() {
		return nil, nil, fmt.Errorf("%w: no currency", ErrInvalidAmount)
	}
	if !from.Amount.IsNegative() {
		return nil, nil, fmt.Errorf("%w: %s leaves an account, so it must be negative",
			ErrInvalidAmount, from.Amount)
	}
	// What arrives is the same money, and the one arithmetic here that can fail:
	// the most negative amount has no positive counterpart.
	arriving, err := from.Amount.Neg()
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %w", ErrInvalidAmount, err)
	}
	to.Amount = arriving

	out, err = RecordMovement(from)
	if err != nil {
		return nil, nil, fmt.Errorf("the money leaving: %w", err)
	}
	in, err = RecordMovement(to)
	if err != nil {
		return nil, nil, fmt.Errorf("the money arriving: %w", err)
	}
	return out, in, nil
}
