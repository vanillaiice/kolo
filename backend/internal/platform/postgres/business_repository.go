package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// Errors reported by repositories.
var (
	// ErrNotFound means no record matched, within the scope that was asked for.
	//
	// A record that exists but belongs to another tenant is reported as not
	// found rather than as forbidden. Distinguishing the two would confirm the
	// record's existence to someone who may not know of it, which is a leak
	// across the boundary ADR-008 protects.
	ErrNotFound = errors.New("postgres: not found")

	// ErrConflict means the write collided with an existing record.
	ErrConflict = errors.New("postgres: conflicts with an existing record")

	// ErrQuery means the database rejected an operation for some other reason.
	ErrQuery = errors.New("postgres: query failed")
)

// BusinessRepository stores businesses and their branches.
//
// Business lookups take an identifier rather than a scope: a business is the
// tenant, so it is the one thing that cannot be looked up within one. Every
// operation over its contents — branches here, everything else later — takes a
// business.Scope, which is bound into the query rather than checked afterwards
// (ADR-008, ADR-013).
type BusinessRepository struct {
	pool *pgxpool.Pool
}

// NewBusinessRepository returns a repository backed by the given pool.
func NewBusinessRepository(pool *pgxpool.Pool) *BusinessRepository {
	return &BusinessRepository{pool: pool}
}

const businessColumns = `id, name, currency, active, created_at, updated_at`

// Create stores a new business.
func (r *BusinessRepository) Create(ctx context.Context, record *business.Business) error {
	snapshot := record.Snapshot()

	_, err := r.pool.Exec(ctx, `
		INSERT INTO businesses (`+businessColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		snapshot.ID.ID(), snapshot.Name, snapshot.Currency.Code(),
		snapshot.Active, snapshot.CreatedAt, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("creating business", err)
	}
	return nil
}

// Get returns a business by identifier.
func (r *BusinessRepository) Get(ctx context.Context, businessID business.ID) (*business.Business, error) {
	if businessID.IsZero() {
		return nil, fmt.Errorf("%w: no business identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+businessColumns+` FROM businesses WHERE id = $1`, businessID.ID())

	record, err := scanBusiness(row)
	if err != nil {
		return nil, err
	}
	return record, nil
}

// Update writes a business's current state.
//
// Only mutable fields are written. The identifier and creation time are
// immutable (§40), so a mismatch there would mean the caller holds a different
// record, not that this one changed.
func (r *BusinessRepository) Update(ctx context.Context, record *business.Business) error {
	snapshot := record.Snapshot()

	tag, err := r.pool.Exec(ctx, `
		UPDATE businesses
		SET name = $2, currency = $3, active = $4, updated_at = $5
		WHERE id = $1`,
		snapshot.ID.ID(), snapshot.Name, snapshot.Currency.Code(),
		snapshot.Active, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("updating business", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: business %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

func scanBusiness(row pgx.Row) (*business.Business, error) {
	var (
		snapshot     business.Snapshot
		rawID        uuid.UUID
		currencyCode string
	)
	err := row.Scan(&rawID, &snapshot.Name, &currencyCode,
		&snapshot.Active, &snapshot.CreatedAt, &snapshot.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading business: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return nil, fmt.Errorf("%w: business %s: %w", ErrQuery, rawID, err)
	}
	snapshot.ID = business.IDFrom(rawID)
	snapshot.Currency = currency

	// Restore validates, so a row that no longer satisfies the domain's rules
	// fails here rather than downstream (ADR-013).
	return business.Restore(snapshot)
}

const branchColumns = `id, business_id, name, active, created_at, updated_at`

// CreateBranch stores a new branch within the scope's business.
func (r *BusinessRepository) CreateBranch(ctx context.Context, scope business.Scope, record *business.Branch) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	// The branch must belong to the tenant the caller is acting within, whatever
	// the entity happens to carry.
	if err := scope.Guard(snapshot.BusinessID, snapshot.ID); err != nil {
		return err
	}

	_, err := r.pool.Exec(ctx, `
		INSERT INTO branches (`+branchColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), snapshot.Name,
		snapshot.Active, snapshot.CreatedAt, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("creating branch", err)
	}
	return nil
}

// GetBranch returns a branch within the scope.
//
// The tenant predicate is part of the query, so a branch of another business is
// not found rather than found and then rejected.
func (r *BusinessRepository) GetBranch(
	ctx context.Context, scope business.Scope, branchID business.BranchID,
) (*business.Branch, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if branchID.IsZero() {
		return nil, fmt.Errorf("%w: no branch identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+branchColumns+`
		FROM branches
		WHERE id = $1 AND business_id = $2`,
		branchID.ID(), scope.Business().ID())

	return scanBranch(row)
}

// ListBranches returns every branch of the scope's business, ordered by name.
func (r *BusinessRepository) ListBranches(ctx context.Context, scope business.Scope) ([]*business.Branch, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+branchColumns+`
		FROM branches
		WHERE business_id = $1
		ORDER BY name, id`, scope.Business().ID())
	if err != nil {
		return nil, fmt.Errorf("%w: listing branches: %w", ErrQuery, err)
	}
	defer rows.Close()

	branches := make([]*business.Branch, 0)
	for rows.Next() {
		record, err := scanBranch(rows)
		if err != nil {
			return nil, err
		}
		branches = append(branches, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing branches: %w", ErrQuery, err)
	}
	return branches, nil
}

// UpdateBranch writes a branch's current state, within the scope.
func (r *BusinessRepository) UpdateBranch(ctx context.Context, scope business.Scope, record *business.Branch) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, snapshot.ID); err != nil {
		return err
	}

	tag, err := r.pool.Exec(ctx, `
		UPDATE branches
		SET name = $3, active = $4, updated_at = $5
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(),
		snapshot.Name, snapshot.Active, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("updating branch", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: branch %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

func scanBranch(row pgx.Row) (*business.Branch, error) {
	var (
		snapshot        business.BranchSnapshot
		rawID, rawOwner uuid.UUID
	)
	err := row.Scan(&rawID, &rawOwner, &snapshot.Name,
		&snapshot.Active, &snapshot.CreatedAt, &snapshot.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading branch: %w", ErrQuery, err)
	}

	snapshot.ID = business.BranchIDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	return business.RestoreBranch(snapshot)
}

// requireScope rejects an unset scope before it reaches a query.
//
// A zero Scope permits nothing, so a query built from one would be harmless but
// silently return nothing. Failing loudly instead turns a forgotten scope into
// an error rather than an empty result someone has to explain.
func requireScope(scope business.Scope) error {
	if !scope.Valid() {
		return business.ErrNoTenant
	}
	return nil
}

// wrapWrite turns a driver error into one callers can act on.
func wrapWrite(operation string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		const (
			uniqueViolation     = "23505"
			foreignKeyViolation = "23503"
			restrictViolation   = "23001"
			checkViolation      = "23514"
		)
		switch pgErr.Code {
		case uniqueViolation, foreignKeyViolation, restrictViolation, checkViolation:
			// A constraint the domain should have caught first. Reporting it as
			// a conflict rather than a generic failure tells the caller the
			// input was wrong, not the database.
			//
			// The driver's error is wrapped as well as the sentinel, so a caller
			// that needs to tell one constraint failure from another — the sync
			// service turns a bad reference into a single rejected event rather
			// than a failed batch — can still reach it with errors.As.
			return fmt.Errorf("%w: %s: %s: %w", ErrConflict, operation, pgErr.ConstraintName, err)
		}
	}
	return fmt.Errorf("%w: %s: %w", ErrQuery, operation, err)
}
