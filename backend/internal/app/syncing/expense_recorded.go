package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/expenses"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// ExpenseRecordedPayload is the body of an EXPENSE_RECORDED event (ADR-006).
//
// One event carries one expense. A reversal is another expense, and travels as
// its own event: it happened later, and a device that recorded the cost on
// Monday and corrected it on Friday made two decisions, not one.
type ExpenseRecordedPayload struct {
	Expense ExpensePayload `json:"expense"`
}

// ExpensePayload is one expense as a device describes it.
type ExpensePayload struct {
	ID        string `json:"id"`
	Category  string `json:"category"`
	AccountID string `json:"account_id"`
	// AmountMinor is positive for a cost and negative for a reversal, signed as
	// it will be stored so that summing expenses is plain addition.
	AmountMinor int64  `json:"amount_minor"`
	Description string `json:"description,omitempty"`
	Reference   string `json:"reference,omitempty"`
	// ReversesID names the expense this one undoes, and is absent on a cost.
	ReversesID string `json:"reverses_id,omitempty"`
	OccurredAt string `json:"occurred_at,omitempty"`
}

// recordedExpense reads an EXPENSE_RECORDED payload into a domain expense.
func recordedExpense(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (*expenses.Expense, error) {
	var payload ExpenseRecordedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	line := payload.Expense
	expenseID, err := expenses.ParseID(line.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	category, err := expenses.ParseCategory(line.Category)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	accountID, err := finance.ParseAccountID(line.AccountID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	reverses := expenses.ID{}
	if line.ReversesID != "" {
		reverses, err = expenses.ParseID(line.ReversesID)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
		}
	}

	amount, err := money.New(line.AmountMinor, money.XAF)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	occurredAt, err := saleMoment(line.OccurredAt, envelope.OccurredAt)
	if err != nil {
		return nil, err
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: the money claims to have been spent in the future",
			sync.ErrInvalidPayload)
	}

	branchID, _ := scope.Branch()
	expense, err := expenses.Record(expenses.Snapshot{
		ID:          expenseID,
		BusinessID:  scope.Business(),
		BranchID:    branchID,
		Category:    category,
		AccountID:   accountID,
		Amount:      amount,
		Description: line.Description,
		Reference:   line.Reference,
		Reverses:    reverses,
		UserID:      envelope.UserID,
		DeviceID:    envelope.DeviceID,
		OccurredAt:  occurredAt,
		RecordedAt:  recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return expense, nil
}
