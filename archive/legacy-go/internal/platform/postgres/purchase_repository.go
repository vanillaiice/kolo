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
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// PurchaseRepository stores deliveries and everything they produced.
//
// A purchase is never edited: the table refuses UPDATE and DELETE, and goods
// going back are a return, which is its own transaction (§41, ADR-007).
type PurchaseRepository struct {
	pool *pgxpool.Pool
}

// NewPurchaseRepository returns a repository backed by the given pool.
func NewPurchaseRepository(pool *pgxpool.Pool) *PurchaseRepository {
	return &PurchaseRepository{pool: pool}
}

const purchaseColumns = `id, business_id, branch_id, supplier_id, reference, note,
	user_id, device_id, occurred_at, recorded_at`

const purchaseItemColumns = `id, purchase_id, business_id, product_id,
	unit_cost_minor, quantity, currency`

// Record writes a purchase and everything it produced, in one transaction.
//
// This is §15's fan-out, and the transaction is the point. A delivery raises
// stock and *either* lowers a financial account or raises what the business owes
// a supplier. Any of those landing without the others describes something that
// did not happen: stock on the shelf the books never paid for, money gone with
// no goods to show for it, or a wholesaler owed nothing for a delivery they made.
//
// The movements, the money paid, and the ledger entry are passed in rather than
// derived here. Working out what a delivery moves and what it leaves owing is a
// business decision and belongs above this layer (ADR-005); this decides only
// that they land together.
func (r *PurchaseRepository) Record(
	ctx context.Context,
	scope business.Scope,
	purchase *purchases.Purchase,
	movements []*inventory.Movement,
	paid []*finance.Movement,
	owed *suppliers.Transaction,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if purchase == nil {
		return fmt.Errorf("%w: no purchase", ErrQuery)
	}
	if err := scope.Guard(purchase.BusinessID(), purchase.BranchID()); err != nil {
		return err
	}

	// Everything is checked before anything is written, so a movement for
	// another tenant cannot be discovered halfway through.
	for i, movement := range movements {
		if movement == nil {
			return fmt.Errorf("%w: movement %d is missing", ErrQuery, i)
		}
		snapshot := movement.Snapshot()
		if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
			return err
		}
	}
	for i, movement := range paid {
		if movement == nil {
			return fmt.Errorf("%w: payment %d is missing", ErrQuery, i)
		}
		if err := scope.Guard(movement.BusinessID(), movement.BranchID()); err != nil {
			return err
		}
	}
	if owed != nil {
		if err := scope.Guard(owed.BusinessID(), owed.BranchID()); err != nil {
			return err
		}
		// The debt belongs to the supplier the delivery names. An entry against
		// anyone else would put one wholesaler's goods on another's account.
		if named, is := purchase.Supplier(); !is || owed.SupplierID() != named {
			return fmt.Errorf("%w: ledger entry %s is not owed to the purchase's supplier",
				ErrQuery, owed.ID())
		}
	}

	transaction, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: recording a purchase: %w", ErrQuery, err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	if err := insertPurchase(ctx, transaction, purchase); err != nil {
		return err
	}
	// The stock the delivery brought in, in the same transaction as the
	// delivery: stock without a purchase, or a purchase without the stock, is a
	// state no report could make sense of.
	for i, movement := range movements {
		if err := insertMovement(ctx, transaction, movement); err != nil {
			return fmt.Errorf("movement %d of purchase %s: %w", i, purchase.ID(), err)
		}
	}
	// What was handed over at the door.
	for i, movement := range paid {
		if err := insertAccountMovement(ctx, transaction, movement); err != nil {
			return fmt.Errorf("payment %d of purchase %s: %w", i, purchase.ID(), err)
		}
	}
	// And what was not: the supplier is owed the rest.
	if owed != nil {
		if err := insertSupplierTransaction(ctx, transaction, owed); err != nil {
			return fmt.Errorf("the credit of purchase %s: %w", purchase.ID(), err)
		}
	}

	if err := transaction.Commit(ctx); err != nil {
		return wrapWrite("recording a purchase", err)
	}
	return nil
}

