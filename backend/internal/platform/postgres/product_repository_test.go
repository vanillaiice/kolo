package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

func newProductRepository(t *testing.T) (*postgres.ProductRepository, *postgres.BusinessRepository, context.Context) {
	t.Helper()
	pool := pgtest.Pool(t)
	return postgres.NewProductRepository(pool), postgres.NewBusinessRepository(pool), context.Background()
}

// fullProduct exercises every column, including the optional ones, so the
// mapping is checked rather than only the required half.
func fullProduct(t *testing.T, tenant business.ID) *products.Product {
	t.Helper()

	product, err := products.New(products.Snapshot{
		ID:                 products.NewID(),
		BusinessID:         tenant,
		Name:               "Riz parfumé 5kg",
		SKU:                "RIZ-5KG",
		Barcode:            "6001234567890",
		Description:        "Riz parfumé importé.",
		Brand:              "Uncle Sam",
		Unit:               "sac",
		Divisible:          false,
		PurchasePrice:      money.FromXAF(5_000),
		SellingPrice:       money.FromXAF(6_500),
		TaxRateBasisPoints: 1_925,
		MinimumStock:       quantity.MustParse("10"),
		CreatedAt:          createdAt,
		UpdatedAt:          createdAt,
	})
	if err != nil {
		t.Fatalf("products.New: %v", err)
	}
	return product
}

func minimalProduct(t *testing.T, tenant business.ID, name string) *products.Product {
	t.Helper()

	product, err := products.New(products.Snapshot{
		ID:           products.NewID(),
		BusinessID:   tenant,
		Name:         name,
		Unit:         "pièce",
		SellingPrice: money.FromXAF(500),
		CreatedAt:    createdAt,
		UpdatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("products.New: %v", err)
	}
	return product
}

func TestCreateAndGetProduct(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := fullProduct(t, tenant.ID())
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
}

// TestAnUnknownPurchasePriceStaysUnknown is the round trip that matters for §8:
// a null must come back as "not known", not as zero, or every report would show
// a product bought for nothing at full margin.
func TestAnUnknownPurchasePriceStaysUnknown(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := minimalProduct(t, tenant.ID(), "Riz parfumé 5kg")
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if price, known := loaded.PurchasePrice(); known {
		t.Errorf("an unknown purchase price came back as %s", price)
	}
	if _, computable := loaded.Margin(); computable {
		t.Error("a margin was computed for a product with no purchase price")
	}
	// The optional text fields are likewise absent rather than blank strings
	// that read as recorded.
	if _, has := loaded.SKU(); has {
		t.Error("an unset SKU came back as present")
	}
	if _, filed := loaded.CategoryID(); filed {
		t.Error("an unset category came back as present")
	}
}

// TestFindByBarcodeIsThePOSPath: a cashier scans and the product must appear.
func TestFindByBarcodeIsThePOSPath(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := fullProduct(t, tenant.ID())
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	found, err := repo.FindByBarcode(ctx, scope, "6001234567890")
	if err != nil {
		t.Fatalf("FindByBarcode: %v", err)
	}
	if found.ID() != created.ID() {
		t.Errorf("found %s, want %s", found.ID(), created.ID())
	}

	if _, err := repo.FindByBarcode(ctx, scope, "9999999999999"); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("an unknown barcode: got %v, want ErrNotFound", err)
	}
	if _, err := repo.FindByBarcode(ctx, scope, ""); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("an empty barcode: got %v, want ErrNotFound", err)
	}
}

// TestCodesAreUniquePerBusinessNotGlobally: two shops may each sell the same
// manufacturer's barcode, and a global constraint would leave one unable to
// record it.
func TestCodesAreUniquePerBusinessNotGlobally(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)

	first, scopeA := newTenant(t, businesses, ctx)
	second, scopeB := newTenant(t, businesses, ctx)

	if err := repo.Create(ctx, scopeA, fullProduct(t, first.ID())); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// The same barcode under another business is legitimate.
	if err := repo.Create(ctx, scopeB, fullProduct(t, second.ID())); err != nil {
		t.Errorf("the same barcode was refused under another business: %v", err)
	}
	// Twice within one business is not.
	if err := repo.Create(ctx, scopeA, fullProduct(t, first.ID())); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}

	// And each business finds only its own.
	found, err := repo.FindByBarcode(ctx, scopeB, "6001234567890")
	if err != nil {
		t.Fatalf("FindByBarcode: %v", err)
	}
	if found.BusinessID() != second.ID() {
		t.Errorf("business B found a product belonging to %s", found.BusinessID())
	}
}

