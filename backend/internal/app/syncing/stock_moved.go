package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// StockMovedPayload is the body of a STOCK_MOVED event (ADR-006).
//
// These field names are the wire contract with the client. Renaming one is a
// protocol change, not a refactor: a device that has been offline for a fortnight
// is still sending the old spelling, and §45 says that device must be able to
// catch up rather than be told its backlog is unreadable.
type StockMovedPayload struct {
	Movements []MovementPayload `json:"movements"`
}

// MovementPayload is one stock movement as a device describes it.
//
// It carries no business identifier. The tenant comes from the authenticated
// envelope, so a device cannot write into another business's ledger by saying so
// in a payload (ADR-008).
type MovementPayload struct {
	ID            string     `json:"id"`
	ProductID     string     `json:"product_id"`
	Type          string     `json:"type"`
	Quantity      int64      `json:"quantity"`
	UnitCostMinor *int64     `json:"unit_cost_minor,omitempty"`
	ReferenceKind string     `json:"reference_kind,omitempty"`
	ReferenceID   string     `json:"reference_id,omitempty"`
	Reason        string     `json:"reason,omitempty"`
	OccurredAt    *time.Time `json:"occurred_at,omitempty"`
}

// stockMovements reads a STOCK_MOVED payload into domain movements.
//
// The identity of every movement — which business, which branch, which device,
// which user — is taken from the envelope rather than from the payload. The
// envelope has already been checked against the caller's scope, so a movement
// built from it cannot land in another tenant's ledger however the payload is
// written.
//
// The movement's own identifier does come from the payload, and must: it is what
// makes a replay a duplicate rather than a second sale (§27). A device that
// resends its backlog resends the same movement identifiers, and the ledger's
// primary key refuses the second copy.
func stockMovements(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) ([]*inventory.Movement, error) {
	var payload StockMovedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	// Unknown fields are refused rather than ignored, which is the opposite of
	// how an unknown event type is treated a few lines above the call to this.
	// The difference is whether ignoring risks a half-applied fact: an event
	// type this build cannot apply is filed and passed on untouched, whereas a
	// field inside a payload it does apply might be the very thing that changes
	// what the movement means. Dropping that would write a subtly wrong ledger
	// entry and report success, which is worse than refusing it.
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	if len(payload.Movements) == 0 {
		return nil, fmt.Errorf("%w: a stock event that moves no stock", sync.ErrInvalidPayload)
	}

	movements := make([]*inventory.Movement, 0, len(payload.Movements))
	for i, line := range payload.Movements {
		movement, err := line.toMovement(scope, envelope, recordedAt)
		if err != nil {
			return nil, fmt.Errorf("movement %d: %w", i, err)
		}
		movements = append(movements, movement)
	}
	return movements, nil
}

func (m MovementPayload) toMovement(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (*inventory.Movement, error) {
	movementID, err := inventory.ParseMovementID(m.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	productID, err := products.ParseID(m.ProductID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	unitCost := money.Money{}
	if m.UnitCostMinor != nil {
		// XAF is fixed here rather than read from the payload. §46 says the
		// system is XAF, and a device announcing another currency would be
		// putting two currencies in one ledger where nothing adds them up.
		unitCost, err = money.New(*m.UnitCostMinor, money.XAF)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
		}
	}

	// A device's clock can be wrong, and there is no fixing that from here. What
	// the server can refuse is a movement claiming to have happened after the
	// moment it arrived, which no offline backlog ever legitimately does.
	occurredAt := envelope.OccurredAt
	if m.OccurredAt != nil {
		occurredAt = *m.OccurredAt
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: it claims to have happened in the future", sync.ErrInvalidPayload)
	}

	// A branch-scoped caller writes into its branch; an unscoped one writes at
	// the business level. Either way the branch comes from the scope, never from
	// the payload.
	branchID, _ := scope.Branch()

	movement, err := inventory.Record(inventory.Snapshot{
		ID:         movementID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		ProductID:  productID,
		Type:       inventory.MovementType(m.Type),
		Quantity:   quantity.FromThousandths(m.Quantity),
		UnitCost:   unitCost,
		Reference:  inventory.Reference{Kind: m.ReferenceKind, ID: m.ReferenceID},
		Reason:     m.Reason,
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: occurredAt,
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return movement, nil
}
