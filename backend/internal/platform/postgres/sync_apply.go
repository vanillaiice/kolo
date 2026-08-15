package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// Effects are the changes an event makes to the domain tables.
//
// One struct rather than an argument per kind, so a new applied event type adds
// a field here and a write inside the one transaction below, rather than a
// second method that could be called beside it instead of within it.
type Effects struct {
	// Movements are appended to the ledger. Two devices' movements both stand.
	Movements []*inventory.Movement
	// Products are upserted last-write-wins, since a product is state and only
	// one edit can win (ADR-015).
	Products []*products.Product
	// Sale is a completed sale with its lines. Immutable: a replay is refused
	// by the primary key rather than overwriting financial history (§41).
	Sale *sales.Sale
	// Payments are what was paid against that sale.
	Payments []*sales.Payment
}

// IsEmpty reports whether the event changes nothing, which is true of an event
// type this build records and relays without applying.
func (e Effects) IsEmpty() bool {
	return len(e.Movements) == 0 && len(e.Products) == 0 && e.Sale == nil
}

// RecordAndApply stores an event and everything it changes, in one transaction.
//
// This has to be atomic, and the reason is easy to miss. If the event were
// recorded and the movements written separately, a failure between them would
// leave the event marked as received — so the device is told "accepted", stops
// resending, and the stock it recorded never reaches the server. Nothing
// afterwards could detect that: the event log says the event arrived.
//
// It is the same failure ADR-014 prevents on the device, on the other side of
// the wire. There, a business write and its outbox event commit together; here,
// the event and its effects do.
//
// A replay applies nothing. The event identifier collides, the transaction
// rolls back, and the caller is told the server already had it (§27).
func (r *SyncRepository) RecordAndApply(
	ctx context.Context,
	scope business.Scope,
	event *sync.Event,
	effects Effects,
) (RecordOutcome, error) {
	if err := requireScope(scope); err != nil {
		return Recorded, err
	}
	envelope := event.Envelope()
	if err := scope.Guard(envelope.BusinessID, business.BranchID{}); err != nil {
		return Recorded, err
	}
	for i, movement := range effects.Movements {
		if movement == nil {
			return Recorded, fmt.Errorf("%w: movement %d is missing", ErrQuery, i)
		}
		snapshot := movement.Snapshot()
		if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
			return Recorded, err
		}
	}
	for i, product := range effects.Products {
		if product == nil {
			return Recorded, fmt.Errorf("%w: product %d is missing", ErrQuery, i)
		}
		if err := scope.Guard(product.BusinessID(), business.BranchID{}); err != nil {
			return Recorded, err
		}
	}
	if effects.Sale != nil {
		if err := scope.Guard(effects.Sale.BusinessID(), effects.Sale.BranchID()); err != nil {
			return Recorded, err
		}
	}
	for i, payment := range effects.Payments {
		if payment == nil {
			return Recorded, fmt.Errorf("%w: payment %d is missing", ErrQuery, i)
		}
		if err := scope.Guard(payment.BusinessID(), payment.BranchID()); err != nil {
			return Recorded, err
		}
		if effects.Sale == nil || payment.SaleID() != effects.Sale.ID() {
			return Recorded, fmt.Errorf("%w: payment %s names a sale this event does not carry",
				ErrQuery, payment.ID())
		}
	}

	transaction, err := r.pool.Begin(ctx)
	if err != nil {
		return Recorded, fmt.Errorf("%w: applying event: %w", ErrQuery, err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	tag, err := transaction.Exec(ctx, `
		INSERT INTO sync_events
			(event_id, business_id, device_id, user_id, type, payload,
			 occurred_at, device_sequence, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied')
		ON CONFLICT (event_id) DO NOTHING`,
		envelope.ID.ID(), envelope.BusinessID.ID(), envelope.DeviceID.ID(), envelope.UserID.ID(),
		string(envelope.Type), []byte(envelope.Payload),
		envelope.OccurredAt, envelope.DeviceSequence)
	if err != nil {
		return Recorded, wrapWrite("recording event", err)
	}

	// Already there: the movements were applied when it first arrived, so
	// nothing more is done and the transaction is abandoned.
	if tag.RowsAffected() == 0 {
		return AlreadyRecorded, nil
	}

	for i, movement := range effects.Movements {
		if err := insertMovement(ctx, transaction, movement); err != nil {
			return Recorded, fmt.Errorf("applying movement %d of event %s: %w", i, envelope.ID, err)
		}
	}
	for i, product := range effects.Products {
		if err := upsertProduct(ctx, transaction, product); err != nil {
			return Recorded, fmt.Errorf("applying product %d of event %s: %w", i, envelope.ID, err)
		}
	}
	// A sale and its payments join the same transaction as the event and the
	// movements, so §9's fan-out lands whole or not at all — whether it was
	// recorded here or arrived from a till that has been offline for a week.
	if effects.Sale != nil {
		if err := insertSale(ctx, transaction, effects.Sale); err != nil {
			return Recorded, fmt.Errorf("applying sale of event %s: %w", envelope.ID, err)
		}
	}
	for i, payment := range effects.Payments {
		if err := insertPayment(ctx, transaction, payment); err != nil {
			return Recorded, fmt.Errorf("applying payment %d of event %s: %w", i, envelope.ID, err)
		}
	}

	if err := transaction.Commit(ctx); err != nil {
		return Recorded, wrapWrite("applying event", err)
	}
	return Recorded, nil
}

// insertMovement writes one movement using the given executor, so the same
// statement serves a pooled write and a transactional one.
func insertMovement(ctx context.Context, exec executor, movement *inventory.Movement) error {
	if _, err := exec.Exec(ctx, movementInsert, movementValues(movement)...); err != nil {
		return wrapWrite("appending movement", err)
	}
	return nil
}

// upsertProduct writes a product, keeping whichever edit wins.
//
// Last-write-wins, ordered by (updated_at, updated_by_device) — see ADR-015.
// The tie-break is not decoration: without it two devices holding the same two
// edits could settle on different prices depending on the order they arrived,
// and nothing would ever detect it. Because the comparison reads only the two
// rows, applying edits in any order gives the same answer everywhere.
//
// A losing edit updates nothing and is not an error. It lost; there is nothing
// for the caller to do about it.
//
// The identity columns are deliberately absent from the SET list. A product's
// business never changes, and an event that tried to move one into another
// tenant must not be able to (ADR-008).
func upsertProduct(ctx context.Context, exec executor, product *products.Product) error {
	_, err := exec.Exec(ctx, productInsert+`
		ON CONFLICT (id) DO UPDATE SET
			category_id           = excluded.category_id,
			name                  = excluded.name,
			sku                   = excluded.sku,
			barcode               = excluded.barcode,
			description           = excluded.description,
			brand                 = excluded.brand,
			unit                  = excluded.unit,
			divisible             = excluded.divisible,
			purchase_price_minor  = excluded.purchase_price_minor,
			selling_price_minor   = excluded.selling_price_minor,
			currency              = excluded.currency,
			tax_rate_basis_points = excluded.tax_rate_basis_points,
			minimum_stock         = excluded.minimum_stock,
			active                = excluded.active,
			updated_at            = excluded.updated_at,
			updated_by_device     = excluded.updated_by_device
		WHERE excluded.updated_at > products.updated_at
		   OR (excluded.updated_at = products.updated_at
		       AND excluded.updated_by_device > products.updated_by_device)`,
		productValues(product)...)
	if err != nil {
		return wrapWrite("applying product", err)
	}
	return nil
}

// executor is the write surface shared by the pool and a transaction, so a
// statement need not know which it is running against.
type executor interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// ensure a transaction satisfies the executor surface.
var _ executor = (pgx.Tx)(nil)
