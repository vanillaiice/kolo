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
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// AccountMovementRepository stores money moved by hand, and derives what an
// account holds.
//
// The balance is summed from three places — the payments taken into the
// account, the customers settling debts into it, and the movements here —
// because each of those is recorded once, where it happened. A ledger repeating
// them would be a second copy that could disagree, and §18's whole job is
// comparing the derived figure against the drawer.
type AccountMovementRepository struct {
	pool *pgxpool.Pool
}

// NewAccountMovementRepository returns a repository backed by the given pool.
func NewAccountMovementRepository(pool *pgxpool.Pool) *AccountMovementRepository {
	return &AccountMovementRepository{pool: pool}
}

const accountMovementColumns = `id, account_id, business_id, branch_id, type,
	amount_minor, currency, counterpart_id, reason, user_id, device_id,
	occurred_at, recorded_at`

const accountMovementInsert = `
	INSERT INTO account_movements (` + accountMovementColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`

func accountMovementValues(movement *finance.Movement) []any {
	snapshot := movement.Snapshot()
	return []any{
		snapshot.ID.ID(), snapshot.AccountID.ID(), snapshot.BusinessID.ID(),
		optionalBranch(snapshot.BranchID), string(snapshot.Type),
		snapshot.Amount.Amount(), snapshot.Amount.Currency().Code(),
		optionalAccount(snapshot.CounterpartID), optionalText(snapshot.Reason),
		snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt,
	}
}

// Record appends one movement.
func (r *AccountMovementRepository) Record(
	ctx context.Context, scope business.Scope, movement *finance.Movement,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if movement == nil {
		return fmt.Errorf("%w: no movement", ErrQuery)
	}
	if err := scope.Guard(movement.BusinessID(), movement.BranchID()); err != nil {
		return err
	}

	return insertAccountMovement(ctx, r.pool, movement)
}

// RecordTransfer appends both halves of a transfer, in one transaction.
//
// Half a transfer is money genuinely lost: gone from one account with nothing
// to show where it went. The database is what makes that impossible, not the
// caller remembering to write the second row.
func (r *AccountMovementRepository) RecordTransfer(
	ctx context.Context, scope business.Scope, out, in *finance.Movement,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if out == nil || in == nil {
		return fmt.Errorf("%w: a transfer needs both halves", ErrQuery)
	}
	for _, half := range []*finance.Movement{out, in} {
		if err := scope.Guard(half.BusinessID(), half.BranchID()); err != nil {
			return err
		}
	}
	// Each half names the other, which is what a reader follows to see that the
	// money did not vanish.
	if counterpart, named := out.Counterpart(); !named || counterpart != in.AccountID() {
		return fmt.Errorf("%w: the money leaving does not name where it went", ErrQuery)
	}
	if counterpart, named := in.Counterpart(); !named || counterpart != out.AccountID() {
		return fmt.Errorf("%w: the money arriving does not name where it came from", ErrQuery)
	}

	transaction, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: recording a transfer: %w", ErrQuery, err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	if err := insertAccountMovement(ctx, transaction, out); err != nil {
		return fmt.Errorf("the money leaving: %w", err)
	}
	if err := insertAccountMovement(ctx, transaction, in); err != nil {
		return fmt.Errorf("the money arriving: %w", err)
	}

	if err := transaction.Commit(ctx); err != nil {
		return wrapWrite("recording a transfer", err)
	}
	return nil
}

// insertAccountMovement writes one movement using the given executor, so a
// transfer's two halves and a sync event's movements share one statement.
func insertAccountMovement(ctx context.Context, exec executor, movement *finance.Movement) error {
	if _, err := exec.Exec(ctx, accountMovementInsert, accountMovementValues(movement)...); err != nil {
		return wrapWrite("recording an account movement", err)
	}
	return nil
}

// ListForAccount returns an account's movements, oldest first by when the money
// actually moved.
func (r *AccountMovementRepository) ListForAccount(
	ctx context.Context, scope business.Scope, accountID finance.AccountID,
) ([]*finance.Movement, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if accountID.IsZero() {
		return nil, fmt.Errorf("%w: no account identifier given", ErrNotFound)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+accountMovementColumns+`
		FROM account_movements
		WHERE business_id = $1 AND account_id = $2
		ORDER BY occurred_at, id`,
		scope.Business().ID(), accountID.ID())
	if err != nil {
		return nil, fmt.Errorf("%w: listing account movements: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*finance.Movement, 0)
	for rows.Next() {
		movement, err := scanAccountMovement(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, movement)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing account movements: %w", ErrQuery, err)
	}
	return found, nil
}

// BalanceOf returns what an account holds.
//
// Three sums, added: what sales paid into it, what customers paid into it, and
// what moved by hand. Each source is authoritative for its own facts, and the
// query is the only place they are brought together — which is why a new source
// of money must be added here or the drawer will read short by exactly what it
// moved.
//
// The database does the addition rather than Go, because a till at the end of a
// busy day has thousands of rows and an owner asking "how much should be in the
// drawer" must not pay for all of them (§46).
func (r *AccountMovementRepository) BalanceOf(
	ctx context.Context, scope business.Scope, accountID finance.AccountID,
) (finance.Balance, error) {
	return r.balanceAsOf(ctx, scope, accountID, nil)
}

// BalanceAsOf returns what an account held at a given moment.
//
// By when the money moved, not when the system heard: a payment synced days late
// still belongs to the day it was taken, which is what makes yesterday's cash
// report stable once the tills have caught up.
func (r *AccountMovementRepository) BalanceAsOf(
	ctx context.Context, scope business.Scope, accountID finance.AccountID, asOf time.Time,
) (finance.Balance, error) {
	if asOf.IsZero() {
		return finance.Balance{}, fmt.Errorf("%w: no moment given", ErrQuery)
	}
	moment := asOf.UTC()
	return r.balanceAsOf(ctx, scope, accountID, &moment)
}

func (r *AccountMovementRepository) balanceAsOf(
	ctx context.Context, scope business.Scope, accountID finance.AccountID, asOf *time.Time,
) (finance.Balance, error) {
	if err := requireScope(scope); err != nil {
		return finance.Balance{}, err
	}
	if accountID.IsZero() {
		return finance.Balance{}, fmt.Errorf("%w: no account identifier given", ErrNotFound)
	}

	var (
		onHand     int64
		movements  int
		currencies []string
		lastMoved  *time.Time
	)
	// One query over the three sources. A sale payment and a customer payment
	// are both money arriving, so both are added as they are stored: a sale
	// payment is positive already, and a customer's payment is negative in
	// their ledger — it reduces what they owe — so it is negated here, where
	// the meaning changes from "less debt" to "more cash".
	err := r.pool.QueryRow(ctx, `
		WITH moved AS (
			SELECT amount_minor, currency, occurred_at
			FROM sale_payments
			WHERE business_id = $1 AND account_id = $2
			  AND ($3::timestamptz IS NULL OR occurred_at <= $3)

			UNION ALL

			SELECT -amount_minor, currency, occurred_at
			FROM customer_transactions
			WHERE business_id = $1 AND account_id = $2 AND type = 'PAYMENT'
			  AND ($3::timestamptz IS NULL OR occurred_at <= $3)

			UNION ALL

			SELECT amount_minor, currency, occurred_at
			FROM account_movements
			WHERE business_id = $1 AND account_id = $2
			  AND ($3::timestamptz IS NULL OR occurred_at <= $3)
		)
		SELECT coalesce(sum(amount_minor), 0), count(*),
		       coalesce(array_agg(DISTINCT currency), '{}'), max(occurred_at)
		FROM moved`,
		scope.Business().ID(), accountID.ID(), asOf,
	).Scan(&onHand, &movements, &currencies, &lastMoved)
	if err != nil {
		return finance.Balance{}, fmt.Errorf("%w: deriving a balance: %w", ErrQuery, err)
	}

	balance := finance.Balance{AccountID: accountID, Movements: movements}
	if movements == 0 {
		// Nothing has moved, which is not the same as holding zero francs: the
		// domain says so by leaving OnHand without a currency, and Movements is
		// how a caller tells the two apart.
		return balance, nil
	}

	// The sum above would silently add francs to euros. An account holds one
	// currency, so a mixture is a fault to report rather than a total to trust
	// (ADR-010).
	if len(currencies) != 1 {
		return finance.Balance{}, fmt.Errorf("%w: account %s has money in %d currencies",
			finance.ErrInvalidCurrency, accountID, len(currencies))
	}
	currency, err := money.ByCode(currencies[0])
	if err != nil {
		return finance.Balance{}, fmt.Errorf("%w: account %s: %w", ErrQuery, accountID, err)
	}
	amount, err := money.New(onHand, currency)
	if err != nil {
		return finance.Balance{}, fmt.Errorf("%w: account %s: %w", ErrQuery, accountID, err)
	}

	balance.OnHand = amount
	if lastMoved != nil {
		balance.LastMovedAt = lastMoved.UTC()
	}
	return balance, nil
}

func scanAccountMovement(row pgx.Row) (*finance.Movement, error) {
	var (
		snapshot           finance.MovementSnapshot
		rawID, rawAccount  uuid.UUID
		rawOwner           uuid.UUID
		rawBranch          *uuid.UUID
		rawCounterpart     *uuid.UUID
		rawUser, rawDevice uuid.UUID
		movementType       string
		amountMinor        int64
		currencyCode       string
		reason             *string
	)
	err := row.Scan(&rawID, &rawAccount, &rawOwner, &rawBranch, &movementType,
		&amountMinor, &currencyCode, &rawCounterpart, &reason,
		&rawUser, &rawDevice, &snapshot.OccurredAt, &snapshot.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading an account movement: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return nil, fmt.Errorf("%w: movement %s: %w", ErrQuery, rawID, err)
	}
	amount, err := money.New(amountMinor, currency)
	if err != nil {
		return nil, fmt.Errorf("%w: movement %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = finance.MovementIDFrom(rawID)
	snapshot.AccountID = finance.AccountIDFrom(rawAccount)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Type = finance.MovementType(movementType)
	snapshot.Amount = amount
	if rawCounterpart != nil {
		snapshot.CounterpartID = finance.AccountIDFrom(*rawCounterpart)
	}
	snapshot.Reason = text(reason)
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.DeviceID = devices.IDFrom(rawDevice)

	return finance.RestoreMovement(snapshot)
}
