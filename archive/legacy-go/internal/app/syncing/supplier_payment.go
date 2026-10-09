package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// SupplierPaymentPayload is the body of a SUPPLIER_PAYMENT event (ADR-006).
//
// Settling a wholesaler's account is not about any one delivery, the mirror of
// what §13 says about a customer's tab: a shopkeeper hands over 50,000 against
// a bill built from a month of deliveries, and asking which of them it pays off
// would invent a question the shop does not ask.
type SupplierPaymentPayload struct {
	Payment SupplierPaymentLine `json:"payment"`
}

// SupplierPaymentLine is one payment as a device describes it.
type SupplierPaymentLine struct {
	// ID is the ledger entry's own identifier, drawn by the device. It is what
	// makes a resent payment one entry rather than two (§27).
	ID         string `json:"id"`
	SupplierID string `json:"supplier_id"`
	// AccountID is where the money came from, and is required. This is what
	// makes the drawer fall by what was handed over (§18): a payment naming no
	// account would leave the shop poorer with no till any lighter.
	AccountID string `json:"account_id"`
	// AmountMinor is what was handed over, positive. The ledger stores it
	// negative, because a payment reduces what is owed — the sign is the
	// server's to apply, so a device cannot record a payment that increases a
	// bill.
	AmountMinor int64  `json:"amount_minor"`
	Note        string `json:"note,omitempty"`
	OccurredAt  string `json:"occurred_at"`
}

// supplierPayment reads a SUPPLIER_PAYMENT payload into a ledger entry.
//
// Nothing about the balance is checked here, deliberately. Paying more than is
// owed leaves the business in credit, which is the honest answer; refusing it
// would refuse a payment the shopkeeper has already made (§16).
func supplierPayment(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (*suppliers.Transaction, error) {
	var payload SupplierPaymentPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	line := payload.Payment
	transactionID, err := suppliers.ParseTransactionID(line.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	supplierID, err := suppliers.ParseID(line.SupplierID)
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
	payment, err := suppliers.RecordTransaction(suppliers.TransactionSnapshot{
		ID:         transactionID,
		SupplierID: supplierID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		Type:       suppliers.Payment,
		Amount:     amount,
		AccountID:  accountID,
		// The ledger keeps one free-text column, and a payment's note belongs
		// in it: "acompte sur la facture 118" is what makes a statement
		// readable months later (§16, §39).
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
