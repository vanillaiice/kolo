package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// CredentialRepository stores login credentials.
//
// Every method takes a business.Scope, including the lookup by phone number.
// That is what makes a number identify one person within one business rather
// than globally (ADR-012): logging in requires knowing which business is being
// logged into, and one tenant's login attempt can never reach another's staff.
type CredentialRepository struct {
	pool *pgxpool.Pool
}

// NewCredentialRepository returns a repository backed by the given pool.
func NewCredentialRepository(pool *pgxpool.Pool) *CredentialRepository {
	return &CredentialRepository{pool: pool}
}

const credentialColumns = `user_id, business_id, phone, pin_hash, created_at, updated_at`

// Create stores a new credential within the scope's business.
func (r *CredentialRepository) Create(
	ctx context.Context, scope business.Scope, record *auth.Credential,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	_, err := r.pool.Exec(ctx, `
		INSERT INTO user_credentials (`+credentialColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		snapshot.UserID.ID(), snapshot.BusinessID.ID(), snapshot.Phone.String(),
		snapshot.PIN.String(), snapshot.CreatedAt, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("creating credential", err)
	}
	return nil
}

// Get returns a user's credential.
func (r *CredentialRepository) Get(
	ctx context.Context, scope business.Scope, userID users.ID,
) (*auth.Credential, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if userID.IsZero() {
		return nil, fmt.Errorf("%w: no user identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+credentialColumns+`
		FROM user_credentials
		WHERE user_id = $1 AND business_id = $2`,
		userID.ID(), scope.Business().ID())

	return scanCredential(row)
}

// FindByPhone returns the credential registered to a number within the scope's
// business.
//
// This is the login lookup. The number is matched in its normalised E.164 form,
// so however the person typed it, it finds the same row — which is the whole
// reason the phone type normalises (ADR-012).
func (r *CredentialRepository) FindByPhone(
	ctx context.Context, scope business.Scope, number phone.Number,
) (*auth.Credential, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if number.IsZero() {
		return nil, fmt.Errorf("%w: no phone number given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+credentialColumns+`
		FROM user_credentials
		WHERE business_id = $1 AND phone = $2`,
		scope.Business().ID(), number.String())

	return scanCredential(row)
}

// Update writes a credential's current state, within the scope.
func (r *CredentialRepository) Update(
	ctx context.Context, scope business.Scope, record *auth.Credential,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	tag, err := r.pool.Exec(ctx, `
		UPDATE user_credentials
		SET phone = $3, pin_hash = $4, updated_at = $5
		WHERE user_id = $1 AND business_id = $2`,
		snapshot.UserID.ID(), snapshot.BusinessID.ID(),
		snapshot.Phone.String(), snapshot.PIN.String(), snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("updating credential", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: credential for user %s", ErrNotFound, snapshot.UserID)
	}
	return nil
}

func scanCredential(row pgx.Row) (*auth.Credential, error) {
	var (
		snapshot          auth.CredentialSnapshot
		rawUser, rawOwner uuid.UUID
		rawPhone, rawPIN  string
	)
	err := row.Scan(&rawUser, &rawOwner, &rawPhone, &rawPIN,
		&snapshot.CreatedAt, &snapshot.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading credential: %w", ErrQuery, err)
	}

	number, err := phone.Parse(rawPhone)
	if err != nil {
		return nil, fmt.Errorf("%w: credential for user %s: %w", ErrQuery, rawUser, err)
	}
	pin, err := auth.RestorePINHash(rawPIN)
	if err != nil {
		return nil, fmt.Errorf("%w: credential for user %s: %w", ErrQuery, rawUser, err)
	}

	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	snapshot.Phone = number
	snapshot.PIN = pin

	return auth.RestoreCredential(snapshot)
}
