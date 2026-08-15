package sales

import (
	"errors"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// The ways a payment can be rejected.
var (
	// ErrInvalidAmount means a payment is zero, negative, or has no currency.
	ErrInvalidAmount = errors.New("sales: invalid payment amount")
	// ErrOverpaid means the payments come to more than the sale.
	ErrOverpaid = errors.New("sales: paid more than the sale")
	// ErrDuplicatePayment means the same payment appears twice.
	ErrDuplicatePayment = errors.New("sales: duplicate payment")
)

type paymentTag struct{}

// PaymentID identifies a payment.
type PaymentID = id.Typed[paymentTag]

// NewPaymentID draws a new payment identifier.
func NewPaymentID() PaymentID { return id.NewTyped[paymentTag]() }

// PaymentIDFrom tags an identifier drawn from a generator.
func PaymentIDFrom(value id.ID) PaymentID { return id.TypedFrom[paymentTag](value) }

// ParsePaymentID reads a payment identifier from its text form.
func ParsePaymentID(text string) (PaymentID, error) { return id.ParseTyped[paymentTag](text) }

// Payment is money received against a sale.
//
// It is its own record rather than a column on the sale, because §11 requires a
// sale to have several: ten thousand in cash and eight and a half in Mobile
// Money for one bill is an ordinary Cameroonian transaction, and a
// `payment_method` field could not express it.
//
// Where the money went is a financial account, not a payment type. That is what
// makes MTN and Orange configurable rather than hard-coded (§10), and it is
// also what lets a payment raise the right balance without anything here
// knowing which provider it was.
type Payment struct {
	id         PaymentID
	saleID     ID
	businessID business.ID
	branchID   business.BranchID
	accountID  finance.AccountID
	amount     money.Money
	// reference is the provider's transaction number, when there is one. A
	// Mobile Money payment queried a week later is found by this.
	reference  string
	note       string
	userID     users.ID
	deviceID   devices.ID
	occurredAt time.Time
	recordedAt time.Time
}

// PaymentSnapshot is the flat representation of a Payment.
type PaymentSnapshot struct {
	ID         PaymentID
	SaleID     ID
	BusinessID business.ID
	BranchID   business.BranchID
	AccountID  finance.AccountID
	Amount     money.Money
	Reference  string
	Note       string
	UserID     users.ID
	DeviceID   devices.ID
	OccurredAt time.Time
	RecordedAt time.Time
}

// RecordPayment creates a payment.
func RecordPayment(snapshot PaymentSnapshot) (*Payment, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: payment", ErrInvalidID)
	}
	if snapshot.SaleID.IsZero() {
		return nil, fmt.Errorf("%w: sale", ErrInvalidID)
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
	if err := validate.Timestamps(snapshot.OccurredAt, snapshot.RecordedAt); err != nil {
		return nil, err
	}

	if !snapshot.Amount.Valid() {
		return nil, fmt.Errorf("%w: no currency", ErrInvalidAmount)
	}
	// A payment of nothing is not a payment, and a negative one is a refund —
	// which is its own transaction referencing the original, not a sign flip
	// hidden among the receipts (§41, ADR-007).
	if !snapshot.Amount.IsPositive() {
		return nil, fmt.Errorf("%w: %s", ErrInvalidAmount, snapshot.Amount)
	}

	return &Payment{
		id:         snapshot.ID,
		saleID:     snapshot.SaleID,
		businessID: snapshot.BusinessID,
		branchID:   snapshot.BranchID,
		accountID:  snapshot.AccountID,
		amount:     snapshot.Amount,
		reference:  snapshot.Reference,
		note:       snapshot.Note,
		userID:     snapshot.UserID,
		deviceID:   snapshot.DeviceID,
		occurredAt: snapshot.OccurredAt.UTC(),
		recordedAt: snapshot.RecordedAt.UTC(),
	}, nil
}

// RestorePayment rebuilds a payment from storage, validating it on the way in.
func RestorePayment(snapshot PaymentSnapshot) (*Payment, error) { return RecordPayment(snapshot) }

// Snapshot returns the flat representation of the payment.
func (p *Payment) Snapshot() PaymentSnapshot {
	return PaymentSnapshot{
		ID:         p.id,
		SaleID:     p.saleID,
		BusinessID: p.businessID,
		BranchID:   p.branchID,
		AccountID:  p.accountID,
		Amount:     p.amount,
		Reference:  p.reference,
		Note:       p.note,
		UserID:     p.userID,
		DeviceID:   p.deviceID,
		OccurredAt: p.occurredAt,
		RecordedAt: p.recordedAt,
	}
}

// ID returns the payment's identifier.
func (p *Payment) ID() PaymentID { return p.id }

// SaleID returns the sale this paid for.
func (p *Payment) SaleID() ID { return p.saleID }

// BusinessID returns the business the payment belongs to.
func (p *Payment) BusinessID() business.ID { return p.businessID }

// BranchID returns the branch, which may be zero.
func (p *Payment) BranchID() business.BranchID { return p.branchID }

// AccountID returns which account received the money.
func (p *Payment) AccountID() finance.AccountID { return p.accountID }

// Amount returns how much was paid.
func (p *Payment) Amount() money.Money { return p.amount }

// Reference returns the provider's transaction number, which may be empty.
func (p *Payment) Reference() string { return p.reference }

// Note returns whatever the cashier wrote, which may be empty.
func (p *Payment) Note() string { return p.note }

// UserID returns who took the payment.
func (p *Payment) UserID() users.ID { return p.userID }

// DeviceID returns the till it was taken on.
func (p *Payment) DeviceID() devices.ID { return p.deviceID }

// OccurredAt returns when the money changed hands, in UTC.
func (p *Payment) OccurredAt() time.Time { return p.occurredAt }

// RecordedAt returns when the record was written, in UTC.
func (p *Payment) RecordedAt() time.Time { return p.recordedAt }

// Settlement is how a sale stands against what has been paid.
//
// It is worked out from the sale and its payments every time, and stored
// nowhere. A `paid` column beside the payments could disagree with them, and
// then there would be two answers to how much a customer owes — which is the
// one question a shopkeeper cannot afford ambiguity about.
type Settlement struct {
	Total money.Money
	Paid  money.Money
	// Outstanding is what is still owed. Zero when the sale is settled.
	Outstanding money.Money
}

// Settled reports whether nothing is left to pay.
func (s Settlement) Settled() bool { return s.Outstanding.IsZero() }

// OnCredit reports whether some of the sale is still owed, which is what makes
// it a credit sale (§13).
func (s Settlement) OnCredit() bool { return s.Outstanding.IsPositive() }

// Settle works out where a sale stands against its payments.
//
// Payments need not be in any order and need not be complete: a sale part-paid
// today and finished next week is the ordinary shape of credit here.
func Settle(sale *Sale, payments []*Payment) (Settlement, error) {
	total, err := sale.Total()
	if err != nil {
		return Settlement{}, err
	}

	paid, err := money.New(0, total.Currency())
	if err != nil {
		return Settlement{}, err
	}

	seen := make(map[PaymentID]struct{}, len(payments))
	for i, payment := range payments {
		if payment == nil {
			return Settlement{}, fmt.Errorf("%w: payment %d is missing", ErrInvalidID, i)
		}
		if payment.saleID != sale.id {
			return Settlement{}, fmt.Errorf("%w: payment %s is for sale %s, not %s",
				ErrInvalidID, payment.id, payment.saleID, sale.id)
		}
		if _, repeated := seen[payment.id]; repeated {
			return Settlement{}, fmt.Errorf("%w: payment %s counted twice", ErrDuplicatePayment, payment.id)
		}
		seen[payment.id] = struct{}{}

		paid, err = paid.Add(payment.amount)
		if err != nil {
			return Settlement{}, fmt.Errorf("payment %d: %w", i, err)
		}
	}

	outstanding, err := total.Sub(paid)
	if err != nil {
		return Settlement{}, err
	}
	// Paying more than the bill is not change owed — a till gives change from
	// the cash tendered, which is a different number from the payment recorded.
	// A payment above the total means someone recorded the wrong figure, and
	// storing it would put money in the accounts that the business never took.
	if outstanding.IsNegative() {
		return Settlement{}, fmt.Errorf("%w: paid %s against a total of %s", ErrOverpaid, paid, total)
	}

	// An unpaid balance has to be owed by someone. §13 keeps credit against a
	// customer, and a debt with no debtor could never be collected or reported.
	if outstanding.IsPositive() {
		if _, named := sale.Customer(); !named {
			return Settlement{}, fmt.Errorf("%w: %s outstanding", ErrCreditNeedsCustomer, outstanding)
		}
	}

	return Settlement{Total: total, Paid: paid, Outstanding: outstanding}, nil
}