// insertPurchase writes the purchase and its lines using the given executor,
// shared by the direct write and the sync event that applies one.
func insertPurchase(ctx context.Context, exec executor, purchase *purchases.Purchase) error {
	snapshot := purchase.Snapshot()

	_, err := exec.Exec(ctx, `
		INSERT INTO purchases (`+purchaseColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		optionalSupplier(snapshot.SupplierID), optionalText(snapshot.Reference),
		optionalText(snapshot.Note), snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt)
	if err != nil {
		return wrapWrite("recording a purchase", err)
	}

	for i, item := range snapshot.Items {
		_, err := exec.Exec(ctx, `
			INSERT INTO purchase_items (`+purchaseItemColumns+`)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			item.ID.ID(), snapshot.ID.ID(), snapshot.BusinessID.ID(), item.ProductID.ID(),
			item.UnitCost.Amount(), item.Quantity.Thousandths(), item.UnitCost.Currency().Code())
		if err != nil {
			return wrapWrite(fmt.Sprintf("recording item %d of purchase %s", i, snapshot.ID), err)
		}
	}
	return nil
}

// Get returns a purchase and its lines within the scope.
func (r *PurchaseRepository) Get(
	ctx context.Context, scope business.Scope, purchaseID purchases.ID,
) (*purchases.Purchase, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if purchaseID.IsZero() {
		return nil, fmt.Errorf("%w: no purchase identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+purchaseColumns+` FROM purchases WHERE id = $1 AND business_id = $2`,
		purchaseID.ID(), scope.Business().ID())
	snapshot, err := scanPurchase(row)
	if err != nil {
		return nil, err
	}

	items, err := r.itemsOf(ctx, purchaseID)
	if err != nil {
		return nil, err
	}
	snapshot.Items = items

	return purchases.Restore(snapshot)
}

func (r *PurchaseRepository) itemsOf(
	ctx context.Context, purchaseID purchases.ID,
) ([]purchases.ItemSnapshot, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, product_id, unit_cost_minor, quantity, currency
		FROM purchase_items WHERE purchase_id = $1 ORDER BY id`,
		purchaseID.ID())
	if err != nil {
		return nil, fmt.Errorf("%w: reading purchase items: %w", ErrQuery, err)
	}
	defer rows.Close()

	items := make([]purchases.ItemSnapshot, 0)
	for rows.Next() {
		var (
			rawID, rawProduct uuid.UUID
			costMinor         int64
			amount            int64
			currencyCode      string
		)
		if err := rows.Scan(&rawID, &rawProduct, &costMinor, &amount, &currencyCode); err != nil {
			return nil, fmt.Errorf("%w: reading a purchase item: %w", ErrQuery, err)
		}

		currency, err := money.ByCode(currencyCode)
		if err != nil {
			return nil, fmt.Errorf("%w: item %s: %w", ErrQuery, rawID, err)
		}
		cost, err := money.New(costMinor, currency)
		if err != nil {
			return nil, fmt.Errorf("%w: item %s: %w", ErrQuery, rawID, err)
		}

		items = append(items, purchases.ItemSnapshot{
			ID:        purchases.ItemIDFrom(rawID),
			ProductID: products.IDFrom(rawProduct),
			UnitCost:  cost,
			Quantity:  quantity.FromThousandths(amount),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: reading purchase items: %w", ErrQuery, err)
	}
	return items, nil
}

// Between returns the purchases of a period, by when the stock arrived.
func (r *PurchaseRepository) Between(
	ctx context.Context, scope business.Scope, from, to time.Time,
) ([]*purchases.Purchase, error) {
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
		SELECT `+purchaseColumns+`
		FROM purchases
		WHERE business_id = $1
		  AND ($2::uuid IS NULL OR branch_id IS NULL OR branch_id = $2)
		  AND occurred_at >= $3 AND occurred_at < $4
		ORDER BY occurred_at, id`,
		scope.Business().ID(), optionalScopeBranch(scope), from.UTC(), to.UTC())
	if err != nil {
		return nil, fmt.Errorf("%w: listing purchases: %w", ErrQuery, err)
	}
	defer rows.Close()

	snapshots := make([]purchases.Snapshot, 0)
	for rows.Next() {
		snapshot, err := scanPurchase(rows)
		if err != nil {
			return nil, err
		}
		snapshots = append(snapshots, snapshot)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing purchases: %w", ErrQuery, err)
	}

	// The lines are fetched after the rows rather than joined into them: a
	// purchase is rebuilt through Restore, which needs its items whole.
	found := make([]*purchases.Purchase, 0, len(snapshots))
	for _, snapshot := range snapshots {
		items, err := r.itemsOf(ctx, snapshot.ID)
		if err != nil {
			return nil, err
		}
		snapshot.Items = items

		purchase, err := purchases.Restore(snapshot)
		if err != nil {
			return nil, fmt.Errorf("%w: purchase %s: %w", ErrQuery, snapshot.ID, err)
		}
		found = append(found, purchase)
	}
	return found, nil
}

func scanPurchase(row pgx.Row) (purchases.Snapshot, error) {
	var (
		snapshot               purchases.Snapshot
		rawID, rawOwner        uuid.UUID
		rawBranch, rawSupplier *uuid.UUID
		rawUser, rawDevice     uuid.UUID
		reference, note        *string
	)
	err := row.Scan(&rawID, &rawOwner, &rawBranch, &rawSupplier, &reference, &note,
		&rawUser, &rawDevice, &snapshot.OccurredAt, &snapshot.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return purchases.Snapshot{}, ErrNotFound
	}
	if err != nil {
		return purchases.Snapshot{}, fmt.Errorf("%w: reading a purchase: %w", ErrQuery, err)
	}

	snapshot.ID = purchases.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	if rawSupplier != nil {
		snapshot.SupplierID = suppliers.IDFrom(*rawSupplier)
	}
	snapshot.Reference = text(reference)
	snapshot.Note = text(note)
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.DeviceID = devices.IDFrom(rawDevice)
	return snapshot, nil
}

func optionalSupplier(supplierID suppliers.ID) *uuid.UUID {
	if supplierID.IsZero() {
		return nil
	}
	raw := supplierID.ID()
	return &raw
}
