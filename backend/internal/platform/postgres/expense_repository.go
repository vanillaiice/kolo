package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/expenses"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// ExpenseRepository stores what a business spent that was not stock.
//
// It appends and reads. There is no Update or Delete: an expense entered in
// error is undone by a reversal, and the database refuses an edit even if one
// were attempted (§19, §41).
type ExpenseRepository struct {
	pool *pgxpool.Pool
}

// NewExpenseRepository returns a repository backed by the given pool.
func NewExpenseRepository(pool *pgxpool.Pool) *ExpenseRepository {
	return &ExpenseRepository{pool: pool}
}

const expenseColumns = `id, business_id, branch_id, category, account_id,
	amount_minor, currency, description, reference, reverses_id,
	user_id, device_id, occurred_at, recorded_at`

const expenseInsert = `
	INSERT INTO expenses (` + expenseColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

func expenseValues(expense *expenses.Expense) []any {
	snapshot := expense.Snapshot()
	var reverses *uuid.UUID
	if !snapshot.Reverses.IsZero() {
		raw := snapshot.Reverses.ID()
		reverses = &raw
	}
	return []any{
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		string(snapshot.Category), snapshot.AccountID.ID(),
		snapshot.Amount.Amount(), snapshot.Amount.Currency().Code(),
		optionalText(snapshot.Description), optionalText(snapshot.Reference), reverses,
		snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt,
	}
}

// Record appends an expense.
func (r *ExpenseRepository) Record(
	ctx context.Context, scope business.Scope, expense *expenses.Expense,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if expense == nil {
		return fmt.Errorf("%w: no expense", ErrQuery)
	}
	if err := scope.Guard(expense.BusinessID(), expense.BranchID()); err != nil {
		return err
	}

	return insertExpense(ctx, r.pool, expense)
}

// insertExpense writes one expense using the given executor, so a direct write
// and a sync event share the statement.
func insertExpense(ctx context.Context, exec executor, expense *expenses.Expense) error {
	if _, err := exec.Exec(ctx, expenseInsert, expenseValues(expense)...); err != nil {
		return wrapWrite("recording an expense", err)
	}
	return nil
}

// Get returns one expense within the scope.
func (r *ExpenseRepository) Get(
	ctx context.Context, scope business.Scope, expenseID expenses.ID,
) (*expenses.Expense, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if expenseID.IsZero() {
		return nil, fmt.Errorf("%w: no expense identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+expenseColumns+` FROM expenses WHERE id = $1 AND business_id = $2`,
		expenseID.ID(), scope.Business().ID())
	return scanExpense(row)
}

// Between returns the expenses of a period, by when the money was spent.
//
// Not by when the row was written: a phone that recorded Monday's transport on
// Friday still spent it on Monday, and a month's costs must not move because a
// device was slow to sync.
func (r *ExpenseRepository) Between(
	ctx context.Context, scope business.Scope, from, to time.Time,
) ([]*expenses.Expense, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if from.IsZero() || to.IsZero() {
		return nil, fmt.Errorf("%w: a period needs both ends", ErrQuery)
	}
	if to.Before(from) {
		return nil, fmt.Errorf("%w: the period ends before it starts", ErrQuery)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+expenseColumns+`
		FROM expenses
		WHERE business_id = $1
		  AND ($2::uuid IS NULL OR branch_id IS NULL OR branch_id = $2)
		  AND occurred_at >= $3 AND occurred_at < $4
		ORDER BY occurred_at, id`,
		scope.Business().ID(), optionalScopeBranch(scope), from.UTC(), to.UTC())
	if err != nil {
		return nil, fmt.Errorf("%w: listing expenses: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*expenses.Expense, 0)
	for rows.Next() {
		expense, err := scanExpense(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, expense)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing expenses: %w", ErrQuery, err)
	}
	return found, nil
}

// ByCategory is what a period cost, broken down the way §19 asks for.
type ByCategory struct {
	Category expenses.Category
	Total    money.Money
	// Count is how many expenses the total came from, reversals included: a
	// category with two entries that cancel is not the same as one nobody used.
	Count int
}

// TotalsByCategory sums a period's expenses per category, largest first.
//
// Reversals are negative and cancel what they undo by plain addition, so a cost
// entered twice and corrected does not show up as spending that happened.
func (r *ExpenseRepository) TotalsByCategory(
	ctx context.Context, scope business.Scope, from, to time.Time,
) ([]ByCategory, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if from.IsZero() || to.IsZero() {
		return nil, fmt.Errorf("%w: a period needs both ends", ErrQuery)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT category, sum(amount_minor), currency, count(*)
		FROM expenses
		WHERE business_id = $1
		  AND ($2::uuid IS NULL OR branch_id IS NULL OR branch_id = $2)
		  AND occurred_at >= $3 AND occurred_at < $4
		GROUP BY category, currency
		ORDER BY sum(amount_minor) DESC, category`,
		scope.Business().ID(), optionalScopeBranch(scope), from.UTC(), to.UTC())
	if err != nil {
		return nil, fmt.Errorf("%w: totalling expenses: %w", ErrQuery, err)
	}
	defer rows.Close()

	totals := make([]ByCategory, 0)
	for rows.Next() {
		var (
			category     string
			total        int64
			currencyCode string
			count        int
		)
		if err := rows.Scan(&category, &total, &currencyCode, &count); err != nil {
			return nil, fmt.Errorf("%w: reading expense totals: %w", ErrQuery, err)
		}

		currency, err := money.ByCode(currencyCode)
		if err != nil {
			return nil, fmt.Errorf("%w: %s: %w", ErrQuery, category, err)
		}
		amount, err := money.New(total, currency)
		if err != nil {
			return nil, fmt.Errorf("%w: %s: %w", ErrQuery, category, err)
		}

		totals = append(totals, ByCategory{
			Category: expenses.Category(category),
			Total:    amount,
			Count:    count,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: totalling expenses: %w", ErrQuery, err)
	}
	return totals, nil
}

func scanExpense(row pgx.Row) (*expenses.Expense, error) {
	var (
		snapshot              expenses.Snapshot
		rawID, rawOwner       uuid.UUID
		rawBranch             *uuid.UUID
		rawAccount            uuid.UUID
		rawReverses           *uuid.UUID
		rawUser, rawDevice    uuid.UUID
		category              string
		amountMinor           int64
		currencyCode          string
		description, referenc *string
	)
	err := row.Scan(&rawID, &rawOwner, &rawBranch, &category, &rawAccount,
		&amountMinor, &currencyCode, &description, &referenc, &rawReverses,
		&rawUser, &rawDevice, &snapshot.OccurredAt, &snapshot.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading an expense: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return nil, fmt.Errorf("%w: expense %s: %w", ErrQuery, rawID, err)
	}
	amount, err := money.New(amountMinor, currency)
	if err != nil {
		return nil, fmt.Errorf("%w: expense %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = expenses.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Category = expenses.Category(category)
	snapshot.AccountID = finance.AccountIDFrom(rawAccount)
	snapshot.Amount = amount
	snapshot.Description = text(description)
	snapshot.Reference = text(referenc)
	if rawReverses != nil {
		snapshot.Reverses = expenses.IDFrom(*rawReverses)
	}
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.DeviceID = devices.IDFrom(rawDevice)

	return expenses.Restore(snapshot)
}
