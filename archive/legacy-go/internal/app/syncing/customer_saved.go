package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// CustomerSavedPayload is the body of a CUSTOMER_SAVED event (ADR-006).
//
// One event carries one customer. A shopkeeper who corrected a name and a phone
// number made one edit, not two.
type CustomerSavedPayload struct {
	Customer CustomerPayload `json:"customer"`
}

// CustomerPayload is a customer as a device describes it.
//
// It carries no business: the tenant comes from the authenticated envelope
// (ADR-008). It carries no balance either, and cannot — what a customer owes is
// the sum of their ledger, and a device that could send a balance could send a
// wrong one that no transaction accounts for (§13, §59).
type CustomerPayload struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Phone   string `json:"phone,omitempty"`
	Address string `json:"address,omitempty"`
	Notes   string `json:"notes,omitempty"`
	// CreditLimitMinor is how much this customer may owe at once, and is absent
	// when no limit has been set.
	//
	// A pointer because absent and zero are different answers: absent means the
	// shopkeeper has not decided, zero means this customer may not have credit.
	// Collapsing them would either refuse every regular who has never been
	// given a limit, or extend unlimited credit to someone deliberately cut off.
	CreditLimitMinor *int64 `json:"credit_limit_minor,omitempty"`
	// Active absent means active. A device that has never sent the field is not
	// saying the customer has been closed.
	Active    *bool  `json:"active,omitempty"`
	CreatedAt string `json:"created_at"`
	// UpdatedAt is when the shopkeeper made this edit, on their own clock. It
	// decides which of two conflicting edits wins, so it is the device's time
	// and deliberately not the server's: an edit made on Monday and synced on
	// Friday must not beat one made on Wednesday (ADR-015).
	UpdatedAt string `json:"updated_at"`
}

// savedCustomer reads a CUSTOMER_SAVED payload into a domain customer.
//
// The device that made the edit comes from the envelope and becomes the
// customer's UpdatedByDevice, which is what breaks a tie between two edits
// stamped the same instant. Taking it from the envelope rather than the payload
// means a device cannot nominate itself the winner by claiming to be another.
func savedCustomer(
	scope business.Scope, envelope sync.Envelope,
) (*customers.Customer, error) {
	var payload CustomerSavedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	line := payload.Customer
	customerID, err := customers.ParseID(line.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	number := phone.Number{}
	if line.Phone != "" {
		// Parsed rather than stored as sent: the stored form is E.164, which is
		// what makes a number typed locally on one device match the same number
		// typed internationally on another (ADR-012).
		number, err = phone.Parse(line.Phone)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
		}
	}

	creditLimit := money.Money{}
	if line.CreditLimitMinor != nil {
		creditLimit, err = money.New(*line.CreditLimitMinor, money.XAF)
		if err != nil {
			return nil, fmt.Errorf("%w: credit limit: %w", sync.ErrInvalidPayload, err)
		}
	}

	createdAt, err := moment(line.CreatedAt, "customer", "created_at")
	if err != nil {
		return nil, err
	}
	updatedAt, err := moment(line.UpdatedAt, "customer", "updated_at")
	if err != nil {
		return nil, err
	}

	active := true
	if line.Active != nil {
		active = *line.Active
	}

	// Restore rather than New: this is a customer who already exists on another
	// device, with their own timestamps, not one being created here. New would
	// stamp them with this moment and lose the ordering a conflict depends on.
	customer, err := customers.Restore(customers.Snapshot{
		ID:              customerID,
		BusinessID:      scope.Business(),
		Name:            line.Name,
		Phone:           number,
		Address:         line.Address,
		Notes:           line.Notes,
		CreditLimit:     creditLimit,
		Active:          active,
		UpdatedByDevice: envelope.DeviceID,
		CreatedAt:       createdAt,
		UpdatedAt:       updatedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return customer, nil
}
