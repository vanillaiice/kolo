package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// CashMovedPayload is the body of a CASH_MOVED event (ADR-006).
//
// One event carries one or more movements, because a transfer is two: money
// leaving one account and arriving in another. They travel together because
// they happened together, and half a transfer is money genuinely lost.
type CashMovedPayload struct {
	Movements []CashMovementPayload `json:"movements"`
}

// CashMovementPayload is one movement of money as a device describes it.
//
// It carries no business, branch, user, or device: all four come from the
// authenticated envelope (ADR-008). No currency either — everything is XAF
// (§46).
type CashMovementPayload struct {
	// ID is the movement's own identifier, drawn by the device. It is what makes
	// a resent movement a duplicate rather than a second withdrawal (§27).
	ID        string `json:"id"`
	AccountID string `json:"account_id"`
	Type      string `json:"type"`
	// AmountMinor is signed as it will be stored: positive puts money in,
	// negative takes it out. The sign is checked against the type rather than
	// corrected, because a withdrawal that read as a deposit would make a drawer
	// look full that is empty.
	AmountMinor int64 `json:"amount_minor"`
	// CounterpartID is the other account in a transfer, and absent otherwise.
	CounterpartID string `json:"counterpart_id,omitempty"`
	Reason        string `json:"reason,omitempty"`
	OccurredAt    string `json:"occurred_at,omitempty"`
}

// cashMovements reads a CASH_MOVED payload into domain movements.
func cashMovements(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) ([]*finance.Movement, error) {
	var payload CashMovedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	if len(payload.Movements) == 0 {
		return nil, fmt.Errorf("%w: an event that moved no money", sync.ErrInvalidPayload)
	}

	movements := make([]*finance.Movement, 0, len(payload.Movements))
	for i, line := range payload.Movements {
		movement, err := line.toMovement(scope, envelope, recordedAt)
		if err != nil {
			return nil, fmt.Errorf("movement %d: %w", i, err)
		}
		movements = append(movements, movement)
	}
	return movements, nil
}

func (m CashMovementPayload) toMovement(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (*finance.Movement, error) {
	movementID, err := finance.ParseMovementID(m.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	accountID, err := finance.ParseAccountID(m.AccountID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	movementType, err := finance.ParseMovementType(m.Type)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	counterpartID := finance.AccountID{}
	if m.CounterpartID != "" {
		counterpartID, err = finance.ParseAccountID(m.CounterpartID)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
		}
	}

	amount, err := money.New(m.AmountMinor, money.XAF)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	occurredAt, err := saleMoment(m.OccurredAt, envelope.OccurredAt)
	if err != nil {
		return nil, err
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: the money claims to have moved in the future",
			sync.ErrInvalidPayload)
	}

	branchID, _ := scope.Branch()
	movement, err := finance.RecordMovement(finance.MovementSnapshot{
		ID:            movementID,
		AccountID:     accountID,
		BusinessID:    scope.Business(),
		BranchID:      branchID,
		Type:          movementType,
		Amount:        amount,
		CounterpartID: counterpartID,
		Reason:        m.Reason,
		UserID:        envelope.UserID,
		DeviceID:      envelope.DeviceID,
		OccurredAt:    occurredAt,
		RecordedAt:    recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return movement, nil
}
