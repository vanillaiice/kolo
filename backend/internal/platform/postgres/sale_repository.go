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
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// SaleRepository stores sales, their lines, and their payments.
//
// A sale is never edited. The table refuses UPDATE and DELETE outright, so a
// correction has to be a compensating transaction even for a support script
// (§41, ADR-007) — the same rule the inventory ledger keeps, for the same
// reason.
type SaleRepository struct {
	pool *pgxpool.Pool
}

// NewSaleRepository returns a repository backed by the given pool.
func NewSaleRepository(pool *pgxpool.Pool) *SaleRepository {
	return &SaleRepository{pool: pool}
}

const saleColumns = `id, business_id, branch_id, customer_id, number,
	discount_minor, currency, note, user_id, device_id, occurred_at, recorded_at`

const saleItemColumns = `id, sale_id, business_id, product_id, name,
	unit_price_minor, quantity, discount_minor, tax_rate_basis_points,
	unit_cost_minor, currency`

const salePaymentColumns = `id, sale_id, business_id, branch_id, account_id,
	amount_minor, currency, reference, note, user_id, device_id,
	occurred_at, recorded_at`

// Record writes a sale and everything it produced, in one transaction.
//
// This is §9's fan-out, and the transaction is the whole point. A sale produces
// a sale record, its lines, one or more payments, and the stock movements that
// released the goods. Any of those landing without the others describes
// something that did not happen: money taken for stock still on the shelf, or
// stock gone with no record of who paid for it.
//
// The movements and the credit entry are passed in rather than derived here.
// Working out what a sale moves and what it leaves owing is a business decision
// — which is a return, which was already delivered — and belongs above this
// layer (ADR-005). This decides only that they land together.
//
// credit is nil for a sale paid in full, and is the customer's ledger entry for
// one that is not. A sale stored without it would be goods gone with nobody
// recorded as owing for them, which no report could detect afterwards: the sale
// looks complete on its own.
func (r *SaleRepository) Record(
	ctx context.Context,
	scope business.Scope,
	sale *sales.Sale,
	payments []*sales.Payment,
	movements []*inventory.Movement,
	credit *customers.Transaction,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if sale == nil {
		return fmt.Errorf("%w: no sale", ErrQuery)
	}
	if err := scope.Guard(sale.BusinessID(), sale.BranchID()); err != nil {
		return err
	}

	// Everything is checked against the scope before anything is written, so a
	// payment for another tenant cannot be discovered halfway through.
	for i, payment := range payments {
		if payment == nil {
			return fmt.Errorf("%w: payment %d is missing", ErrQuery, i)
		}
		if err := scope.Guard(payment.BusinessID(), payment.BranchID()); err != nil {
			return err
		}
		if payment.SaleID() != sale.ID() {
			return fmt.Errorf("%w: payment %s is for sale %s, not %s",
				ErrQuery, payment.ID(), payment.SaleID(), sale.ID())
		}
	}
	for i, movement := range movements {
		if movement == nil {
			return fmt.Errorf("%w: movement %d is missing", ErrQuery, i)
		}
		snapshot := movement.Snapshot()
		if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
			return err
		}
	}
	if credit != nil {
		if err := scope.Guard(credit.BusinessID(), credit.BranchID()); err != nil {
			return err
		}
		// The debt belongs to the person the sale names. An entry against
		// anyone else would put one customer's purchase on another's account.
		if named, is := sale.Customer(); !is || credit.CustomerID() != named {
			return fmt.Errorf("%w: credit entry %s is not owed by the sale's customer",
				ErrQuery, credit.ID())
		}
	}

	transaction, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: recording a sale: %w", ErrQuery, err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	if err := insertSale(ctx, transaction, sale); err != nil {
		return err
	}
	for i, payment := range payments {
		if err := insertPayment(ctx, transaction, payment); err != nil {
			return fmt.Errorf("payment %d of sale %s: %w", i, sale.ID(), err)
		}
	}
	// The movements go in the same transaction as the sale that caused them.
	// Stock released without a sale, or a sale without the stock leaving, are
	// both states no report could make sense of.
	for i, movement := range movements {
		if err := insertMovement(ctx, transaction, movement); err != nil {
			return fmt.Errorf("movement %d of sale %s: %w", i, sale.ID(), err)
		}
	}

	// The credit entry is part of the same fan-out. §13's balance is the sum of
	// this ledger, so an entry that did not land is a customer who owes less
	// than they took, in a total nobody can reconcile against the sale.
	if credit != nil {
		if err := insertCreditTransaction(ctx, transaction, credit); err != nil {
			return fmt.Errorf("the credit of sale %s: %w", sale.ID(), err)
		}
	}

	if err := transaction.Commit(ctx); err != nil {
		return wrapWrite("recording a sale", err)
	}
	return nil
}

