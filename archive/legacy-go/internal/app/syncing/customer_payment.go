package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// CustomerPaymentPayload is the body of a CUSTOMER_PAYMENT event (ADR-006).
//
// A customer settling their tab is not about any one sale. §13 keeps payments
// against the account rather than against a purchase, which is what lets a
// shopkeeper take 5,000 off a debt built from a fortnight of small buys.
type CustomerPaymentPayload struct {
	Payment CustomerPaymentLine `json:"payment"`
}

// CustomerPaymentLine is one payment as a device describes it.
type CustomerPaymentLine struct {
	// ID is the ledger entry's own identifier, drawn by the device. It is what
	// makes a resent payment one entry rather than two (§27).
	ID         string `json:"id"`
	CustomerID string `json:"customer_id"`
	// AccountID is where the money went. An account, never a payment method,
	// which is what keeps MTN and Orange configurable (§10).
	AccountID string `json:"account_id"`
	// AmountMinor is what was handed over, positive. The ledger stores it
	// negative, because a payment reduces what is owed — the sign is the
	// server's to apply, so a device cannot record a payment that increases a
	// debt.
	AmountMinor int64  `json:"amount_minor"`
	Note        string `json:"note,omitempty"`
	OccurredAt  string `json:"occurred_at"`
}

// customerPayment reads a CUSTOMER_PAYMENT payload into a ledger entry.
//
// Nothing about the customer's balance is checked here, deliberately. A payment
// larger than the debt leaves them in credit, which is the honest answer and
// theirs to reclaim; refusing it would lose money a shopkeeper has already
// taken (§13).
func customerPayment(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (*customers.Transaction, error) {
	var payload CustomerPaymentPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	line := payload.Payment
	transactionID, err := customers.ParseTransactionID(line.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	customerID, err := customers.ParseID(line.CustomerID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	accountID, err := finance.ParseAccountID(line.AccountID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	if line.AmountMinor <= 0 {
		return nil, fmt.Errorf("%w: a payment of %d is not money changing hands",
			sync.ErrInvalidPayload, line.AmountMinor)
	}
	amount, err := money.New(-line.AmountMinor, money.XAF)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	occurredAt, err := saleMoment(line.OccurredAt, envelope.OccurredAt)
	if err != nil {
		return nil, err
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: the payment claims to have happened in the future",
			sync.ErrInvalidPayload)
	}

	branchID, _ := scope.Branch()
	payment, err := customers.RecordTransaction(customers.TransactionSnapshot{
		ID:         transactionID,
		CustomerID: customerID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		Type:       customers.Payment,
		Amount:     amount,
		AccountID:  accountID,
		// The ledger keeps one free-text column, and a payment's note belongs
		// in it: "acompte", "payé par son fils" is what makes a statement
		// readable months later (§13, §39).
		Reason:     line.Note,
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: occurredAt,
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return payment, nil
}
