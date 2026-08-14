package products_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

var (
	createdAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	tenant    = business.NewID()
)

// minimal is a product with only what one cannot exist without, which is the
// state a shopkeeper entering stock at the till actually creates.
func minimal() products.Snapshot {
	return products.Snapshot{
		ID:           products.NewID(),
		BusinessID:   tenant,
		Name:         "Riz parfumé 5kg",
		Unit:         "sac",
		SellingPrice: money.FromXAF(6_500),
		CreatedAt:    createdAt,
		UpdatedAt:    createdAt,
	}
}

func newProduct(t *testing.T, snapshot products.Snapshot) *products.Product {
	t.Helper()
	product, err := products.New(snapshot)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return product
}

// TestAProductNeedsOnlyWhatItCannotExistWithout is the important shape: a
// shopkeeper should not have to fill a form before they can sell something.
func TestAProductNeedsOnlyWhatItCannotExistWithout(t *testing.T) {
	product := newProduct(t, minimal())

	if got := product.Name(); got != "Riz parfumé 5kg" {
		t.Errorf("Name() = %q", got)
	}
	if got := product.Unit(); got != "sac" {
		t.Errorf("Unit() = %q", got)
	}
	if got := product.SellingPrice().Amount(); got != 6_500 {
		t.Errorf("SellingPrice() = %d", got)
	}
	if !product.IsActive() {
		t.Error("a new product is not active")
	}

	// Everything optional is genuinely absent rather than blank-but-present.
	if _, known := product.PurchasePrice(); known {
		t.Error("an unrecorded purchase price was reported as known")
	}
	if _, has := product.SKU(); has {
		t.Error("an unset SKU was reported as present")
	}
	if _, has := product.Barcode(); has {
		t.Error("an unset barcode was reported as present")
	}
	if _, filed := product.CategoryID(); filed {
		t.Error("an unset category was reported as present")
	}
	if !product.MinimumStock().IsZero() {
		t.Errorf("MinimumStock() = %s, want zero", product.MinimumStock())
	}
}

func TestNewRejectsInvalidProducts(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*products.Snapshot)
		want   error
	}{
		{"no product id", func(s *products.Snapshot) { s.ID = products.ID{} }, products.ErrInvalidID},
		{"no business", func(s *products.Snapshot) { s.BusinessID = business.ID{} }, products.ErrInvalidID},
		{"no name", func(s *products.Snapshot) { s.Name = "  " }, products.ErrInvalidName},
		{"invisible in name", func(s *products.Snapshot) { s.Name = "Riz​parfumé" }, products.ErrInvalidName},
		{"no unit", func(s *products.Snapshot) { s.Unit = "" }, products.ErrInvalidUnit},
		{"overlong unit", func(s *products.Snapshot) { s.Unit = strings.Repeat("u", 25) }, products.ErrInvalidUnit},
		{"invisible in unit", func(s *products.Snapshot) { s.Unit = "s​ac" }, products.ErrInvalidUnit},
		{"no selling price", func(s *products.Snapshot) { s.SellingPrice = money.Money{} }, products.ErrInvalidPrice},
		{"negative selling price", func(s *products.Snapshot) { s.SellingPrice = money.FromXAF(-1) }, products.ErrInvalidPrice},
		{"negative purchase price", func(s *products.Snapshot) { s.PurchasePrice = money.FromXAF(-1) }, products.ErrInvalidPrice},
		{
			"prices in different currencies",
			func(s *products.Snapshot) { s.PurchasePrice = money.MustNew(400, money.EUR) },
			products.ErrCurrencyMismatch,
		},
		{"negative tax rate", func(s *products.Snapshot) { s.TaxRateBasisPoints = -1 }, products.ErrInvalidTaxRate},
		{"tax rate above 100%", func(s *products.Snapshot) { s.TaxRateBasisPoints = 10_001 }, products.ErrInvalidTaxRate},
		{
			"negative minimum stock",
			func(s *products.Snapshot) { s.MinimumStock = quantity.MustParse("-1") },
			products.ErrInvalidMinimumStock,
		},
		{"overlong SKU", func(s *products.Snapshot) { s.SKU = strings.Repeat("a", 49) }, products.ErrInvalidCode},
		{"a space in the barcode", func(s *products.Snapshot) { s.Barcode = "123 456" }, products.ErrInvalidCode},
		{"invisible in the SKU", func(s *products.Snapshot) { s.SKU = "AB​C" }, products.ErrInvalidCode},
		{"no creation time", func(s *products.Snapshot) { s.CreatedAt = time.Time{} }, products.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := minimal()
			tc.mutate(&snapshot)

			product, err := products.New(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if product != nil {
				t.Error("returned a product alongside an error")
			}
		})
	}
}

