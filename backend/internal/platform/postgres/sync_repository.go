package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

// SyncRepository stores the events devices have sent.
//
// This is where idempotency lives. The event identifier is the primary key, so
// a replay after an unacknowledged push collides rather than being applied a
// second time (§27, ADR-006) — and the collision is detected by the database,
// not by a read-then-write that two concurrent pushes could both pass.
type SyncRepository struct {
	pool *pgxpool.Pool
}

// NewSyncRepository returns a repository backed by the given pool.
func NewSyncRepository(pool *pgxpool.Pool) *SyncRepository {
	return &SyncRepository{pool: pool}
}

// RecordOutcome says what happened to one event.
type RecordOutcome int

const (
	// Recorded means the event was new and has been stored.
	Recorded RecordOutcome = iota
	// AlreadyRecorded means the server had already seen it. This is a success,
	// not a failure: it is exactly what a retried push should produce.
	AlreadyRecorded
)

// StoredEvent is an event as the server holds it, with the ordering it assigned.
type StoredEvent struct {
	Event *sync.Event
	// ServerSequence is the cursor a pull resumes from.
	ServerSequence  int64
	ReceivedAt      time.Time
	Rejected        bool
	RejectionReason string
}

const syncEventColumns = `event_id, business_id, device_id, user_id, type, payload,
	occurred_at, device_sequence, server_sequence, received_at, status, rejection_reason`