func TestUpdateProduct(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	product := minimalProduct(t, tenant.ID(), "Riz parfumé 5kg")
	if err := repo.Create(ctx, scope, product); err != nil {
		t.Fatalf("Create: %v", err)
	}

	at := createdAt.Add(time.Hour)
	if err := product.Reprice(money.FromXAF(5_000), money.FromXAF(7_000), at); err != nil {
		t.Fatalf("Reprice: %v", err)
	}
	if err := product.SetCodes("RIZ-5KG", "6001234567890", at); err != nil {
		t.Fatalf("SetCodes: %v", err)
	}
	if err := product.SetMinimumStock(quantity.MustParse("10"), at); err != nil {
		t.Fatalf("SetMinimumStock: %v", err)
	}
	if err := product.Deactivate(at); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if err := repo.Update(ctx, scope, product); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, product.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != product.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), product.Snapshot())
	}
	if purchase, known := loaded.PurchasePrice(); !known || purchase.Amount() != 5_000 {
		t.Errorf("PurchasePrice() = %s, %v", purchase, known)
	}
	if loaded.IsActive() {
		t.Error("the product is still active after being deactivated")
	}
}

// TestClearingACodeStoresNull keeps a cleared barcode from colliding with every
// other cleared one under the unique index.
func TestClearingACodeStoresNull(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	first := fullProduct(t, tenant.ID())
	if err := repo.Create(ctx, scope, first); err != nil {
		t.Fatalf("Create: %v", err)
	}

	at := createdAt.Add(time.Hour)
	if err := first.SetCodes("", "", at); err != nil {
		t.Fatalf("SetCodes: %v", err)
	}
	if err := repo.Update(ctx, scope, first); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// A second product with no codes must not collide with the first.
	second := minimalProduct(t, tenant.ID(), "Huile 1L")
	if err := repo.Create(ctx, scope, second); err != nil {
		t.Errorf("a second product without codes was refused: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, first.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, has := loaded.Barcode(); has {
		t.Error("the barcode was not cleared")
	}
}

func TestListProducts(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	for _, name := range []string{"Sucre", "Huile", "Riz"} {
		if err := repo.Create(ctx, scope, minimalProduct(t, tenant.ID(), name)); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	withdrawn := minimalProduct(t, tenant.ID(), "Ancien produit")
	if err := withdrawn.Deactivate(createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if err := repo.Create(ctx, scope, withdrawn); err != nil {
		t.Fatalf("Create: %v", err)
	}

	active, err := repo.List(ctx, scope, true)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(active) != 3 {
		t.Fatalf("got %d active products, want 3", len(active))
	}
	for i, want := range []string{"Huile", "Riz", "Sucre"} {
		if got := active[i].Name(); got != want {
			t.Errorf("product %d = %q, want %q", i, got, want)
		}
	}

	// An administration screen sees what has been withdrawn.
	all, err := repo.List(ctx, scope, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 4 {
		t.Errorf("got %d products in all, want 4", len(all))
	}
}

func TestOneTenantCannotReachAnothersProducts(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)

	first, scopeA := newTenant(t, businesses, ctx)
	_, scopeB := newTenant(t, businesses, ctx)

	product := fullProduct(t, first.ID())
	if err := repo.Create(ctx, scopeA, product); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := repo.Get(ctx, scopeB, product.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("reading across tenants: got %v, want ErrNotFound", err)
	}
	if _, err := repo.FindByBarcode(ctx, scopeB, "6001234567890"); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("scanning across tenants: got %v, want ErrNotFound", err)
	}
	listed, err := repo.List(ctx, scopeB, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 0 {
		t.Errorf("another tenant listed %d products", len(listed))
	}
	if err := repo.Update(ctx, scopeB, product); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("updating across tenants: got %v, want ErrCrossTenant", err)
	}
	if err := repo.Create(ctx, scopeB, fullProduct(t, first.ID())); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("creating across tenants: got %v, want ErrCrossTenant", err)
	}
}

func TestEveryProductOperationRefusesAnUnsetScope(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, _ := newTenant(t, businesses, ctx)
	product := minimalProduct(t, tenant.ID(), "Riz")

	var unset business.Scope

	operations := map[string]func() error{
		"Create":        func() error { return repo.Create(ctx, unset, product) },
		"Get":           func() error { _, err := repo.Get(ctx, unset, product.ID()); return err },
		"FindByBarcode": func() error { _, err := repo.FindByBarcode(ctx, unset, "600"); return err },
		"List":          func() error { _, err := repo.List(ctx, unset, true); return err },
		"Update":        func() error { return repo.Update(ctx, unset, product) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestGetAndUpdateMissingProduct(t *testing.T) {
	repo, businesses, ctx := newProductRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	if _, err := repo.Get(ctx, scope, products.NewID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := repo.Get(ctx, scope, products.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero identifier: got %v, want ErrNotFound", err)
	}
	if err := repo.Update(ctx, scope, minimalProduct(t, tenant.ID(), "Never stored")); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

// TestAProductCannotBeFiledUnderAnotherTenantsCategory checks the composite key,
// which the scope guard cannot see.
func TestAProductCannotBeFiledUnderAnotherTenantsCategory(t *testing.T) {
	pool := pgtest.Pool(t)
	repo := postgres.NewProductRepository(pool)
	businesses := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	first, scopeA := newTenant(t, businesses, ctx)
	second, _ := newTenant(t, businesses, ctx)

	// A category belonging to the other business.
	categoryID := products.NewCategoryID()
	if _, err := pool.Exec(ctx, `
		INSERT INTO categories (id, business_id, name, created_at, updated_at)
		VALUES ($1, $2, 'Céréales', now(), now())`, categoryID.ID(), second.ID().ID()); err != nil {
		t.Fatalf("inserting the category: %v", err)
	}

	product := minimalProduct(t, first.ID(), "Riz")
	if err := product.SetCategory(categoryID, createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("SetCategory: %v", err)
	}

	if err := repo.Create(ctx, scopeA, product); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict from the composite foreign key", err)
	}
}

// TestReadingAProductWithAnUnknownCurrencyFails covers a row the schema permits
// but the domain does not.
func TestReadingAProductWithAnUnknownCurrencyFails(t *testing.T) {
	pool := pgtest.Pool(t)
	repo := postgres.NewProductRepository(pool)
	businesses := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	tenant, scope := newTenant(t, businesses, ctx)
	product := minimalProduct(t, tenant.ID(), "Riz")
	if err := repo.Create(ctx, scope, product); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := pool.Exec(ctx,
		`UPDATE products SET currency = 'ZZZ' WHERE id = $1`, product.ID().ID()); err != nil {
		t.Fatalf("planting the unknown currency: %v", err)
	}

	if _, err := repo.Get(ctx, scope, product.ID()); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
	if _, err := repo.List(ctx, scope, false); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("listing: got %v, want ErrQuery", err)
	}
}

func TestProductOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewProductRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	product := minimalProduct(t, tenant, "Riz")

	operations := map[string]func() error{
		"Create":        func() error { return repo.Create(ctx, scope, product) },
		"Get":           func() error { _, err := repo.Get(ctx, scope, product.ID()); return err },
		"FindByBarcode": func() error { _, err := repo.FindByBarcode(ctx, scope, "600"); return err },
		"List":          func() error { _, err := repo.List(ctx, scope, true); return err },
		"Update":        func() error { return repo.Update(ctx, scope, product) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}

	listed, err := repo.List(ctx, scope, true)
	if err == nil {
		t.Fatalf("List succeeded against a closed pool, returning %d products", len(listed))
	}
	if listed != nil {
		t.Errorf("returned %d products alongside an error", len(listed))
	}
}
