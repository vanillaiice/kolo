package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// AccountRepository stores where a business's money sits.
//
// It holds no balance. What an account holds is the sum of the transactions
// touching it, and a column here would be both the number §18 checks and the
// number doing the checking (§59).
type AccountRepository struct {
	pool *pgxpool.Pool
}

// NewAccountRepository returns a repository backed by the given pool.
func NewAccountRepository(pool *pgxpool.Pool) *AccountRepository {
	return &AccountRepository{pool: pool}
}

const accountColumns = `id, business_id, branch_id, name, kind, currency,
	number, notes, active, created_at, updated_at, updated_by_device`

// accountInsert writes one account row. Shared by the ordinary create and the
// conflict-resolving upsert a sync event uses, so there is one column list.
const accountInsert = `
	INSERT INTO financial_accounts (` + accountColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`

// accountValues lays an account out in the order accountInsert expects.
func accountValues(account *finance.Account) []any {
	snapshot := account.Snapshot()
	return []any{
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		snapshot.Name, string(snapshot.Kind), snapshot.Currency.Code(),
		optionalText(snapshot.Number), optionalText(snapshot.Notes),
		snapshot.Active, snapshot.CreatedAt, snapshot.UpdatedAt,
		optionalDevice(snapshot.UpdatedByDevice),
	}
}

// Create opens an account within the scope's business.
func (r *AccountRepository) Create(
	ctx context.Context, scope business.Scope, account *finance.Account,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if account == nil {
		return fmt.Errorf("%w: no account", ErrQuery)
	}
	if err := scope.Guard(account.BusinessID(), account.BranchID()); err != nil {
		return err
	}

	if _, err := r.pool.Exec(ctx, accountInsert, accountValues(account)...); err != nil {
		return wrapWrite("creating account", err)
	}
	return nil
}

// Get returns an account within the scope.
func (r *AccountRepository) Get(
	ctx context.Context, scope business.Scope, accountID finance.AccountID,
) (*finance.Account, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if accountID.IsZero() {
		return nil, fmt.Errorf("%w: no account identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+accountColumns+`
		FROM financial_accounts WHERE id = $1 AND business_id = $2`,
		accountID.ID(), scope.Business().ID())
	return scanAccount(row)
}

// List returns the scope's accounts, ordered by name.
//
// The branch filter is the same shape as the ledger's: an account belonging to
// the whole business is visible from every branch, and a branch's own account
// only from there (§42).
func (r *AccountRepository) List(
	ctx context.Context, scope business.Scope, activeOnly bool,
) ([]*finance.Account, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+accountColumns+`
		FROM financial_accounts
		WHERE business_id = $1
		  AND ($2::uuid IS NULL OR branch_id IS NULL OR branch_id = $2)
		  AND (NOT $3::boolean OR active)
		ORDER BY name, id`,
		scope.Business().ID(), optionalScopeBranch(scope), activeOnly)
	if err != nil {
		return nil, fmt.Errorf("%w: listing accounts: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*finance.Account, 0)
	for rows.Next() {
		account, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, account)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing accounts: %w", ErrQuery, err)
	}
	return found, nil
}

// Update writes an account's current state, within the scope.
func (r *AccountRepository) Update(
	ctx context.Context, scope business.Scope, account *finance.Account,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if account == nil {
		return fmt.Errorf("%w: no account", ErrQuery)
	}
	snapshot := account.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
		return err
	}

	tag, err := r.pool.Exec(ctx, `
		UPDATE financial_accounts
		SET branch_id = $3, name = $4, kind = $5, currency = $6, number = $7,
		    notes = $8, active = $9, updated_at = $10, updated_by_device = $11
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		snapshot.Name, string(snapshot.Kind), snapshot.Currency.Code(),
		optionalText(snapshot.Number), optionalText(snapshot.Notes),
		snapshot.Active, snapshot.UpdatedAt, optionalDevice(snapshot.UpdatedByDevice))
	if err != nil {
		return wrapWrite("updating account", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: account %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

// upsertAccount writes an account, keeping whichever edit wins.
//
// Last-write-wins ordered by (updated_at, updated_by_device), the same rule as a
// product's and a customer's (ADR-015). The identity columns are absent from the
// SET list: an account's business never changes, and an event that tried to move
// one into another tenant must not be able to (ADR-008).
func upsertAccount(ctx context.Context, exec executor, account *finance.Account) error {
	_, err := exec.Exec(ctx, accountInsert+`
		ON CONFLICT (id) DO UPDATE SET
			branch_id         = excluded.branch_id,
			name              = excluded.name,
			kind              = excluded.kind,
			currency          = excluded.currency,
			number            = excluded.number,
			notes             = excluded.notes,
			active            = excluded.active,
			updated_at        = excluded.updated_at,
			updated_by_device = excluded.updated_by_device
		WHERE excluded.updated_at > financial_accounts.updated_at
		   OR (excluded.updated_at = financial_accounts.updated_at
		       AND excluded.updated_by_device > financial_accounts.updated_by_device)`,
		accountValues(account)...)
	if err != nil {
		return wrapWrite("applying account", err)
	}
	return nil
}

func scanAccount(row pgx.Row) (*finance.Account, error) {
	var (
		snapshot        finance.AccountSnapshot
		rawID, rawOwner uuid.UUID
		rawBranch       *uuid.UUID
		kind            string
		currencyCode    string
		number, notes   *string
		updatedByDevice *uuid.UUID
	)
	err := row.Scan(&rawID, &rawOwner, &rawBranch, &snapshot.Name, &kind, &currencyCode,
		&number, &notes, &snapshot.Active, &snapshot.CreatedAt, &snapshot.UpdatedAt,
		&updatedByDevice)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading account: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return nil, fmt.Errorf("%w: account %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = finance.AccountIDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Kind = finance.AccountKind(kind)
	snapshot.Currency = currency
	snapshot.Number = text(number)
	snapshot.Notes = text(notes)
	if updatedByDevice != nil {
		snapshot.UpdatedByDevice = devices.IDFrom(*updatedByDevice)
	}

	return finance.RestoreAccount(snapshot)
}
