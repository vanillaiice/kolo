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
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// CreditRepository stores what customers owe.
//
// It appends and reads. There is deliberately no Update or Delete: the ledger
// is append-only, a correction is another entry that references the original,
// and the database refuses an edit even if one were attempted (§13, §41;
// ADR-007) — the same shape as the stock ledger, for the same reason.
type CreditRepository struct {
	pool *pgxpool.Pool
}

// NewCreditRepository returns a repository backed by the given pool.
func NewCreditRepository(pool *pgxpool.Pool) *CreditRepository {
	return &CreditRepository{pool: pool}
}

const creditColumns = `id, customer_id, business_id, branch_id, type,
	amount_minor, currency, account_id, reference_kind, reference_id, reason,
	user_id, device_id, occurred_at, recorded_at`

// creditInsert appends one entry to a customer's ledger.
//
// There is exactly one of these, shared by the direct append and by the sync
// event that applies a credit sale from another device, so both produce
// identical rows. A second copy would be a second place to forget a column.
const creditInsert = `
	INSERT INTO customer_transactions (` + creditColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`

// creditValues lays a transaction out in the order creditInsert expects.
func creditValues(transaction *customers.Transaction) []any {
	snapshot := transaction.Snapshot()
	referenceKind, referenceID := optionalCreditReference(snapshot.Reference)

	return []any{
		snapshot.ID.ID(), snapshot.CustomerID.ID(), snapshot.BusinessID.ID(),
		optionalBranch(snapshot.BranchID), string(snapshot.Type),
		snapshot.Amount.Amount(), snapshot.Amount.Currency().Code(),
		optionalAccount(snapshot.AccountID),
		referenceKind, referenceID, optionalText(snapshot.Reason),
		snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt,
	}
}

// Record appends one entry to a customer's ledger.
func (r *CreditRepository) Record(
	ctx context.Context, scope business.Scope, transaction *customers.Transaction,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if transaction == nil {
		return fmt.Errorf("%w: no transaction", ErrQuery)
	}
	if err := scope.Guard(transaction.BusinessID(), transaction.BranchID()); err != nil {
		return err
	}

	return insertCreditTransaction(ctx, r.pool, transaction)
}

// insertCreditTransaction writes one ledger entry using the given executor, so
// a credit sale's entry can land inside the transaction that records the sale.
func insertCreditTransaction(
	ctx context.Context, exec executor, transaction *customers.Transaction,
) error {
	if _, err := exec.Exec(ctx, creditInsert, creditValues(transaction)...); err != nil {
		return wrapWrite("recording a credit transaction", err)
	}
	return nil
}

// ListForCustomer returns a customer's ledger, oldest first by when things
// actually happened.
//
// Ordered by occurred_at rather than by when the row arrived, because a
// statement is a story about the customer's dealings with the shop: a payment
// made on Monday belongs before a purchase made on Tuesday however the tills
// synced. Ties break on the identifier, which sorts by creation time (ADR-011),
// so two people reading the same statement see the same order.
func (r *CreditRepository) ListForCustomer(
	ctx context.Context, scope business.Scope, customerID customers.ID,
) ([]*customers.Transaction, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if customerID.IsZero() {
		return nil, fmt.Errorf("%w: no customer identifier given", ErrNotFound)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+creditColumns+`
		FROM customer_transactions
		WHERE business_id = $1 AND customer_id = $2
		  AND ($3::uuid IS NULL OR branch_id IS NULL OR branch_id = $3)
		ORDER BY occurred_at, id`,
		scope.Business().ID(), customerID.ID(), optionalScopeBranch(scope))
	if err != nil {
		return nil, fmt.Errorf("%w: listing credit transactions: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*customers.Transaction, 0)
	for rows.Next() {
		transaction, err := scanCreditTransaction(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, transaction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing credit transactions: %w", ErrQuery, err)
	}
	return found, nil
}

// BalanceOf returns what a customer owes.
//
// The sum is computed by the database rather than by loading every entry and
// adding them here. A regular who has bought on credit for two years has
// hundreds of entries, and a cashier asking "what does Jean owe" must not pay
// for all of them (§46). The answer is identical either way — it is the same
// addition — which is what makes the query safe to prefer.
func (r *CreditRepository) BalanceOf(
	ctx context.Context, scope business.Scope, customerID customers.ID,
) (customers.Balance, error) {
	return r.balanceAsOf(ctx, scope, customerID, nil)
}

// BalanceAsOf returns what a customer owed at a given moment.
//
// It counts by when things happened, not when the system heard about them, so a
// payment synced days late still lands in the period it belongs to — which is
// what makes a statement for last month stable once the tills have caught up.
func (r *CreditRepository) BalanceAsOf(
	ctx context.Context, scope business.Scope, customerID customers.ID, asOf time.Time,
) (customers.Balance, error) {
	if asOf.IsZero() {
		return customers.Balance{}, fmt.Errorf("%w: no moment given", ErrQuery)
	}
	moment := asOf.UTC()
	return r.balanceAsOf(ctx, scope, customerID, &moment)
}

func (r *CreditRepository) balanceAsOf(
	ctx context.Context, scope business.Scope, customerID customers.ID, asOf *time.Time,
) (customers.Balance, error) {
	if err := requireScope(scope); err != nil {
		return customers.Balance{}, err
	}
	if customerID.IsZero() {
		return customers.Balance{}, fmt.Errorf("%w: no customer identifier given", ErrNotFound)
	}

	var (
		outstanding int64
		entries     int
		currencies  []string
		lastMoved   *time.Time
	)
	err := r.pool.QueryRow(ctx, `
		SELECT coalesce(sum(amount_minor), 0), count(*),
		       coalesce(array_agg(DISTINCT currency), '{}'), max(occurred_at)
		FROM customer_transactions
		WHERE business_id = $1 AND customer_id = $2
		  AND ($3::uuid IS NULL OR branch_id IS NULL OR branch_id = $3)
		  AND ($4::timestamptz IS NULL OR occurred_at <= $4)`,
		scope.Business().ID(), customerID.ID(), optionalScopeBranch(scope), asOf,
	).Scan(&outstanding, &entries, &currencies, &lastMoved)
	if err != nil {
		return customers.Balance{}, fmt.Errorf("%w: deriving a balance: %w", ErrQuery, err)
	}

	balance := customers.Balance{CustomerID: customerID, Entries: entries}
	if entries == 0 {
		// No entries is not a balance of zero francs; it is no balance at all,
		// and the domain says the same by leaving Outstanding without a
		// currency. Entries is how a caller tells "owes nothing because they
		// always pay" from "owes nothing because they have never bought".
		return balance, nil
	}

	// The sum above would silently add francs to euros. The domain refuses a
	// ledger that mixes currencies rather than reporting a number that means
	// nothing (ADR-010), and a total assembled by the database has to refuse it
	// on the same terms.
	if len(currencies) != 1 {
		return customers.Balance{}, fmt.Errorf("%w: customer %s has entries in %d currencies",
			customers.ErrCurrencyMismatch, customerID, len(currencies))
	}
	currency, err := money.ByCode(currencies[0])
	if err != nil {
		return customers.Balance{}, fmt.Errorf("%w: customer %s: %w", ErrQuery, customerID, err)
	}
	amount, err := money.New(outstanding, currency)
	if err != nil {
		return customers.Balance{}, fmt.Errorf("%w: customer %s: %w", ErrQuery, customerID, err)
	}

	balance.Outstanding = amount
	if lastMoved != nil {
		balance.LastMovedAt = lastMoved.UTC()
	}
	return balance, nil
}

// Debtor is a customer with something still owing.
type Debtor struct {
	CustomerID  customers.ID
	Name        string
	Outstanding money.Money
	// Entries is how many transactions the sum came from.
	Entries int
	// LastMovedAt is when their balance last moved.
	LastMovedAt time.Time
}

// Outstanding returns everyone who owes something, largest debt first.
//
// This is the question a shopkeeper actually asks — who owes me money — and
// §21 lists it as a customer report. The sum happens in the database because
// the alternative, loading every customer's ledger to add up in memory, is what
// makes a dashboard slow on the hardware this has to run on (§46).
//
// Customers in credit are absent: they are not debts, and a list of debts that
// included them would have to be read twice to be understood. A customer whose
// ledger somehow mixed currencies appears once per currency rather than having
// unlike amounts added together.
func (r *CreditRepository) Outstanding(
	ctx context.Context, scope business.Scope,
) ([]Debtor, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT t.customer_id, c.name, sum(t.amount_minor), t.currency,
		       count(*), max(t.occurred_at)
		FROM customer_transactions t
		JOIN customers c ON c.id = t.customer_id AND c.business_id = t.business_id
		WHERE t.business_id = $1
		  AND ($2::uuid IS NULL OR t.branch_id IS NULL OR t.branch_id = $2)
		GROUP BY t.customer_id, c.name, t.currency
		HAVING sum(t.amount_minor) > 0
		ORDER BY sum(t.amount_minor) DESC, c.name, t.customer_id`,
		scope.Business().ID(), optionalScopeBranch(scope))
	if err != nil {
		return nil, fmt.Errorf("%w: listing what is owed: %w", ErrQuery, err)
	}
	defer rows.Close()

	debtors := make([]Debtor, 0)
	for rows.Next() {
		var (
			rawCustomer  uuid.UUID
			name         string
			outstanding  int64
			currencyCode string
			entries      int
			lastMoved    time.Time
		)
		if err := rows.Scan(&rawCustomer, &name, &outstanding, &currencyCode,
			&entries, &lastMoved); err != nil {
			return nil, fmt.Errorf("%w: reading what is owed: %w", ErrQuery, err)
		}

		currency, err := money.ByCode(currencyCode)
		if err != nil {
			return nil, fmt.Errorf("%w: customer %s: %w", ErrQuery, rawCustomer, err)
		}
		amount, err := money.New(outstanding, currency)
		if err != nil {
			return nil, fmt.Errorf("%w: customer %s: %w", ErrQuery, rawCustomer, err)
		}

		debtors = append(debtors, Debtor{
			CustomerID:  customers.IDFrom(rawCustomer),
			Name:        name,
			Outstanding: amount,
			Entries:     entries,
			LastMovedAt: lastMoved.UTC(),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing what is owed: %w", ErrQuery, err)
	}
	return debtors, nil
}

func scanCreditTransaction(row pgx.Row) (*customers.Transaction, error) {
	var (
		snapshot                   customers.TransactionSnapshot
		rawID, rawCustomer         uuid.UUID
		rawOwner                   uuid.UUID
		rawBranch                  *uuid.UUID
		rawUser, rawDevice         uuid.UUID
		rawAccount                 *uuid.UUID
		transactionType            string
		amountMinor                int64
		currencyCode               string
		referenceKind, referenceID *string
		reason                     *string
	)
	err := row.Scan(&rawID, &rawCustomer, &rawOwner, &rawBranch, &transactionType,
		&amountMinor, &currencyCode, &rawAccount, &referenceKind, &referenceID, &reason,
		&rawUser, &rawDevice, &snapshot.OccurredAt, &snapshot.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading a credit transaction: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return nil, fmt.Errorf("%w: transaction %s: %w", ErrQuery, rawID, err)
	}
	amount, err := money.New(amountMinor, currency)
	if err != nil {
		return nil, fmt.Errorf("%w: transaction %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = customers.TransactionIDFrom(rawID)
	snapshot.CustomerID = customers.IDFrom(rawCustomer)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Type = customers.TransactionType(transactionType)
	snapshot.Amount = amount
	if rawAccount != nil {
		snapshot.AccountID = finance.AccountIDFrom(*rawAccount)
	}
	if referenceKind != nil && referenceID != nil {
		snapshot.Reference = customers.Reference{Kind: *referenceKind, ID: *referenceID}
	}
	snapshot.Reason = text(reason)
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.DeviceID = devices.IDFrom(rawDevice)

	// Restored rather than trusted: a row written by an older build, or synced
	// from a device running different code, is checked on the way in like any
	// other input.
	return customers.RestoreTransaction(snapshot)
}

// optionalAccount renders an unnamed account as SQL NULL. Only a payment names
// one — the one type where money changes hands.
func optionalAccount(accountID finance.AccountID) *uuid.UUID {
	if accountID.IsZero() {
		return nil
	}
	raw := accountID.ID()
	return &raw
}

func optionalCreditReference(reference customers.Reference) (*string, *string) {
	if reference.IsZero() {
		return nil, nil
	}
	kind, identifier := reference.Kind, reference.ID
	return &kind, &identifier
}
