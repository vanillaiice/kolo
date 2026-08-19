package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// AccountSavedPayload is the body of an ACCOUNT_SAVED event (ADR-006).
//
// One event carries one account. This is what makes adding Orange Money a row
// rather than a release (§10): a shopkeeper opens the account on their phone and
// every till has it after the next sync.
type AccountSavedPayload struct {
	Account AccountPayload `json:"account"`
}

// AccountPayload is a financial account as a device describes it.
//
// It carries no balance and could not: what an account holds is the sum of what
// moved through it, and §18 compares that derived figure against the drawer. A
// balance on the wire would be the number being checked and the number checking
// (§59).
type AccountPayload struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Kind is how the system reasons about the account, never which provider it
	// belongs to — that is the name.
	Kind   string `json:"kind"`
	Number string `json:"number,omitempty"`
	Notes  string `json:"notes,omitempty"`
	// Active absent means active, which is what an account is opened as.
	Active    *bool  `json:"active,omitempty"`
	CreatedAt string `json:"created_at"`
	// UpdatedAt is the device's own edit time, which decides which of two
	// conflicting edits wins (ADR-015).
	UpdatedAt string `json:"updated_at"`
}

// savedAccount reads an ACCOUNT_SAVED payload into a domain account.
//
// The currency is not on the wire: everything is XAF (§46), and a device
// announcing another would be opening an account whose transactions nothing
// could add up. The branch comes from the caller's scope, as identity always
// does (ADR-008).
func savedAccount(
	scope business.Scope, envelope sync.Envelope,
) (*finance.Account, error) {
	var payload AccountSavedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	line := payload.Account
	accountID, err := finance.ParseAccountID(line.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	kind, err := finance.ParseAccountKind(line.Kind)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	createdAt, err := moment(line.CreatedAt, "account", "created_at")
	if err != nil {
		return nil, err
	}
	updatedAt, err := moment(line.UpdatedAt, "account", "updated_at")
	if err != nil {
		return nil, err
	}

	active := true
	if line.Active != nil {
		active = *line.Active
	}

	branchID, _ := scope.Branch()
	account, err := finance.RestoreAccount(finance.AccountSnapshot{
		ID:              accountID,
		BusinessID:      scope.Business(),
		BranchID:        branchID,
		Name:            line.Name,
		Kind:            kind,
		Currency:        money.XAF,
		Number:          line.Number,
		Notes:           line.Notes,
		Active:          active,
		UpdatedByDevice: envelope.DeviceID,
		CreatedAt:       createdAt,
		UpdatedAt:       updatedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return account, nil
}
