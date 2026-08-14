package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// RecordWithMovements stores an event and the stock movements it describes, in
// one transaction.
//
// This has to be atomic, and the reason is easy to miss. If the event were
// recorded and the movements written separately, a failure between them would
// leave the event marked as received — so the device is told "accepted", stops
// resending, and the stock it recorded never reaches the server. Nothing
// afterwards could detect that: the event log says the event arrived.
//
// It is the same failure ADR-014 prevents on the device, on the other side of
// the wire. There, a business write and its outbox event commit together; here,
// the event and its effects do.
//
// A replay applies nothing. The event identifier collides, the transaction
// rolls back, and the caller is told the server already had it (§27).
func (r *SyncRepository) RecordWithMovements(
	ctx context.Context,
	scope business.Scope,
	event *sync.Event,
	movements []*inventory.Movement,
) (RecordOutcome, error) {
	if err := requireScope(scope); err != nil {
		return Recorded, err
	}
	envelope := event.Envelope()
	if err := scope.Guard(envelope.BusinessID, business.BranchID{}); err != nil {
		return Recorded, err
	}
	for i, movement := range movements {
		if movement == nil {
			return Recorded, fmt.Errorf("%w: movement %d is missing", ErrQuery, i)
		}
		snapshot := movement.Snapshot()
		if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
			return Recorded, err
		}
	}

	transaction, err := r.pool.Begin(ctx)
	if err != nil {
		return Recorded, fmt.Errorf("%w: applying event: %w", ErrQuery, err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	tag, err := transaction.Exec(ctx, `
		INSERT INTO sync_events
			(event_id, business_id, device_id, user_id, type, payload,
			 occurred_at, device_sequence, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied')
		ON CONFLICT (event_id) DO NOTHING`,
		envelope.ID.ID(), envelope.BusinessID.ID(), envelope.DeviceID.ID(), envelope.UserID.ID(),
		string(envelope.Type), []byte(envelope.Payload),
		envelope.OccurredAt, envelope.DeviceSequence)
	if err != nil {
		return Recorded, wrapWrite("recording event", err)
	}

	// Already there: the movements were applied when it first arrived, so
	// nothing more is done and the transaction is abandoned.
	if tag.RowsAffected() == 0 {
		return AlreadyRecorded, nil
	}

	for i, movement := range movements {
		if err := insertMovement(ctx, transaction, movement); err != nil {
			return Recorded, fmt.Errorf("applying movement %d of event %s: %w", i, envelope.ID, err)
		}
	}

	if err := transaction.Commit(ctx); err != nil {
		return Recorded, wrapWrite("applying event", err)
	}
	return Recorded, nil
}

// insertMovement writes one movement using the given executor, so the same
// statement serves a pooled write and a transactional one.
func insertMovement(ctx context.Context, exec executor, movement *inventory.Movement) error {
	if _, err := exec.Exec(ctx, movementInsert, movementValues(movement)...); err != nil {
		return wrapWrite("appending movement", err)
	}
	return nil
}

// executor is the write surface shared by the pool and a transaction, so a
// statement need not know which it is running against.
type executor interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// ensure a transaction satisfies the executor surface.
var _ executor = (pgx.Tx)(nil)
