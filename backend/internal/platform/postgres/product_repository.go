package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// ProductRepository stores what a business sells.
//
// It holds no stock level. Stock is the ledger's sum, and a column here would
// be a second version of the same truth (§59, ADR-009).
type ProductRepository struct {
	pool *pgxpool.Pool
}

// NewProductRepository returns a repository backed by the given pool.
func NewProductRepository(pool *pgxpool.Pool) *ProductRepository {
	return &ProductRepository{pool: pool}
}

const productColumns = `id, business_id, category_id, name, sku, barcode, description, brand,
	unit, divisible, purchase_price_minor, selling_price_minor, currency,
	tax_rate_basis_points, minimum_stock, active, created_at, updated_at`

// Create stores a new product within the scope's business.
func (r *ProductRepository) Create(ctx context.Context, scope business.Scope, product *products.Product) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := product.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	purchase, currency := productPrices(snapshot)
	_, err := r.pool.Exec(ctx, `
		INSERT INTO products (`+productColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalCategory(snapshot.CategoryID),
		snapshot.Name, optionalText(snapshot.SKU), optionalText(snapshot.Barcode),
		optionalText(snapshot.Description), optionalText(snapshot.Brand),
		snapshot.Unit, snapshot.Divisible,
		purchase, snapshot.SellingPrice.Amount(), currency,
		snapshot.TaxRateBasisPoints, snapshot.MinimumStock.Thousandths(),
		snapshot.Active, snapshot.CreatedAt, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("creating product", err)
	}
	return nil
}

// Get returns a product within the scope.
func (r *ProductRepository) Get(
	ctx context.Context, scope business.Scope, productID products.ID,
) (*products.Product, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if productID.IsZero() {
		return nil, fmt.Errorf("%w: no product identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+productColumns+` FROM products WHERE id = $1 AND business_id = $2`,
		productID.ID(), scope.Business().ID())
	return scanProduct(row)
}

// FindByBarcode returns the product a scanned code belongs to.
//
// This is the POS's hot path: a cashier scans, and the product must appear
// without a perceptible pause (§46, §47). The unique index on
// (business_id, barcode) is what makes it a single lookup.
func (r *ProductRepository) FindByBarcode(
	ctx context.Context, scope business.Scope, barcode string,
) (*products.Product, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if barcode == "" {
		return nil, fmt.Errorf("%w: no barcode given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+productColumns+` FROM products WHERE business_id = $1 AND barcode = $2`,
		scope.Business().ID(), barcode)
	return scanProduct(row)
}

// List returns the products of the scope's business, ordered by name.
//
// activeOnly is what a till wants; an administration screen passes false to see
// what has been withdrawn from sale.
func (r *ProductRepository) List(
	ctx context.Context, scope business.Scope, activeOnly bool,
) ([]*products.Product, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+productColumns+`
		FROM products
		WHERE business_id = $1 AND (NOT $2::boolean OR active)
		ORDER BY name, id`,
		scope.Business().ID(), activeOnly)
	if err != nil {
		return nil, fmt.Errorf("%w: listing products: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*products.Product, 0)
	for rows.Next() {
		product, err := scanProduct(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, product)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing products: %w", ErrQuery, err)
	}
	return found, nil
}

// Update writes a product's current state, within the scope.
func (r *ProductRepository) Update(ctx context.Context, scope business.Scope, product *products.Product) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := product.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	purchase, currency := productPrices(snapshot)
	tag, err := r.pool.Exec(ctx, `
		UPDATE products
		SET category_id = $3, name = $4, sku = $5, barcode = $6, description = $7, brand = $8,
		    unit = $9, divisible = $10, purchase_price_minor = $11, selling_price_minor = $12,
		    currency = $13, tax_rate_basis_points = $14, minimum_stock = $15,
		    active = $16, updated_at = $17
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalCategory(snapshot.CategoryID),
		snapshot.Name, optionalText(snapshot.SKU), optionalText(snapshot.Barcode),
		optionalText(snapshot.Description), optionalText(snapshot.Brand),
		snapshot.Unit, snapshot.Divisible,
		purchase, snapshot.SellingPrice.Amount(), currency,
		snapshot.TaxRateBasisPoints, snapshot.MinimumStock.Thousandths(),
		snapshot.Active, snapshot.UpdatedAt)
	if err != nil {
		return wrapWrite("updating product", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: product %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

func scanProduct(row pgx.Row) (*products.Product, error) {
	var (
		snapshot                         products.Snapshot
		rawID, rawOwner                  uuid.UUID
		rawCategory                      *uuid.UUID
		sku, barcode, description, brand *string
		purchaseMinor                    *int64
		sellingMinor                     int64
		currencyCode                     string
		minimumStock                     int64
	)
	err := row.Scan(&rawID, &rawOwner, &rawCategory, &snapshot.Name, &sku, &barcode,
		&description, &brand, &snapshot.Unit, &snapshot.Divisible,
		&purchaseMinor, &sellingMinor, &currencyCode,
		&snapshot.TaxRateBasisPoints, &minimumStock,
		&snapshot.Active, &snapshot.CreatedAt, &snapshot.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading product: %w", ErrQuery, err)
	}

	currency, err := money.ByCode(currencyCode)
	if err != nil {
		return nil, fmt.Errorf("%w: product %s: %w", ErrQuery, rawID, err)
	}
	selling, err := money.New(sellingMinor, currency)
	if err != nil {
		return nil, fmt.Errorf("%w: product %s: %w", ErrQuery, rawID, err)
	}

	snapshot.ID = products.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawCategory != nil {
		snapshot.CategoryID = products.CategoryIDFrom(*rawCategory)
	}
	snapshot.SKU = text(sku)
	snapshot.Barcode = text(barcode)
	snapshot.Description = text(description)
	snapshot.Brand = text(brand)
	snapshot.SellingPrice = selling
	snapshot.MinimumStock = quantity.FromThousandths(minimumStock)

	if purchaseMinor != nil {
		purchase, err := money.New(*purchaseMinor, currency)
		if err != nil {
			return nil, fmt.Errorf("%w: product %s: %w", ErrQuery, rawID, err)
		}
		snapshot.PurchasePrice = purchase
	}

	return products.Restore(snapshot)
}

// productPrices renders the purchase price and the shared currency.
//
// One currency column serves both prices, because the domain refuses a product
// whose prices are in different currencies. The selling price is required, so
// its currency is always the one to store.
func productPrices(snapshot products.Snapshot) (*int64, string) {
	currency := snapshot.SellingPrice.Currency().Code()
	if !snapshot.PurchasePrice.Valid() {
		return nil, currency
	}
	amount := snapshot.PurchasePrice.Amount()
	return &amount, currency
}

func optionalCategory(categoryID products.CategoryID) *uuid.UUID {
	if categoryID.IsZero() {
		return nil
	}
	value := categoryID.ID()
	return &value
}

func text(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