// TestCodesAreTrimmedButNotSplit covers the till: a scanner sometimes appends
// whitespace, and refusing the scan would be baffling — but a code with a space
// inside it would not match when scanned again.
func TestCodesAreTrimmedButNotSplit(t *testing.T) {
	snapshot := minimal()
	snapshot.SKU = "  RIZ-5KG  "
	snapshot.Barcode = "\t6001234567890\n"

	product := newProduct(t, snapshot)

	if sku, _ := product.SKU(); sku != "RIZ-5KG" {
		t.Errorf("SKU() = %q, want it trimmed", sku)
	}
	if barcode, _ := product.Barcode(); barcode != "6001234567890" {
		t.Errorf("Barcode() = %q, want it trimmed", barcode)
	}
}

// TestAPurchasePriceMayBeUnknown covers stock inherited from before the system
// or a delivery whose invoice has not arrived. Requiring it would push people
// into entering a guess, which is worse than an honest gap.
func TestAPurchasePriceMayBeUnknown(t *testing.T) {
	product := newProduct(t, minimal())

	if _, known := product.PurchasePrice(); known {
		t.Error("an unset purchase price was reported as known")
	}
	if _, computable := product.Margin(); computable {
		t.Error("a margin was computed against an unknown purchase price")
	}

	// Once it is known, the margin follows.
	if err := product.Reprice(money.FromXAF(5_000), money.FromXAF(6_500), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Reprice: %v", err)
	}
	margin, computable := product.Margin()
	if !computable {
		t.Fatal("the margin is still not computable")
	}
	if margin.Amount() != 1_500 {
		t.Errorf("Margin() = %d, want 1500", margin.Amount())
	}
}

// TestAProductSoldWholeRefusesFractions is why divisibility is recorded: a
// bottle cannot be sold in halves, and the refusal should happen where someone
// typed the quantity rather than as a fractional bottle in a stock report.
func TestAProductSoldWholeRefusesFractions(t *testing.T) {
	whole := minimal()
	whole.Unit = "bouteille"
	whole.Divisible = false
	bottle := newProduct(t, whole)

	if err := bottle.AllowsQuantity(quantity.MustParse("0.5")); !errors.Is(err, products.ErrIndivisible) {
		t.Errorf("got %v, want ErrIndivisible", err)
	}
	if err := bottle.AllowsQuantity(quantity.MustParse("3")); err != nil {
		t.Errorf("a whole quantity was refused: %v", err)
	}

	divisible := minimal()
	divisible.Unit = "kg"
	divisible.Divisible = true
	rice := newProduct(t, divisible)

	if err := rice.AllowsQuantity(quantity.MustParse("0.5")); err != nil {
		t.Errorf("half a kilo was refused: %v", err)
	}
	if !rice.IsDivisible() {
		t.Error("IsDivisible() = false for a product sold by weight")
	}
}

func TestAProductSoldWholeRefusesAFractionalReorderPoint(t *testing.T) {
	snapshot := minimal()
	snapshot.Divisible = false
	snapshot.MinimumStock = quantity.MustParse("2.5")

	if _, err := products.New(snapshot); !errors.Is(err, products.ErrIndivisible) {
		t.Errorf("got %v, want ErrIndivisible", err)
	}

	product := newProduct(t, minimal())
	if err := product.SetMinimumStock(quantity.MustParse("2.5"), createdAt.Add(time.Hour)); !errors.Is(err, products.ErrIndivisible) {
		t.Errorf("SetMinimumStock: got %v, want ErrIndivisible", err)
	}
}

