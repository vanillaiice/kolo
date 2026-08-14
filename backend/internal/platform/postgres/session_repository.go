package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

// SessionRepository stores the sessions devices hold.
type SessionRepository struct {
	pool *pgxpool.Pool
}

// NewSessionRepository returns a repository backed by the given pool.
func NewSessionRepository(pool *pgxpool.Pool) *SessionRepository {
	return &SessionRepository{pool: pool}
}

const sessionColumns = `id, user_id, business_id, device_id, token_hash, issued_at, expires_at, last_seen_at, revoked_at`

// Create stores a newly issued session.
func (r *SessionRepository) Create(ctx context.Context, scope business.Scope, record *auth.Session) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	_, err := r.pool.Exec(ctx, `
		INSERT INTO sessions (`+sessionColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		snapshot.ID.ID(), snapshot.UserID.ID(), snapshot.BusinessID.ID(), snapshot.DeviceID.ID(),
		snapshot.TokenHash.String(), snapshot.IssuedAt, snapshot.ExpiresAt,
		snapshot.LastSeenAt, optionalTime(snapshot.RevokedAt))
	if err != nil {
		return wrapWrite("creating session", err)
	}
	return nil
}

// Get returns a session by identifier, within the scope.
func (r *SessionRepository) Get(
	ctx context.Context, scope business.Scope, sessionID auth.SessionID,
) (*auth.Session, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if sessionID.IsZero() {
		return nil, fmt.Errorf("%w: no session identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+sessionColumns+`
		FROM sessions
		WHERE id = $1 AND business_id = $2`,
		sessionID.ID(), scope.Business().ID())

	return scanSession(row)
}

// FindByToken returns the session a token belongs to.
//
// This is the lookup every authenticated request makes, and it is deliberately
// **not** scoped: a request arrives carrying only a token, so the tenant is
// what this call discovers rather than something the caller already knows.
// Everything downstream is then scoped by the session's own business, which is
// where the boundary is re-established.
//
// The token is matched by its hash, so the token itself never reaches a query
// or a query log.
func (r *SessionRepository) FindByToken(ctx context.Context, token auth.Token) (*auth.Session, error) {
	if token.IsZero() {
		return nil, fmt.Errorf("%w: no token given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+sessionColumns+`
		FROM sessions
		WHERE token_hash = $1`, token.Hash().String())

	return scanSession(row)
}

// Update writes a session's current state, within the scope.
//
// Only the mutable fields are written. The token is not among them: renewing
// extends a session rather than reissuing it, so the device keeps the
// credential it already holds.
func (r *SessionRepository) Update(ctx context.Context, scope business.Scope, record *auth.Session) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	tag, err := r.pool.Exec(ctx, `
		UPDATE sessions
		SET expires_at = $3, last_seen_at = $4, revoked_at = $5
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(),
		snapshot.ExpiresAt, snapshot.LastSeenAt, optionalTime(snapshot.RevokedAt))
	if err != nil {
		return wrapWrite("updating session", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: session %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

// RevokeAllForUser ends every live session a user holds, returning how many it
// ended.
//
// This is what suspending someone does on the server side. It cannot reach a
// device that is offline — that device keeps working until it next syncs, which
// ADR-012 states plainly — but it stops anything that reaches the server.
func (r *SessionRepository) RevokeAllForUser(
	ctx context.Context, scope business.Scope, userID users.ID, at time.Time,
) (int64, error) {
	return r.revokeAll(ctx, scope, `user_id = $2`, userID.ID(), at)
}

// RevokeAllForDevice ends every live session held on a device, returning how
// many it ended. This is what happens when a device is reported lost.
func (r *SessionRepository) RevokeAllForDevice(
	ctx context.Context, scope business.Scope, deviceID devices.ID, at time.Time,
) (int64, error) {
	return r.revokeAll(ctx, scope, `device_id = $2`, deviceID.ID(), at)
}

func (r *SessionRepository) revokeAll(
	ctx context.Context, scope business.Scope, predicate string, subject uuid.UUID, at time.Time,
) (int64, error) {
	if err := requireScope(scope); err != nil {
		return 0, err
	}
	if at.IsZero() {
		return 0, fmt.Errorf("%w: revocation time is unset", auth.ErrInvalidTime)
	}
	if subject == uuid.Nil {
		return 0, fmt.Errorf("%w: nothing to revoke", ErrNotFound)
	}

	// Already-revoked sessions are left alone, so the recorded time stays the
	// moment each session actually ended.
	tag, err := r.pool.Exec(ctx, `
		UPDATE sessions
		SET revoked_at = $3
		WHERE business_id = $1 AND `+predicate+` AND revoked_at IS NULL`,
		scope.Business().ID(), subject, at.UTC())
	if err != nil {
		return 0, wrapWrite("revoking sessions", err)
	}
	return tag.RowsAffected(), nil
}

// DeleteExpired removes sessions that lapsed before the given moment,
// returning how many it removed.
//
// Sessions are the one thing here that is genuinely disposable. They are not
// financial history: an expired session records nothing about what a business
// did, only that someone was once logged in, and keeping them forever would
// grow a table nobody reads. Revoked sessions are kept until they also expire,
// so the record of a deliberate ending survives long enough to be audited.
func (r *SessionRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	if before.IsZero() {
		return 0, fmt.Errorf("%w: cutoff is unset", auth.ErrInvalidTime)
	}

	tag, err := r.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < $1`, before.UTC())
	if err != nil {
		return 0, wrapWrite("deleting expired sessions", err)
	}
	return tag.RowsAffected(), nil
}

func scanSession(row pgx.Row) (*auth.Session, error) {
	var (
		snapshot                            auth.SessionSnapshot
		rawID, rawUser, rawOwner, rawDevice uuid.UUID
		rawToken                            string
		revokedAt                           *time.Time
	)
	err := row.Scan(&rawID, &rawUser, &rawOwner, &rawDevice, &rawToken,
		&snapshot.IssuedAt, &snapshot.ExpiresAt, &snapshot.LastSeenAt, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading session: %w", ErrQuery, err)
	}

	tokenHash, err := auth.RestoreTokenHash(rawToken)
	if err != nil {
		return nil, fmt.Errorf("%w: session %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = auth.SessionIDFrom(rawID)
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	snapshot.DeviceID = devices.IDFrom(rawDevice)
	snapshot.TokenHash = tokenHash
	if revokedAt != nil {
		snapshot.RevokedAt = *revokedAt
	}

	return auth.RestoreSession(snapshot)
}

// optionalTime renders an unset time as SQL NULL, so "never revoked" is absence
// rather than a date at the beginning of time.
func optionalTime(at time.Time) *time.Time {
	if at.IsZero() {
		return nil
	}
	value := at.UTC()
	return &value
}
