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
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// SupplierRepository stores who a business buys from and what it owes them.
//
// No balance is stored, here as nowhere: what is owed is the sum of the ledger
// (§16), and a column would be a second answer to the number a shopkeeper and a
// wholesaler argue over.
type SupplierRepository struct {
	pool *pgxpool.Pool
}

// NewSupplierRepository returns a repository backed by the given pool.
func NewSupplierRepository(pool *pgxpool.Pool) *SupplierRepository {
	return &SupplierRepository{pool: pool}
}

const supplierColumns = `id, business_id, name, phone, address, contact, notes,
	active, created_at, updated_at, updated_by_device`

const supplierInsert = `
	INSERT INTO suppliers (` + supplierColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`

func supplierValues(supplier *suppliers.Supplier) []any {
	snapshot := supplier.Snapshot()
	return []any{
		snapshot.ID.ID(), snapshot.BusinessID.ID(), snapshot.Name,
		optionalPhone(snapshot.Phone), optionalText(snapshot.Address),
		optionalText(snapshot.Contact), optionalText(snapshot.Notes),
		snapshot.Active, snapshot.CreatedAt, snapshot.UpdatedAt,
		optionalDevice(snapshot.UpdatedByDevice),
	}
}

// Create stores a new supplier within the scope's business.
func (r *SupplierRepository) Create(
	ctx context.Context, scope business.Scope, supplier *suppliers.Supplier,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if supplier == nil {
		return fmt.Errorf("%w: no supplier", ErrQuery)
	}
	if err := scope.Guard(supplier.BusinessID(), business.BranchID{}); err != nil {
		return err
	}

	if _, err := r.pool.Exec(ctx, supplierInsert, supplierValues(supplier)...); err != nil {
		return wrapWrite("creating supplier", err)
	}
	return nil
}

// Get returns a supplier within the scope.
func (r *SupplierRepository) Get(
	ctx context.Context, scope business.Scope, supplierID suppliers.ID,
) (*suppliers.Supplier, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if supplierID.IsZero() {
		return nil, fmt.Errorf("%w: no supplier identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+supplierColumns+` FROM suppliers WHERE id = $1 AND business_id = $2`,
		supplierID.ID(), scope.Business().ID())
	return scanSupplier(row)
}

// List returns the scope's suppliers, ordered by name.
func (r *SupplierRepository) List(
	ctx context.Context, scope business.Scope, activeOnly bool,
) ([]*suppliers.Supplier, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+supplierColumns+`
		FROM suppliers
		WHERE business_id = $1 AND (NOT $2::boolean OR active)
		ORDER BY name, id`,
		scope.Business().ID(), activeOnly)
	if err != nil {
		return nil, fmt.Errorf("%w: listing suppliers: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*suppliers.Supplier, 0)
	for rows.Next() {
		supplier, err := scanSupplier(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, supplier)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing suppliers: %w", ErrQuery, err)
	}
	return found, nil
}

// Update writes a supplier's current state, within the scope.
func (r *SupplierRepository) Update(
	ctx context.Context, scope business.Scope, supplier *suppliers.Supplier,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if supplier == nil {
		return fmt.Errorf("%w: no supplier", ErrQuery)
	}
	snapshot := supplier.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	tag, err := r.pool.Exec(ctx, `
		UPDATE suppliers
		SET name = $3, phone = $4, address = $5, contact = $6, notes = $7,
		    active = $8, updated_at = $9, updated_by_device = $10
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), snapshot.Name,
		optionalPhone(snapshot.Phone), optionalText(snapshot.Address),
		optionalText(snapshot.Contact), optionalText(snapshot.Notes),
		snapshot.Active, snapshot.UpdatedAt, optionalDevice(snapshot.UpdatedByDevice))
	if err != nil {
		return wrapWrite("updating supplier", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: supplier %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

// upsertSupplier writes a supplier, keeping whichever edit wins (ADR-015).
func upsertSupplier(ctx context.Context, exec executor, supplier *suppliers.Supplier) error {
	_, err := exec.Exec(ctx, supplierInsert+`
		ON CONFLICT (id) DO UPDATE SET
			name              = excluded.name,
			phone             = excluded.phone,
			address           = excluded.address,
			contact           = excluded.contact,
			notes             = excluded.notes,
			active            = excluded.active,
			updated_at        = excluded.updated_at,
			updated_by_device = excluded.updated_by_device
		WHERE excluded.updated_at > suppliers.updated_at
		   OR (excluded.updated_at = suppliers.updated_at
		       AND excluded.updated_by_device > suppliers.updated_by_device)`,
		supplierValues(supplier)...)
	if err != nil {
		return wrapWrite("applying supplier", err)
	}
	return nil
}

func scanSupplier(row pgx.Row) (*suppliers.Supplier, error) {
	var (
		snapshot                          suppliers.Snapshot
		rawID, rawOwner                   uuid.UUID
		rawPhone, address, contact, notes *string
		updatedByDevice                   *uuid.UUID
	)
	err := row.Scan(&rawID, &rawOwner, &snapshot.Name, &rawPhone, &address, &contact,
		&notes, &snapshot.Active, &snapshot.CreatedAt, &snapshot.UpdatedAt, &updatedByDevice)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading supplier: %w", ErrQuery, err)
	}

	if rawPhone != nil {
		number, err := phone.Parse(*rawPhone)
		if err != nil {
			return nil, fmt.Errorf("%w: supplier %s: %w", ErrQuery, rawID, err)
		}
		snapshot.Phone = number
	}
	if updatedByDevice != nil {
		snapshot.UpdatedByDevice = devices.IDFrom(*updatedByDevice)
	}
	snapshot.ID = suppliers.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	snapshot.Address = text(address)
	snapshot.Contact = text(contact)
	snapshot.Notes = text(notes)

	return suppliers.Restore(snapshot)
}

// SupplierLedgerRepository stores what a business owes its suppliers.
//
// Append-only, like every other ledger: a correction is another entry, and the
// database refuses an edit even if one were attempted (§16, §41).
type SupplierLedgerRepository struct {
	pool *pgxpool.Pool
}

// NewSupplierLedgerRepository returns a repository backed by the given pool.
func NewSupplierLedgerRepository(pool *pgxpool.Pool) *SupplierLedgerRepository {
	return &SupplierLedgerRepository{pool: pool}
}

const supplierLedgerColumns = `id, supplier_id, business_id, branch_id, type,
	amount_minor, currency, account_id, reference_kind, reference_id, reason,
	user_id, device_id, occurred_at, recorded_at`

const supplierLedgerInsert = `
	INSERT INTO supplier_transactions (` + supplierLedgerColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`

func supplierLedgerValues(transaction *suppliers.Transaction) []any {
	snapshot := transaction.Snapshot()
	var referenceKind, referenceID *string
	if !snapshot.Reference.IsZero() {
		kind, identifier := snapshot.Reference.Kind, snapshot.Reference.ID
		referenceKind, referenceID = &kind, &identifier
	}

	return []any{
		snapshot.ID.ID(), snapshot.SupplierID.ID(), snapshot.BusinessID.ID(),
		optionalBranch(snapshot.BranchID), string(snapshot.Type),
		snapshot.Amount.Amount(), snapshot.Amount.Currency().Code(),
		optionalAccount(snapshot.AccountID),
		referenceKind, referenceID, optionalText(snapshot.Reason),
		snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt,
	}
}

// Record appends one entry to a supplier's ledger.
func (r *SupplierLedgerRepository) Record(
	ctx context.Context, scope business.Scope, transaction *suppliers.Transaction,
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

	return insertSupplierTransaction(ctx, r.pool, transaction)
}

func insertSupplierTransaction(
	ctx context.Context, exec executor, transaction *suppliers.Transaction,
) error {
	if _, err := exec.Exec(ctx, supplierLedgerInsert, supplierLedgerValues(transaction)...); err != nil {
		return wrapWrite("recording a supplier transaction", err)
	}
	return nil
}

// ListForSupplier returns a supplier's ledger, oldest first by when things
// happened.
func (r *SupplierLedgerRepository) ListForSupplier(
	ctx context.Context, scope business.Scope, supplierID suppliers.ID,
) ([]*suppliers.Transaction, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if supplierID.IsZero() {
		return nil, fmt.Errorf("%w: no supplier identifier given", ErrNotFound)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+supplierLedgerColumns+`
		FROM supplier_transactions
		WHERE business_id = $1 AND supplier_id = $2
		ORDER BY occurred_at, id`,
		scope.Business().ID(), supplierID.ID())
	if err != nil {
		return nil, fmt.Errorf("%w: listing supplier transactions: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*suppliers.Transaction, 0)
	for rows.Next() {
		transaction, err := scanSupplierTransaction(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, transaction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing supplier transactions: %w", ErrQuery, err)
	}
	return found, nil
}

// BalanceOf returns what the business owes a supplier, summed by the database.
func (r *SupplierLedgerRepository) BalanceOf(
	ctx context.Context, scope business.Scope, supplierID suppliers.ID,
) (suppliers.Balance, error) {
	if err := requireScope(scope); err != nil {
		return suppliers.Balance{}, err
	}
	if supplierID.IsZero() {
		return suppliers.Balance{}, fmt.Errorf("%w: no supplier identifier given", ErrNotFound)
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
		FROM supplier_transactions
		WHERE business_id = $1 AND supplier_id = $2`,
		scope.Business().ID(), supplierID.ID(),
	).Scan(&outstanding, &entries, &currencies, &lastMoved)
	if err != nil {
		return suppliers.Balance{}, fmt.Errorf("%w: deriving a balance: %w", ErrQuery, err)
	}

	balance := suppliers.Balance{SupplierID: supplierID, Entries: entries}
	if entries == 0 {
		return balance, nil
	}
	if len(currencies) != 1 {
		return suppliers.Balance{}, fmt.Errorf("%w: supplier %s has entries in %d currencies",
			suppliers.ErrCurrencyMismatch, supplierID, len(currencies))
	}
	currency, err := money.ByCode(currencies[0])
	if err != nil {
		return suppliers.Balance{}, fmt.Errorf("%w: supplier %s: %w", ErrQuery, supplierID, err)
	}
	amount, err := money.New(outstanding, currency)
	if err != nil {
		return suppliers.Balance{}, fmt.Errorf("%w: supplier %s: %w", ErrQuery, supplierID, err)
	}

	balance.Outstanding = amount
	if lastMoved != nil {
		balance.LastMovedAt = lastMoved.UTC()
	}
	return balance, nil
}