// Record stores an event, reporting whether it was new.
//
// A duplicate is not an error. A device that pushed and never saw the response
// will push again, and telling it the event failed would make it retry forever
// or, worse, give up on data it holds and the server has.
func (r *SyncRepository) Record(
	ctx context.Context, scope business.Scope, event *sync.Event,
) (RecordOutcome, error) {
	if err := requireScope(scope); err != nil {
		return Recorded, err
	}
	envelope := event.Envelope()
	if err := scope.Guard(envelope.BusinessID, business.BranchID{}); err != nil {
		return Recorded, err
	}

	tag, err := r.pool.Exec(ctx, `
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

	// ON CONFLICT DO NOTHING reports zero rows when the event was already
	// there, which is how a replay is recognised without a separate read that
	// two concurrent pushes could both pass.
	if tag.RowsAffected() == 0 {
		return AlreadyRecorded, nil
	}
	return Recorded, nil
}

// Reject stores an event the server could not make sense of.
//
// The event is kept rather than dropped: the device still holds the business
// record it describes, and someone has to be able to see why it did not land.
// A rejection is also idempotent, for the same reason a record is.
func (r *SyncRepository) Reject(
	ctx context.Context, scope business.Scope, envelope sync.Envelope, reason string,
) (RecordOutcome, error) {
	if err := requireScope(scope); err != nil {
		return Recorded, err
	}
	if err := scope.Guard(envelope.BusinessID, business.BranchID{}); err != nil {
		return Recorded, err
	}
	if reason == "" {
		return Recorded, fmt.Errorf("%w: a rejection needs a reason", ErrQuery)
	}

	payload := envelope.Payload
	if len(payload) == 0 {
		// A payload that could not be read is why some events are rejected, and
		// the column is NOT NULL.
		payload = json.RawMessage(`{}`)
	}

	tag, err := r.pool.Exec(ctx, `
		INSERT INTO sync_events
			(event_id, business_id, device_id, user_id, type, payload,
			 occurred_at, device_sequence, status, rejection_reason)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rejected', $9)
		ON CONFLICT (event_id) DO NOTHING`,
		envelope.ID.ID(), envelope.BusinessID.ID(), envelope.DeviceID.ID(), envelope.UserID.ID(),
		string(envelope.Type), []byte(payload),
		envelope.OccurredAt, envelope.DeviceSequence, truncateReason(reason))
	if err != nil {
		return Recorded, wrapWrite("rejecting event", err)
	}
	if tag.RowsAffected() == 0 {
		return AlreadyRecorded, nil
	}
	return Recorded, nil
}

// Since returns the events a business has accumulated past a cursor, oldest
// first, up to a limit.
//
// excludeDevice leaves out the caller's own events. A device already has what
// it sent, and sending them back would make every push produce a pull of the
// same size — which on a metered link is paying twice for nothing (§45).
func (r *SyncRepository) Since(
	ctx context.Context,
	scope business.Scope,
	cursor int64,
	excludeDevice devices.ID,
	limit int,
) ([]StoredEvent, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, fmt.Errorf("%w: a batch must be positive, got %d", ErrQuery, limit)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+syncEventColumns+`
		FROM sync_events
		WHERE business_id = $1
		  AND server_sequence > $2
		  AND status = 'applied'
		  AND ($3::uuid IS NULL OR device_id <> $3)
		ORDER BY server_sequence
		LIMIT $4`,
		scope.Business().ID(), cursor, optionalDevice(excludeDevice), limit)
	if err != nil {
		return nil, fmt.Errorf("%w: pulling events: %w", ErrQuery, err)
	}
	defer rows.Close()

	events := make([]StoredEvent, 0)
	for rows.Next() {
		stored, err := scanStoredEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, stored)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: pulling events: %w", ErrQuery, err)
	}
	return events, nil
}

// LatestSequence returns the newest cursor a business has reached.
//
// A pull that returns nothing still advances the caller's cursor to here, so a
// device that has only ever seen other businesses' traffic does not re-scan the
// same rows on every attempt.
func (r *SyncRepository) LatestSequence(ctx context.Context, scope business.Scope) (int64, error) {
	if err := requireScope(scope); err != nil {
		return 0, err
	}

	var latest *int64
	err := r.pool.QueryRow(ctx,
		`SELECT max(server_sequence) FROM sync_events WHERE business_id = $1`,
		scope.Business().ID()).Scan(&latest)
	if err != nil {
		return 0, fmt.Errorf("%w: reading the latest cursor: %w", ErrQuery, err)
	}
	if latest == nil {
		return 0, nil
	}
	return *latest, nil
}

// Get returns one event by identifier, which is how a device asks whether
// something it is unsure about actually landed.
func (r *SyncRepository) Get(
	ctx context.Context, scope business.Scope, eventID sync.EventID,
) (StoredEvent, error) {
	if err := requireScope(scope); err != nil {
		return StoredEvent{}, err
	}
	if eventID.IsZero() {
		return StoredEvent{}, fmt.Errorf("%w: no event identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+syncEventColumns+`
		FROM sync_events
		WHERE event_id = $1 AND business_id = $2`,
		eventID.ID(), scope.Business().ID())
	return scanStoredEvent(row)
}

// Rejected returns the events the server refused, newest first, for someone to
// look at.
func (r *SyncRepository) Rejected(
	ctx context.Context, scope business.Scope, limit int,
) ([]StoredEvent, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, fmt.Errorf("%w: a batch must be positive, got %d", ErrQuery, limit)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+syncEventColumns+`
		FROM sync_events
		WHERE business_id = $1 AND status = 'rejected'
		ORDER BY received_at DESC
		LIMIT $2`,
		scope.Business().ID(), limit)
	if err != nil {
		return nil, fmt.Errorf("%w: listing rejected events: %w", ErrQuery, err)
	}
	defer rows.Close()

	events := make([]StoredEvent, 0)
	for rows.Next() {
		stored, err := scanStoredEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, stored)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing rejected events: %w", ErrQuery, err)
	}
	return events, nil
}

func scanStoredEvent(row pgx.Row) (StoredEvent, error) {
	var (
		envelope           sync.Envelope
		rawID, rawOwner    uuid.UUID
		rawDevice, rawUser uuid.UUID
		eventType          string
		payload            []byte
		serverSequence     int64
		receivedAt         time.Time
		status             string
		rejectionReason    *string
	)
	err := row.Scan(&rawID, &rawOwner, &rawDevice, &rawUser, &eventType, &payload,
		&envelope.OccurredAt, &envelope.DeviceSequence, &serverSequence, &receivedAt,
		&status, &rejectionReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return StoredEvent{}, ErrNotFound
	}
	if err != nil {
		return StoredEvent{}, fmt.Errorf("%w: reading event: %w", ErrQuery, err)
	}

	envelope.ID = sync.EventIDFrom(rawID)
	envelope.BusinessID = business.IDFrom(rawOwner)
	envelope.DeviceID = devices.IDFrom(rawDevice)
	envelope.UserID = users.IDFrom(rawUser)
	envelope.Type = sync.Type(eventType)
	envelope.Payload = json.RawMessage(payload)

	// Restore rather than New: a stored event may carry a type an older build
	// accepted and this one no longer knows, and refusing to read it would make
	// the whole pull fail for every device.
	event, err := sync.Restore(envelope)
	if err != nil {
		return StoredEvent{}, fmt.Errorf("%w: event %s: %w", ErrQuery, rawID, err)
	}

	stored := StoredEvent{
		Event:          event,
		ServerSequence: serverSequence,
		ReceivedAt:     receivedAt.UTC(),
		Rejected:       status == "rejected",
	}
	if rejectionReason != nil {
		stored.RejectionReason = *rejectionReason
	}
	return stored, nil
}

func optionalDevice(deviceID devices.ID) *uuid.UUID {
	if deviceID.IsZero() {
		return nil
	}
	value := deviceID.ID()
	return &value
}

// truncateReason keeps a runaway message from filling a column.
func truncateReason(reason string) string {
	const limit = 500
	if len(reason) <= limit {
		return reason
	}
	return reason[:limit] + "…"
}

// IsForeignKeyViolation reports whether an error is the database refusing a
// reference — an event naming a device or user that does not exist here.
//
// The sync service treats that as a rejection of one event rather than a
// failure of the whole push, since the rest of the batch is unaffected.
func IsForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23503" || pgErr.Code == "23001"
}
