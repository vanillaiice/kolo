package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

// UserRepository stores the people who operate a business.
//
// Every method takes a business.Scope. A user is business-owned data, so unlike
// a business itself there is no lookup that is not within a tenant.
type UserRepository struct {
	pool *pgxpool.Pool
}

// NewUserRepository returns a repository backed by the given pool.
func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
	return &UserRepository{pool: pool}
}

const userColumns = `id, business_id, branch_id, name, role, granted, revoked, active, created_at, updated_at`

// Create stores a new user within the scope's business.
func (r *UserRepository) Create(ctx context.Context, scope business.Scope, record *users.User) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
		return err
	}

	_, err := r.pool.Exec(ctx, `
		INSERT INTO users (`+userColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		snapshot.Name, string(snapshot.Role),
		permissionNames(snapshot.Granted), permissionNames(snapshot.Revoked),
		snapshot.Active, snapshot.CreatedAt, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("creating user", err)
	}
	return nil
}

// Get returns a user within the scope.
func (r *UserRepository) Get(ctx context.Context, scope business.Scope, userID users.ID) (*users.User, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if userID.IsZero() {
		return nil, fmt.Errorf("%w: no user identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+userColumns+`
		FROM users
		WHERE id = $1 AND business_id = $2`,
		userID.ID(), scope.Business().ID())

	return scanUser(row)
}

// List returns every user of the scope's business, ordered by name.
//
// A branch-scoped caller sees the users assigned to that branch, plus those
// who work across the whole business. That mirrors what such a caller can
// reach elsewhere: a branch manager needs to see head office staff exist,
// without seeing another branch's roster.
func (r *UserRepository) List(ctx context.Context, scope business.Scope) ([]*users.User, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+userColumns+`
		FROM users
		WHERE business_id = $1
		  AND ($2::uuid IS NULL OR branch_id IS NULL OR branch_id = $2)
		ORDER BY name, id`,
		scope.Business().ID(), optionalScopeBranch(scope))
	if err != nil {
		return nil, fmt.Errorf("%w: listing users: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*users.User, 0)
	for rows.Next() {
		record, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing users: %w", ErrQuery, err)
	}
	return found, nil
}

// Update writes a user's current state, within the scope.
//
// The business is not updated: a user cannot be moved between tenants, and an
// attempt to do so is a mismatch the scope guard catches rather than a change
// to apply.
func (r *UserRepository) Update(ctx context.Context, scope business.Scope, record *users.User) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
		return err
	}

	tag, err := r.pool.Exec(ctx, `
		UPDATE users
		SET branch_id = $3, name = $4, role = $5, granted = $6, revoked = $7,
		    active = $8, updated_at = $9
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		snapshot.Name, string(snapshot.Role),
		permissionNames(snapshot.Granted), permissionNames(snapshot.Revoked),
		snapshot.Active, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("updating user", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: user %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

func scanUser(row pgx.Row) (*users.User, error) {
	var (
		snapshot         users.Snapshot
		rawID, rawOwner  uuid.UUID
		rawBranch        *uuid.UUID
		role             string
		granted, revoked []string
	)
	err := row.Scan(&rawID, &rawOwner, &rawBranch, &snapshot.Name, &role,
		&granted, &revoked, &snapshot.Active, &snapshot.CreatedAt, &snapshot.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading user: %w", ErrQuery, err)
	}

	snapshot.ID = users.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Role = authz.Role(role)

	if snapshot.Granted, err = permissionSet(granted); err != nil {
		return nil, fmt.Errorf("%w: user %s granted permissions: %w", ErrQuery, rawID, err)
	}
	if snapshot.Revoked, err = permissionSet(revoked); err != nil {
		return nil, fmt.Errorf("%w: user %s revoked permissions: %w", ErrQuery, rawID, err)
	}

	return users.Restore(snapshot)
}

// optionalBranch renders an unset branch as SQL NULL rather than a zero UUID,
// so "works across the whole business" is absence rather than a magic value.
func optionalBranch(branchID business.BranchID) *uuid.UUID {
	if branchID.IsZero() {
		return nil
	}
	value := branchID.ID()
	return &value
}

// optionalScopeBranch renders a scope's branch for use as a query parameter,
// where NULL means the scope is not narrowed.
func optionalScopeBranch(scope business.Scope) *uuid.UUID {
	branchID, narrowed := scope.Branch()
	if !narrowed {
		return nil
	}
	value := branchID.ID()
	return &value
}

// permissionNames renders a permission set for storage, in the set's own stable
// order so a row does not appear to change when it has not.
func permissionNames(set authz.Set) []string {
	permissions := set.All()
	names := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		names = append(names, string(permission))
	}
	return names
}

// permissionSet rebuilds a permission set from storage, rejecting any name the
// system no longer defines.
//
// A permission removed in a later version leaves rows naming it behind.
// Refusing to load such a user is deliberate: silently dropping the permission
// would change what someone is allowed to do without anyone deciding to.
func permissionSet(names []string) (authz.Set, error) {
	permissions := make([]authz.Permission, 0, len(names))
	for _, name := range names {
		permission, err := authz.ParsePermission(name)
		if err != nil {
			return authz.Set{}, err
		}
		permissions = append(permissions, permission)
	}
	return authz.NewSet(permissions...)
}