// Creditor is a supplier the business still owes.
type Creditor struct {
	SupplierID  suppliers.ID
	Name        string
	Outstanding money.Money
	Entries     int
	LastMovedAt time.Time
}

// Outstanding returns every supplier owed something, largest first (§21).
func (r *SupplierLedgerRepository) Outstanding(
	ctx context.Context, scope business.Scope,
) ([]Creditor, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT t.supplier_id, s.name, sum(t.amount_minor), t.currency,
		       count(*), max(t.occurred_at)
		FROM supplier_transactions t
		JOIN suppliers s ON s.id = t.supplier_id AND s.business_id = t.business_id
		WHERE t.business_id = $1
		GROUP BY t.supplier_id, s.name, t.currency
		HAVING sum(t.amount_minor) > 0
		ORDER BY sum(t.amount_minor) DESC, s.name, t.supplier_id`,
		scope.Business().ID())
	if err != nil {
		return nil, fmt.Errorf("%w: listing what is owed: %w", ErrQuery, err)
	}
	defer rows.Close()

	creditors := make([]Creditor, 0)
	for rows.Next() {
		var (
			rawSupplier  uuid.UUID
			name         string
			outstanding  int64
			currencyCode string
			entries      int
			lastMoved    time.Time
		)
		if err := rows.Scan(&rawSupplier, &name, &outstanding, &currencyCode,
			&entries, &lastMoved); err != nil {
			return nil, fmt.Errorf("%w: reading what is owed: %w", ErrQuery, err)
		}

		currency, err := money.ByCode(currencyCode)
		if err != nil {
			return nil, fmt.Errorf("%w: supplier %s: %w", ErrQuery, rawSupplier, err)
		}
		amount, err := money.New(outstanding, currency)
		if err != nil {
			return nil, fmt.Errorf("%w: supplier %s: %w", ErrQuery, rawSupplier, err)
		}

		creditors = append(creditors, Creditor{
			SupplierID:  suppliers.IDFrom(rawSupplier),
			Name:        name,
			Outstanding: amount,
			Entries:     entries,
			LastMovedAt: lastMoved.UTC(),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing what is owed: %w", ErrQuery, err)
	}
	return creditors, nil
}

func scanSupplierTransaction(row pgx.Row) (*suppliers.Transaction, error) {
	var (
		snapshot                   suppliers.TransactionSnapshot
		rawID, rawSupplier         uuid.UUID
		rawOwner                   uuid.UUID
		rawBranch, rawAccount      *uuid.UUID
		rawUser, rawDevice         uuid.UUID
		transactionType            string
		amountMinor                int64
		currencyCode               string
		referenceKind, referenceID *string
		reason                     *string
	)
	err := row.Scan(&rawID, &rawSupplier, &rawOwner, &rawBranch, &transactionType,
		&amountMinor, &currencyCode, &rawAccount, &referenceKind, &referenceID, &reason,
		&rawUser, &rawDevice, &snapshot.OccurredAt, &snapshot.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading a supplier transaction: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return nil, fmt.Errorf("%w: transaction %s: %w", ErrQuery, rawID, err)
	}
	amount, err := money.New(amountMinor, currency)
	if err != nil {
		return nil, fmt.Errorf("%w: transaction %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = suppliers.TransactionIDFrom(rawID)
	snapshot.SupplierID = suppliers.IDFrom(rawSupplier)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Type = suppliers.TransactionType(transactionType)
	snapshot.Amount = amount
	if rawAccount != nil {
		snapshot.AccountID = finance.AccountIDFrom(*rawAccount)
	}
	if referenceKind != nil && referenceID != nil {
		snapshot.Reference = suppliers.Reference{Kind: *referenceKind, ID: *referenceID}
	}
	snapshot.Reason = text(reason)
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.DeviceID = devices.IDFrom(rawDevice)

	return suppliers.RestoreTransaction(snapshot)
}