// insertSale writes the sale, its lines, and its payments using the given
// executor.
//
// Shared by the direct write and by the sync event that applies a sale from
// another device, so both produce identical rows.
func insertSale(ctx context.Context, exec executor, sale *sales.Sale) error {
	snapshot := sale.Snapshot()

	total, err := sale.Total()
	if err != nil {
		return fmt.Errorf("%w: totalling sale %s: %w", ErrQuery, snapshot.ID, err)
	}
	currency := total.Currency().Code()

	if _, err := exec.Exec(ctx, `
		INSERT INTO sales (`+saleColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		optionalCustomer(snapshot.CustomerID), snapshot.Number,
		snapshot.Discount.Amount(), currency, optionalText(snapshot.Note),
		snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt); err != nil {
		return wrapWrite("recording a sale", err)
	}

	for i, item := range snapshot.Items {
		cost, _ := optionalMoney(item.UnitCost)
		if _, err := exec.Exec(ctx, `
			INSERT INTO sale_items (`+saleItemColumns+`)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			item.ID.ID(), snapshot.ID.ID(), snapshot.BusinessID.ID(), item.ProductID.ID(),
			item.Name, item.UnitPrice.Amount(), item.Quantity.Thousandths(),
			item.Discount.Amount(), item.TaxRateBasisPoints, cost, currency); err != nil {
			return wrapWrite(fmt.Sprintf("recording sale item %d", i), err)
		}
	}
	return nil
}

func insertPayment(ctx context.Context, exec executor, payment *sales.Payment) error {
	snapshot := payment.Snapshot()

	if _, err := exec.Exec(ctx, `
		INSERT INTO sale_payments (`+salePaymentColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		snapshot.ID.ID(), snapshot.SaleID.ID(), snapshot.BusinessID.ID(),
		optionalBranch(snapshot.BranchID), snapshot.AccountID.ID(),
		snapshot.Amount.Amount(), snapshot.Amount.Currency().Code(),
		optionalText(snapshot.Reference), optionalText(snapshot.Note),
		snapshot.UserID.ID(), snapshot.DeviceID.ID(),
		snapshot.OccurredAt, snapshot.RecordedAt); err != nil {
		return wrapWrite("recording a payment", err)
	}
	return nil
}

// Get returns a sale with its lines, within the scope.
func (r *SaleRepository) Get(
	ctx context.Context, scope business.Scope, saleID sales.ID,
) (*sales.Sale, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+saleColumns+`
		  FROM sales
		 WHERE id = $1 AND business_id = $2`,
		saleID.ID(), scope.Business().ID())

	snapshot, err := scanSale(row)
	if err != nil {
		return nil, err
	}

	items, err := r.itemsOf(ctx, saleID)
	if err != nil {
		return nil, err
	}
	snapshot.Items = items

	sale, err := sales.Restore(snapshot)
	if err != nil {
		return nil, fmt.Errorf("%w: sale %s: %w", ErrQuery, saleID, err)
	}
	return sale, nil
}

func (r *SaleRepository) itemsOf(ctx context.Context, saleID sales.ID) ([]sales.ItemSnapshot, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+saleItemColumns+`
		  FROM sale_items
		 WHERE sale_id = $1
		 ORDER BY id`, saleID.ID())
	if err != nil {
		return nil, fmt.Errorf("%w: reading sale items: %w", ErrQuery, err)
	}
	defer rows.Close()

	items := make([]sales.ItemSnapshot, 0, 8)
	for rows.Next() {
		var (
			item                     sales.ItemSnapshot
			rawID, rawSale, rawOwner uuid.UUID
			rawProduct               uuid.UUID
			priceMinor, discount     int64
			amount                   int64
			cost                     *int64
			currencyCode             string
		)
		if err := rows.Scan(&rawID, &rawSale, &rawOwner, &rawProduct, &item.Name,
			&priceMinor, &amount, &discount, &item.TaxRateBasisPoints,
			&cost, &currencyCode); err != nil {
			return nil, fmt.Errorf("%w: reading a sale item: %w", ErrQuery, err)
		}

		currency, err := money.ByCode(currencyCode)
		if err != nil {
			return nil, fmt.Errorf("%w: sale item %s: %w", ErrQuery, rawID, err)
		}
		item.ID = sales.ItemIDFrom(rawID)
		item.ProductID = products.IDFrom(rawProduct)
		item.Quantity = quantity.FromThousandths(amount)
		if item.UnitPrice, err = money.New(priceMinor, currency); err != nil {
			return nil, fmt.Errorf("%w: sale item %s: %w", ErrQuery, rawID, err)
		}
		if item.Discount, err = money.New(discount, currency); err != nil {
			return nil, fmt.Errorf("%w: sale item %s: %w", ErrQuery, rawID, err)
		}
		if cost != nil {
			if item.UnitCost, err = money.New(*cost, currency); err != nil {
				return nil, fmt.Errorf("%w: sale item %s: %w", ErrQuery, rawID, err)
			}
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: reading sale items: %w", ErrQuery, err)
	}
	return items, nil
}

// PaymentsOf returns what was paid against a sale, oldest first.
func (r *SaleRepository) PaymentsOf(
	ctx context.Context, scope business.Scope, saleID sales.ID,
) ([]*sales.Payment, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+salePaymentColumns+`
		  FROM sale_payments
		 WHERE sale_id = $1 AND business_id = $2
		 ORDER BY occurred_at, id`,
		saleID.ID(), scope.Business().ID())
	if err != nil {
		return nil, fmt.Errorf("%w: reading payments: %w", ErrQuery, err)
	}
	defer rows.Close()

	payments := make([]*sales.Payment, 0, 4)
	for rows.Next() {
		var (
			snapshot                       sales.PaymentSnapshot
			rawID, rawSale, rawOwner       uuid.UUID
			rawBranch                      *uuid.UUID
			rawAccount, rawUser, rawDevice uuid.UUID
			amountMinor                    int64
			currencyCode                   string
			reference, note                *string
		)
		if err := rows.Scan(&rawID, &rawSale, &rawOwner, &rawBranch, &rawAccount,
			&amountMinor, &currencyCode, &reference, &note, &rawUser, &rawDevice,
			&snapshot.OccurredAt, &snapshot.RecordedAt); err != nil {
			return nil, fmt.Errorf("%w: reading a payment: %w", ErrQuery, err)
		}

		currency, err := money.ByCode(currencyCode)
		if err != nil {
			return nil, fmt.Errorf("%w: payment %s: %w", ErrQuery, rawID, err)
		}
		if snapshot.Amount, err = money.New(amountMinor, currency); err != nil {
			return nil, fmt.Errorf("%w: payment %s: %w", ErrQuery, rawID, err)
		}

		snapshot.ID = sales.PaymentIDFrom(rawID)
		snapshot.SaleID = sales.IDFrom(rawSale)
		snapshot.BusinessID = business.IDFrom(rawOwner)
		if rawBranch != nil {
			snapshot.BranchID = business.BranchIDFrom(*rawBranch)
		}
		snapshot.AccountID = finance.AccountIDFrom(rawAccount)
		snapshot.Reference = text(reference)
		snapshot.Note = text(note)
		snapshot.UserID = users.IDFrom(rawUser)
		snapshot.DeviceID = devices.IDFrom(rawDevice)

		payment, err := sales.RestorePayment(snapshot)
		if err != nil {
			return nil, fmt.Errorf("%w: payment %s: %w", ErrQuery, rawID, err)
		}
		payments = append(payments, payment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: reading payments: %w", ErrQuery, err)
	}
	return payments, nil
}

// Between returns the sales in a period, newest first.
//
// It slices on when the sale happened rather than when it was recorded: a
// day's takings means the day the shop traded, not the day a device happened
// to sync (§21).
func (r *SaleRepository) Between(
	ctx context.Context, scope business.Scope, from, to time.Time, limit int,
) ([]*sales.Sale, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, fmt.Errorf("%w: a limit must be positive, got %d", ErrQuery, limit)
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+saleColumns+`
		  FROM sales
		 WHERE business_id = $1 AND occurred_at >= $2 AND occurred_at < $3
		 ORDER BY occurred_at DESC, id
		 LIMIT $4`,
		scope.Business().ID(), from, to, limit)
	if err != nil {
		return nil, fmt.Errorf("%w: reading sales: %w", ErrQuery, err)
	}

	snapshots := make([]sales.Snapshot, 0, 16)
	for rows.Next() {
		snapshot, err := scanSale(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		snapshots = append(snapshots, snapshot)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: reading sales: %w", ErrQuery, err)
	}

	found := make([]*sales.Sale, 0, len(snapshots))
	for _, snapshot := range snapshots {
		items, err := r.itemsOf(ctx, snapshot.ID)
		if err != nil {
			return nil, err
		}
		snapshot.Items = items

		sale, err := sales.Restore(snapshot)
		if err != nil {
			return nil, fmt.Errorf("%w: sale %s: %w", ErrQuery, snapshot.ID, err)
		}
		found = append(found, sale)
	}
	return found, nil
}

func scanSale(row pgx.Row) (sales.Snapshot, error) {
	var (
		snapshot               sales.Snapshot
		rawID, rawOwner        uuid.UUID
		rawBranch, rawCustomer *uuid.UUID
		rawUser, rawDevice     uuid.UUID
		discountMinor          int64
		currencyCode           string
		note                   *string
	)
	err := row.Scan(&rawID, &rawOwner, &rawBranch, &rawCustomer, &snapshot.Number,
		&discountMinor, &currencyCode, &note, &rawUser, &rawDevice,
		&snapshot.OccurredAt, &snapshot.RecordedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return sales.Snapshot{}, ErrNotFound
	}
	if err != nil {
		return sales.Snapshot{}, fmt.Errorf("%w: reading a sale: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return sales.Snapshot{}, fmt.Errorf("%w: sale %s: %w", ErrQuery, rawID, err)
	}
	discount, err := money.New(discountMinor, currency)
	if err != nil {
		return sales.Snapshot{}, fmt.Errorf("%w: sale %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = sales.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	if rawCustomer != nil {
		snapshot.CustomerID = customers.IDFrom(*rawCustomer)
	}
	snapshot.Discount = discount
	snapshot.Note = text(note)
	snapshot.UserID = users.IDFrom(rawUser)
	snapshot.DeviceID = devices.IDFrom(rawDevice)
	return snapshot, nil
}

func optionalCustomer(customerID customers.ID) *uuid.UUID {
	if customerID.IsZero() {
		return nil
	}
	raw := customerID.ID()
	return &raw
}