func TestRename(t *testing.T) {
	product := newProduct(t, minimal())
	at := createdAt.Add(time.Hour)

	if err := product.Rename("  Riz parfumé 10kg  ", at); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if got := product.Name(); got != "Riz parfumé 10kg" {
		t.Errorf("Name() = %q", got)
	}
	if !product.UpdatedAt().Equal(at) {
		t.Errorf("UpdatedAt() = %s, want %s", product.UpdatedAt(), at)
	}

	before := product.Name()
	if err := product.Rename("", at); !errors.Is(err, products.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
	if err := product.Rename("Valid", time.Time{}); !errors.Is(err, products.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if product.Name() != before {
		t.Errorf("a failed rename changed the name to %q", product.Name())
	}
}

func TestReprice(t *testing.T) {
	product := newProduct(t, minimal())
	at := createdAt.Add(time.Hour)

	if err := product.Reprice(money.FromXAF(5_000), money.FromXAF(7_000), at); err != nil {
		t.Fatalf("Reprice: %v", err)
	}
	if got := product.SellingPrice().Amount(); got != 7_000 {
		t.Errorf("SellingPrice() = %d", got)
	}
	if !product.UpdatedAt().Equal(at) {
		t.Errorf("UpdatedAt() = %s, want %s", product.UpdatedAt(), at)
	}

	// Setting the same prices is not a change.
	if err := product.Reprice(money.FromXAF(5_000), money.FromXAF(7_000), at.Add(time.Hour)); err != nil {
		t.Fatalf("Reprice: %v", err)
	}
	if !product.UpdatedAt().Equal(at) {
		t.Errorf("a redundant reprice moved UpdatedAt to %s", product.UpdatedAt())
	}

	if err := product.Reprice(money.Money{}, money.Money{}, at); !errors.Is(err, products.ErrInvalidPrice) {
		t.Errorf("got %v, want ErrInvalidPrice", err)
	}
	if err := product.Reprice(money.FromXAF(1), money.FromXAF(2), time.Time{}); !errors.Is(err, products.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestSetCodes(t *testing.T) {
	product := newProduct(t, minimal())
	at := createdAt.Add(time.Hour)

	if err := product.SetCodes("RIZ-5KG", "6001234567890", at); err != nil {
		t.Fatalf("SetCodes: %v", err)
	}
	sku, hasSKU := product.SKU()
	barcode, hasBarcode := product.Barcode()
	if !hasSKU || sku != "RIZ-5KG" || !hasBarcode || barcode != "6001234567890" {
		t.Errorf("codes = %q, %q", sku, barcode)
	}

	// Clearing them is how a mistyped barcode is removed.
	if err := product.SetCodes("", "", at.Add(time.Hour)); err != nil {
		t.Fatalf("SetCodes: %v", err)
	}
	if _, has := product.Barcode(); has {
		t.Error("the barcode was not cleared")
	}

	if err := product.SetCodes("with space", "", at); !errors.Is(err, products.ErrInvalidCode) {
		t.Errorf("got %v, want ErrInvalidCode", err)
	}
	if err := product.SetCodes("", "with space", at); !errors.Is(err, products.ErrInvalidCode) {
		t.Errorf("got %v, want ErrInvalidCode", err)
	}
	if err := product.SetCodes("A", "B", time.Time{}); !errors.Is(err, products.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestSetCategoryAndMinimumStock(t *testing.T) {
	product := newProduct(t, minimal())
	at := createdAt.Add(time.Hour)
	category := products.NewCategoryID()

	if err := product.SetCategory(category, at); err != nil {
		t.Fatalf("SetCategory: %v", err)
	}
	if got, filed := product.CategoryID(); !filed || got != category {
		t.Errorf("CategoryID() = %s, %v", got, filed)
	}
	// Setting the same category is not a change.
	if err := product.SetCategory(category, at.Add(time.Hour)); err != nil {
		t.Fatalf("SetCategory: %v", err)
	}
	if !product.UpdatedAt().Equal(at) {
		t.Errorf("a redundant SetCategory moved UpdatedAt to %s", product.UpdatedAt())
	}
	// A zero identifier clears it.
	if err := product.SetCategory(products.CategoryID{}, at.Add(2*time.Hour)); err != nil {
		t.Fatalf("SetCategory: %v", err)
	}
	if _, filed := product.CategoryID(); filed {
		t.Error("the category was not cleared")
	}

	if err := product.SetMinimumStock(quantity.MustParse("10"), at.Add(3*time.Hour)); err != nil {
		t.Fatalf("SetMinimumStock: %v", err)
	}
	if got := product.MinimumStock(); !got.Equal(quantity.MustParse("10")) {
		t.Errorf("MinimumStock() = %s", got)
	}
	if err := product.SetMinimumStock(quantity.MustParse("-1"), at); !errors.Is(err, products.ErrInvalidMinimumStock) {
		t.Errorf("got %v, want ErrInvalidMinimumStock", err)
	}
	if err := product.SetMinimumStock(quantity.MustParse("5"), time.Time{}); !errors.Is(err, products.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := product.SetCategory(category, time.Time{}); !errors.Is(err, products.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

// TestDeactivationIsNotDeletion: the product still appears in every sale that
// ever included it, and removing it would tear a hole in that history.
func TestDeactivationIsNotDeletion(t *testing.T) {
	product := newProduct(t, minimal())
	at := createdAt.Add(24 * time.Hour)

	if err := product.Deactivate(at); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if product.IsActive() {
		t.Error("still active after Deactivate")
	}
	// Everything about it is still there to be read by an old sale.
	if product.Name() == "" || product.SellingPrice().IsZero() {
		t.Error("deactivating erased the product's details")
	}

	if err := product.Deactivate(at.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if !product.UpdatedAt().Equal(at) {
		t.Errorf("a repeated Deactivate moved UpdatedAt to %s", product.UpdatedAt())
	}

	if err := product.Activate(at.Add(48 * time.Hour)); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if !product.IsActive() {
		t.Error("not active after Activate")
	}
	if err := product.Deactivate(time.Time{}); !errors.Is(err, products.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := product.Activate(time.Time{}); !errors.Is(err, products.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	snapshot := minimal()
	snapshot.CategoryID = products.NewCategoryID()
	snapshot.SKU = "RIZ-5KG"
	snapshot.Barcode = "6001234567890"
	snapshot.Description = "Riz parfumé importé, sac de 5 kilogrammes."
	snapshot.Brand = "Uncle Sam"
	snapshot.Divisible = false
	snapshot.PurchasePrice = money.FromXAF(5_000)
	snapshot.TaxRateBasisPoints = 1_925
	snapshot.MinimumStock = quantity.MustParse("10")

	product := newProduct(t, snapshot)
	restored, err := products.Restore(product.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Snapshot() != product.Snapshot() {
		t.Errorf("round trip gave %+v, want %+v", restored.Snapshot(), product.Snapshot())
	}
	if got := restored.TaxRateBasisPoints(); got != 1_925 {
		t.Errorf("TaxRateBasisPoints() = %d, want 1925", got)
	}
	if got := restored.Brand(); got != "Uncle Sam" {
		t.Errorf("Brand() = %q", got)
	}
	if got := restored.Description(); got == "" {
		t.Error("the description was lost")
	}
}

func TestRestoreValidatesStoredData(t *testing.T) {
	valid := newProduct(t, minimal()).Snapshot()

	if _, err := products.Restore(valid); err != nil {
		t.Fatalf("Restore rejected a valid snapshot: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*products.Snapshot)
		want   error
	}{
		{"no name", func(s *products.Snapshot) { s.Name = "" }, products.ErrInvalidName},
		{"no unit", func(s *products.Snapshot) { s.Unit = "" }, products.ErrInvalidUnit},
		{"no selling price", func(s *products.Snapshot) { s.SellingPrice = money.Money{} }, products.ErrInvalidPrice},
		{"no creation time", func(s *products.Snapshot) { s.CreatedAt = time.Time{} }, products.ErrInvalidTime},
		{
			"updated before created",
			func(s *products.Snapshot) { s.UpdatedAt = s.CreatedAt.Add(-time.Hour) },
			products.ErrInvalidTime,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := valid
			tc.mutate(&snapshot)

			restored, err := products.Restore(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if restored != nil {
				t.Error("returned a product alongside an error")
			}
		})
	}
}

func TestADescriptionMayContainLineBreaks(t *testing.T) {
	// A description is prose someone may lay out; other invisible characters
	// are still refused.
	snapshot := minimal()
	snapshot.Description = "Riz parfumé.\n\nSac de 5 kg."
	if _, err := products.New(snapshot); err != nil {
		t.Errorf("a description with line breaks was refused: %v", err)
	}

	snapshot.Description = "Riz​parfumé"
	if _, err := products.New(snapshot); !errors.Is(err, products.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}

	snapshot.Description = strings.Repeat("a", 2_001)
	if _, err := products.New(snapshot); !errors.Is(err, products.ErrInvalidName) {
		t.Errorf("an overlong description: got %v, want ErrInvalidName", err)
	}

	overlongBrand := minimal()
	overlongBrand.Brand = strings.Repeat("a", 121)
	if _, err := products.New(overlongBrand); !errors.Is(err, products.ErrInvalidName) {
		t.Errorf("an overlong brand: got %v, want ErrInvalidName", err)
	}
	invisibleBrand := minimal()
	invisibleBrand.Brand = "Uncle​Sam"
	if _, err := products.New(invisibleBrand); !errors.Is(err, products.ErrInvalidName) {
		t.Errorf("an invisible character in the brand: got %v, want ErrInvalidName", err)
	}
}

func TestNewNormalisesTheTimestampToUTC(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	snapshot := minimal()
	snapshot.CreatedAt = createdAt.In(wat)
	snapshot.UpdatedAt = createdAt.In(wat)

	product := newProduct(t, snapshot)
	if got := product.CreatedAt().Location(); got != time.UTC {
		t.Errorf("CreatedAt() location = %s, want UTC", got)
	}
	if !product.CreatedAt().Equal(createdAt) {
		t.Errorf("CreatedAt() = %s, want the same instant", product.CreatedAt())
	}
}

func TestProductScopeIsItsBusiness(t *testing.T) {
	product := newProduct(t, minimal())

	scope := product.Scope()
	if got := scope.Business(); got != tenant {
		t.Errorf("Business() = %s, want %s", got, tenant)
	}
	if scope.IsBranchScoped() {
		t.Error("a product produced a branch-scoped scope")
	}
	if scope.Permits(business.NewID(), business.BranchID{}) {
		t.Error("the scope permitted another tenant")
	}
}

func TestMarginCannotBeComputedFromMismatchedCurrencies(t *testing.T) {
	// Restore is the only way in: New refuses mismatched currencies, so this is
	// the shape a corrupt row would take.
	snapshot := minimal()
	product := newProduct(t, snapshot)

	// Reprice refuses it too, which is the point.
	err := product.Reprice(money.MustNew(400, money.EUR), money.FromXAF(6_500), createdAt.Add(time.Hour))
	if !errors.Is(err, products.ErrCurrencyMismatch) {
		t.Errorf("got %v, want ErrCurrencyMismatch", err)
	}
}

func TestIDHelpers(t *testing.T) {
	productID, categoryID := products.NewID(), products.NewCategoryID()
	if productID.IsZero() || categoryID.IsZero() {
		t.Fatal("a generated identifier is zero")
	}

	parsedProduct, err := products.ParseID(productID.String())
	if err != nil || parsedProduct != productID {
		t.Errorf("ParseID round trip gave %s, %v", parsedProduct, err)
	}
	parsedCategory, err := products.ParseCategoryID(categoryID.String())
	if err != nil || parsedCategory != categoryID {
		t.Errorf("ParseCategoryID round trip gave %s, %v", parsedCategory, err)
	}

	for _, input := range []string{"", "nonsense", "0198c2d4"} {
		if _, err := products.ParseID(input); err == nil {
			t.Errorf("ParseID(%q) succeeded", input)
		}
		if _, err := products.ParseCategoryID(input); err == nil {
			t.Errorf("ParseCategoryID(%q) succeeded", input)
		}
	}

	// A product identifier must not interchange with a category one.
	underlying := productID.ID()
	if any(products.IDFrom(underlying)) == any(products.CategoryIDFrom(underlying)) {
		t.Error("product and category identifiers are the same type")
	}
}

// TestIdentityAccessors covers the plain readers, which say little apart but
// are what every caller reaches for first.
func TestIdentityAccessors(t *testing.T) {
	snapshot := minimal()
	product := newProduct(t, snapshot)

	if got := product.ID(); got != snapshot.ID {
		t.Errorf("ID() = %s, want %s", got, snapshot.ID)
	}
	if got := product.BusinessID(); got != tenant {
		t.Errorf("BusinessID() = %s, want %s", got, tenant)
	}
}

// TestRedundantUpdatesDoNotTouchTheRecord keeps a replayed sync event from
// looking like a change.
func TestRedundantUpdatesDoNotTouchTheRecord(t *testing.T) {
	snapshot := minimal()
	snapshot.SKU = "RIZ-5KG"
	snapshot.MinimumStock = quantity.MustParse("10")
	product := newProduct(t, snapshot)

	later := createdAt.Add(time.Hour)

	if err := product.SetCodes("RIZ-5KG", "", later); err != nil {
		t.Fatalf("SetCodes: %v", err)
	}
	if err := product.SetMinimumStock(quantity.MustParse("10"), later); err != nil {
		t.Fatalf("SetMinimumStock: %v", err)
	}

	if !product.UpdatedAt().Equal(createdAt) {
		t.Errorf("a redundant update moved UpdatedAt to %s, want it left at %s",
			product.UpdatedAt(), createdAt)
	}
}

// TestMarginIsNotReportedWhenItCannotBeComputed covers a stored product whose
// prices ended up in different currencies — a shape New refuses, so it could
// only arrive from a bad migration or a hand-edited row.
func TestMarginIsNotReportedWhenItCannotBeComputed(t *testing.T) {
	product := newProduct(t, minimal())

	// Prices are consistent, so the margin is unavailable only because the
	// purchase price is unknown.
	if _, computable := product.Margin(); computable {
		t.Error("a margin was reported without a purchase price")
	}

	// With both known and consistent, it is available.
	if err := product.Reprice(money.FromXAF(5_000), money.FromXAF(6_500), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Reprice: %v", err)
	}
	if _, computable := product.Margin(); !computable {
		t.Error("a margin was not reported although both prices are known")
	}
}
