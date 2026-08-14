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
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// MovementRepository stores the stock ledger.
//
// It appends and reads. There is deliberately no Update or Delete: the ledger
// is append-only, a correction is another movement, and the database refuses an
// edit even if one were attempted (§40, §41; ADR-009).
type MovementRepository struct {
	pool *pgxpool.Pool
}

// NewMovementRepository returns a repository backed by the given pool.
func NewMovementRepository(pool *pgxpool.Pool) *MovementRepository {
	return &MovementRepository{pool: pool}
}

const movementColumns = `id, business_id, branch_id, product_id, type, quantity,
	unit_cost_minor, unit_cost_currency, reference_kind, reference_id, reason,
	user_id, device_id, occurred_at, recorded_at`

// movementInsert appends one row to the ledger.
//
// There is exactly one of these, shared by every path that writes a movement —
// a single append, a batch, and a sync event applying one. A second copy would
// be a second place to forget a column.
const movementInsert = `
	INSERT INTO inventory_movements (` + movementColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`

// movementValues lays a movement out in the order movementInsert expects.
func movementValues(movement *inventory.Movement) []any {
	snapshot := movement.Snapshot()
	cost, currency := optionalCost(snapshot.UnitCost)
	referenceKind, referenceID := optionalReference(snapshot.Reference)

	return []any{
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		snapshot.ProductID.ID(), string(snapshot.Type), snapshot.Quantity.Thousandths(),
		cost, currency, referenceKind, referenceID, optionalText(snapshot.Reason),
		snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt,
	}
}

// Append records a movement.
func (r *MovementRepository) Append(
	ctx context.Context, scope business.Scope, movement *inventory.Movement,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := movement.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
		return err
	}

	return insertMovement(ctx, r.pool, movement)
}

// AppendAll records several movements in one transaction.
//
// A business event fans out across products — a sale of three lines moves three
// products' stock — and those movements are one fact about the business. Half of
// them landing would leave a ledger that does not describe anything that
// happened.
func (r *MovementRepository) AppendAll(
	ctx context.Context, scope business.Scope, movements []*inventory.Movement,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if len(movements) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	for i, movement := range movements {
		if movement == nil {
			return fmt.Errorf("%w: movement %d is missing", ErrQuery, i)
		}
		snapshot := movement.Snapshot()
		if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
			return err
		}

		batch.Queue(movementInsert, movementValues(movement)...)
	}

	transaction, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: appending movements: %w", ErrQuery, err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	results := transaction.SendBatch(ctx, batch)
	for i := range movements {
		if _, err := results.Exec(); err != nil {
			_ = results.Close()
			return wrapWrite(fmt.Sprintf("appending movement %d", i), err)
		}
	}
	if err := results.Close(); err != nil {
		return wrapWrite("appending movements", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return wrapWrite("appending movements", err)
	}
	return nil
}

// ListForProduct returns a product's movements, oldest first by when the stock
// actually moved.
func (r *MovementRepository) ListForProduct(
	ctx context.Context, scope business.Scope, productID products.ID,
) ([]*inventory.Movement, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if productID.IsZero() {
		return nil, fmt.Errorf("%w: no product identifier given", ErrNotFound)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+movementColumns+`
		FROM inventory_movements
		WHERE business_id = $1 AND product_id = $2
		  AND ($3::uuid IS NULL OR branch_id IS NULL OR branch_id = $3)
		ORDER BY occurred_at, id`,
		scope.Business().ID(), productID.ID(), optionalScopeBranch(scope))
	if err != nil {
		return nil, fmt.Errorf("%w: listing movements: %w", ErrQuery, err)
	}
	defer rows.Close()

	return collectMovements(rows)
}

// StockOf returns a product's current stock level.
//
// The sum is computed by the database rather than by loading every movement and
// adding them here. A product sold for a year has thousands of movements, and a
// till asking "how many are left" must not pay for all of them (§46). The
// answer is identical either way — it is the same addition — which is what
// makes the query safe to prefer.
func (r *MovementRepository) StockOf(
	ctx context.Context, scope business.Scope, productID products.ID,
) (inventory.StockLevel, error) {
	return r.stockAsOf(ctx, scope, productID, nil)
}

// StockAsOf returns what a product's stock was at a given moment.
//
// It counts by when stock moved, not when the system heard about it, so a
// movement synced days late still lands in the period it belongs to.
func (r *MovementRepository) StockAsOf(
	ctx context.Context, scope business.Scope, productID products.ID, asOf time.Time,
) (inventory.StockLevel, error) {
	if asOf.IsZero() {
		return inventory.StockLevel{}, fmt.Errorf("%w: no moment given", inventory.ErrInvalidTime)
	}
	moment := asOf.UTC()
	return r.stockAsOf(ctx, scope, productID, &moment)
}

func (r *MovementRepository) stockAsOf(
	ctx context.Context, scope business.Scope, productID products.ID, asOf *time.Time,
) (inventory.StockLevel, error) {
	if err := requireScope(scope); err != nil {
		return inventory.StockLevel{}, err
	}
	if productID.IsZero() {
		return inventory.StockLevel{}, fmt.Errorf("%w: no product identifier given", ErrNotFound)
	}

	var (
		onHand    int64
		movements int
		lastMoved *time.Time
	)
	err := r.pool.QueryRow(ctx, `
		SELECT coalesce(sum(quantity), 0), count(*), max(occurred_at)
		FROM inventory_movements
		WHERE business_id = $1 AND product_id = $2
		  AND ($3::uuid IS NULL OR branch_id IS NULL OR branch_id = $3)
		  AND ($4::timestamptz IS NULL OR occurred_at <= $4)`,
		scope.Business().ID(), productID.ID(), optionalScopeBranch(scope), asOf,
	).Scan(&onHand, &movements, &lastMoved)
	if err != nil {
		return inventory.StockLevel{}, fmt.Errorf("%w: deriving stock: %w", ErrQuery, err)
	}

	level := inventory.StockLevel{
		ProductID: productID,
		OnHand:    quantity.FromThousandths(onHand),
		Movements: movements,
	}
	if lastMoved != nil {
		level.LastMovedAt = lastMoved.UTC()
	}
	return level, nil
}

// LowStock returns the products at or below their reorder point.
//
// The comparison happens in the database because the alternative — loading
// every product and every movement to compare in memory — is what makes a
// dashboard slow on the hardware this has to run on (§21, §46). Products with a
// reorder point of zero are not tracked and are absent.
func (r *MovementRepository) LowStock(
	ctx context.Context, scope business.Scope,
) ([]LowStockItem, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT p.id, p.name, p.minimum_stock,
		       coalesce(sum(m.quantity) FILTER (
		           WHERE $2::uuid IS NULL OR m.branch_id IS NULL OR m.branch_id = $2
		       ), 0) AS on_hand
		FROM products p
		LEFT JOIN inventory_movements m
		       ON m.product_id = p.id AND m.business_id = p.business_id
		WHERE p.business_id = $1 AND p.active AND p.minimum_stock > 0
		GROUP BY p.id, p.name, p.minimum_stock
		HAVING coalesce(sum(m.quantity) FILTER (
		           WHERE $2::uuid IS NULL OR m.branch_id IS NULL OR m.branch_id = $2
		       ), 0) <= p.minimum_stock
		ORDER BY p.name, p.id`,
		scope.Business().ID(), optionalScopeBranch(scope))
	if err != nil {
		return nil, fmt.Errorf("%w: listing low stock: %w", ErrQuery, err)
	}
	defer rows.Close()

	items := make([]LowStockItem, 0)
	for rows.Next() {
		var (
			rawID           uuid.UUID
			name            string
			minimum, onHand int64
		)
		if err := rows.Scan(&rawID, &name, &minimum, &onHand); err != nil {
			return nil, fmt.Errorf("%w: reading low stock: %w", ErrQuery, err)
		}
		items = append(items, LowStockItem{
			ProductID: products.IDFrom(rawID),
			Name:      name,
			OnHand:    quantity.FromThousandths(onHand),
			Minimum:   quantity.FromThousandths(minimum),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing low stock: %w", ErrQuery, err)
	}
	return items, nil
}

// LowStockItem is a product that has reached its reorder point.
type LowStockItem struct {
	ProductID products.ID
	Name      string
	OnHand    quantity.Quantity
	Minimum   quantity.Quantity
}

func collectMovements(rows pgx.Rows) ([]*inventory.Movement, error) {
	movements := make([]*inventory.Movement, 0)
	for rows.Next() {
		movement, err := scanMovement(rows)
		if err != nil {
			return nil, err
		}
		movements = append(movements, movement)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: reading movements: %w", ErrQuery, err)
	}
	return movements, nil
}

func scanMovement(row pgx.Row) (*inventory.Movement, error) {
	var (
		snapshot                    inventory.Snapshot
		rawID, rawOwner, rawProduct uuid.UUID
		rawUser, rawDevice          uuid.UUID
		rawBranch                   *uuid.UUID
		movementType                string
		amount                      int64
		costMinor                   *int64
		costCurrency                *string
		referenceKind, referenceID  *string
		reason                      *string
	)
	err := row.Scan(&rawID, &rawOwner, &rawBranch, &rawProduct, &movementType, &amount,
		&costMinor, &costCurrency, &referenceKind, &referenceID, &reason,
		&rawUser, &rawDevice, &snapshot.OccurredAt, &snapshot.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading movement: %w", ErrQuery, err)
	}

	snapshot.ID = inventory.MovementIDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	snapshot.ProductID = products.IDFrom(rawProduct)
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.DeviceID = devices.IDFrom(rawDevice)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Type = inventory.MovementType(movementType)
	snapshot.Quantity = quantity.FromThousandths(amount)

	if costMinor != nil && costCurrency != nil {
		currency, err := money.ByCode(*costCurrency)
		if err != nil {
			return nil, fmt.Errorf("%w: movement %s: %w", ErrQuery, rawID, err)
		}
		cost, err := money.New(*costMinor, currency)
		if err != nil {
			return nil, fmt.Errorf("%w: movement %s: %w", ErrQuery, rawID, err)
		}
		snapshot.UnitCost = cost
	}
	if referenceKind != nil && referenceID != nil {
		snapshot.Reference = inventory.Reference{Kind: *referenceKind, ID: *referenceID}
	}
	if reason != nil {
		snapshot.Reason = *reason
	}

	return inventory.Restore(snapshot)
}

// optionalCost splits a money value into the two nullable columns that hold it.
func optionalCost(cost money.Money) (*int64, *string) {
	if !cost.Valid() {
		return nil, nil
	}
	amount := cost.Amount()
	code := cost.Currency().Code()
	return &amount, &code
}

func optionalReference(reference inventory.Reference) (*string, *string) {
	if reference.IsZero() {
		return nil, nil
	}
	kind, identifier := reference.Kind, reference.ID
	return &kind, &identifier
}

// optionalText renders an empty string as SQL NULL, so "not recorded" is
// absence rather than a blank that reads as a recorded empty value.
func optionalText(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
