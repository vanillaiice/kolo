package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// SupplierSavedPayload is the body of a SUPPLIER_SAVED event (ADR-006).
//
// One event carries one wholesaler. A shopkeeper who wrote down a delivery
// driver's new number made one edit, not two.
type SupplierSavedPayload struct {
	Supplier SupplierPayload `json:"supplier"`
}

// SupplierPayload is a wholesaler as a device describes it.
//
// It carries no business: the tenant comes from the authenticated envelope
// (ADR-008). It carries no balance either, and could not — what the business
// owes a supplier is the sum of their ledger, and a device that could send a
// figure could send one no delivery accounts for (§16, §59).
type SupplierPayload struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Phone   string `json:"phone,omitempty"`
	Address string `json:"address,omitempty"`
	// Contact is the person to ask for, which for a wholesaler is not the
	// business's name and is what a shopkeeper actually remembers (§14).
	Contact string `json:"contact,omitempty"`
	Notes   string `json:"notes,omitempty"`
	// Active absent means active. A device that has never sent the field is not
	// saying the shop has stopped buying from them.
	Active    *bool  `json:"active,omitempty"`
	CreatedAt string `json:"created_at"`
	// UpdatedAt is when the shopkeeper made this edit, on their own clock. It
	// decides which of two conflicting edits wins, so it is the device's time
	// and deliberately not the server's: an edit made on Monday and synced on
	// Friday must not beat one made on Wednesday (ADR-015).
	UpdatedAt string `json:"updated_at"`
}

// savedSupplier reads a SUPPLIER_SAVED payload into a domain supplier.
//
// The device that made the edit comes from the envelope and becomes the
// supplier's UpdatedByDevice, which is what breaks a tie between two edits
// stamped the same instant. Taking it from the envelope rather than the payload
// means a device cannot nominate itself the winner by claiming to be another.
func savedSupplier(
	scope business.Scope, envelope sync.Envelope,
) (*suppliers.Supplier, error) {
	var payload SupplierSavedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	line := payload.Supplier
	supplierID, err := suppliers.ParseID(line.ID)
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

	createdAt, err := moment(line.CreatedAt, "supplier", "created_at")
	if err != nil {
		return nil, err
	}
	updatedAt, err := moment(line.UpdatedAt, "supplier", "updated_at")
	if err != nil {
		return nil, err
	}

	active := true
	if line.Active != nil {
		active = *line.Active
	}

	// Restore rather than New: this is a wholesaler who already exists on
	// another device, with their own timestamps, not one being created here.
	// New would stamp them with this moment and lose the ordering a conflict
	// depends on.
	supplier, err := suppliers.Restore(suppliers.Snapshot{
		ID:              supplierID,
		BusinessID:      scope.Business(),
		Name:            line.Name,
		Phone:           number,
		Address:         line.Address,
		Contact:         line.Contact,
		Notes:           line.Notes,
		Active:          active,
		UpdatedByDevice: envelope.DeviceID,
		CreatedAt:       createdAt,
		UpdatedAt:       updatedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return supplier, nil
}
