package products

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Errors reported when a product would be invalid.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("products: identifier is unset")
	// ErrInvalidPrice means a price is unusable.
	ErrInvalidPrice = errors.New("products: invalid price")
	// ErrCurrencyMismatch means the two prices are in different currencies.
	ErrCurrencyMismatch = errors.New("products: prices are in different currencies")
	// ErrInvalidCode means an SKU or barcode is not usable as a code.
	ErrInvalidCode = errors.New("products: invalid code")
	// ErrInvalidUnit means a unit of measure is unusable.
	ErrInvalidUnit = errors.New("products: invalid unit")
	// ErrInvalidTaxRate means a tax rate is outside the possible range.
	ErrInvalidTaxRate = errors.New("products: invalid tax rate")
	// ErrInvalidMinimumStock means a reorder point is unusable.
	ErrInvalidMinimumStock = errors.New("products: invalid minimum stock level")
	// ErrIndivisible means a fractional quantity was used for something sold whole.
	ErrIndivisible = errors.New("products: this product is sold whole")

	// ErrInvalidName means a name is empty, too long, or contains characters
	// that would not be visible to the person reading it.
	ErrInvalidName = validate.ErrInvalidName
	// ErrInvalidTime means a timestamp is unset or inconsistent.
	ErrInvalidTime = validate.ErrInvalidTime
)

// Limits on the free-text fields.
const (
	// MaxCodeLength bounds an SKU or barcode. Long enough for any real barcode
	// symbology, including GS1-128.
	MaxCodeLength = 48
	// MaxUnitLength bounds a unit of measure.
	MaxUnitLength = 24
	// MaxDescriptionLength bounds a description.
	MaxDescriptionLength = 2000
	// MaxTaxRateBasisPoints is a rate of 100%. Anything above it is a mistake,
	// most likely a percentage entered where basis points were meant.
	MaxTaxRateBasisPoints = 10_000
)

// Product is something a business sells, buys, or stores (SPECIFICATION.md §6).
//
// Its identifier is internal and immutable. The barcode is deliberately not the
// identifier: barcodes are reassigned by manufacturers, mistyped, and shared
// across a product range, so a record keyed by one would follow whatever the
// barcode came to mean.
//
// A product carries no stock level. Stock is the sum of the inventory ledger
// and is never a field here (§59, ADR-009).
type Product struct {
	id         ID
	businessID business.ID
	categoryID CategoryID

	name        string
	sku         string
	barcode     string
	description string
	brand       string

	// unit is what one of this product is measured in — "piece", "kg", "sac",
	// "carton". Free text rather than an enum: markets here use units no fixed
	// list would anticipate.
	unit string
	// divisible says whether a fraction of a unit is meaningful. Rice by the
	// kilo is; a bottle is not. It is what lets a sale of half a bottle be
	// refused at the point it is entered.
	divisible bool

	purchasePrice money.Money
	sellingPrice  money.Money
	// taxRateBasisPoints is hundredths of a percent, so 19.25% is 1925. An
	// integer because §44 forbids floating point for anything that ends up in a
	// money calculation, and a rate does.
	taxRateBasisPoints int

	minimumStock quantity.Quantity

	active    bool
	createdAt time.Time
	updatedAt time.Time
}

// Snapshot is the flat representation of a Product, used to persist it and to
// rebuild it from storage.
type Snapshot struct {
	ID                 ID
	BusinessID         business.ID
	CategoryID         CategoryID
	Name               string
	SKU                string
	Barcode            string
	Description        string
	Brand              string
	Unit               string
	Divisible          bool
	PurchasePrice      money.Money
	SellingPrice       money.Money
	TaxRateBasisPoints int
	MinimumStock       quantity.Quantity
	Active             bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// New creates a product, active from the given moment.
//
// Only what a product cannot exist without is required: an identifier, a
// business, a name, a unit, and a selling price. Everything else — SKU,
// barcode, category, brand, purchase price — is added as the business learns
// it. A shopkeeper entering stock at the till should not have to fill a form
// before they can sell something.
func New(snapshot Snapshot) (*Product, error) {
	cleaned, err := validateSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Moment(snapshot.CreatedAt, "creation time"); err != nil {
		return nil, err
	}

	moment := snapshot.CreatedAt.UTC()
	product := build(cleaned)
	product.active = true
	product.createdAt = moment
	product.updatedAt = moment
	return product, nil
}

// Restore rebuilds a product from storage, validating it on the way in.
func Restore(snapshot Snapshot) (*Product, error) {
	cleaned, err := validateSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if err := validate.Timestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	product := build(cleaned)
	product.active = snapshot.Active
	product.createdAt = snapshot.CreatedAt.UTC()
	product.updatedAt = snapshot.UpdatedAt.UTC()
	return product, nil
}

func build(snapshot Snapshot) *Product {
	return &Product{
		id:                 snapshot.ID,
		businessID:         snapshot.BusinessID,
		categoryID:         snapshot.CategoryID,
		name:               snapshot.Name,
		sku:                snapshot.SKU,
		barcode:            snapshot.Barcode,
		description:        snapshot.Description,
		brand:              snapshot.Brand,
		unit:               snapshot.Unit,
		divisible:          snapshot.Divisible,
		purchasePrice:      snapshot.PurchasePrice,
		sellingPrice:       snapshot.SellingPrice,
		taxRateBasisPoints: snapshot.TaxRateBasisPoints,
		minimumStock:       snapshot.MinimumStock,
	}
}

// validateSnapshot checks everything except the timestamps, which differ
// between a new product and a restored one, and returns the cleaned values.
func validateSnapshot(snapshot Snapshot) (Snapshot, error) {
	if snapshot.ID.IsZero() {
		return Snapshot{}, fmt.Errorf("%w: product", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return Snapshot{}, fmt.Errorf("%w: business", ErrInvalidID)
	}

	name, err := validate.Name(snapshot.Name)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot.Name = name

	if snapshot.SKU, err = validateCode(snapshot.SKU, "SKU"); err != nil {
		return Snapshot{}, err
	}
	if snapshot.Barcode, err = validateCode(snapshot.Barcode, "barcode"); err != nil {
		return Snapshot{}, err
	}
	if snapshot.Unit, err = validateUnit(snapshot.Unit); err != nil {
		return Snapshot{}, err
	}
	if snapshot.Brand, err = validateOptionalText(snapshot.Brand, validate.MaxNameLength, "brand"); err != nil {
		return Snapshot{}, err
	}
	if snapshot.Description, err = validateOptionalText(
		snapshot.Description, MaxDescriptionLength, "description",
	); err != nil {
		return Snapshot{}, err
	}

	if err := validatePrices(snapshot.PurchasePrice, snapshot.SellingPrice); err != nil {
		return Snapshot{}, err
	}
	if err := validateTaxRate(snapshot.TaxRateBasisPoints); err != nil {
		return Snapshot{}, err
	}
	if snapshot.MinimumStock.IsNegative() {
		return Snapshot{}, fmt.Errorf("%w: %s", ErrInvalidMinimumStock, snapshot.MinimumStock)
	}
	// A product sold whole cannot have a reorder point of half a unit.
	if !snapshot.Divisible && !snapshot.MinimumStock.IsWhole() {
		return Snapshot{}, fmt.Errorf("%w: a minimum of %s", ErrIndivisible, snapshot.MinimumStock)
	}

	return snapshot, nil
}

// validatePrices requires a selling price and allows the purchase price to be
// unknown.
//
// A business often knows what it sells something for before it has recorded
// what it paid — stock inherited from before the system, or a delivery whose
// invoice has not arrived. Requiring both would push people into entering a
// guess, which is worse than an honest gap (§8).
func validatePrices(purchase, selling money.Money) error {
	if !selling.Valid() {
		return fmt.Errorf("%w: a product needs a selling price", ErrInvalidPrice)
	}
	if selling.IsNegative() {
		return fmt.Errorf("%w: selling price %s", ErrInvalidPrice, selling)
	}

	if !purchase.Valid() {
		return nil
	}
	if purchase.IsNegative() {
		return fmt.Errorf("%w: purchase price %s", ErrInvalidPrice, purchase)
	}
	if purchase.Currency() != selling.Currency() {
		return fmt.Errorf("%w: bought in %s, sold in %s",
			ErrCurrencyMismatch, purchase.Currency(), selling.Currency())
	}
	return nil
}

func validateTaxRate(basisPoints int) error {
	if basisPoints < 0 || basisPoints > MaxTaxRateBasisPoints {
		return fmt.Errorf("%w: %d basis points, expected 0 to %d",
			ErrInvalidTaxRate, basisPoints, MaxTaxRateBasisPoints)
	}
	return nil
}

// validateCode checks an SKU or barcode.
//
// Both are optional, and both are trimmed rather than rejected for stray
// whitespace: a scanner sometimes appends one, and refusing the scan would be
// baffling at the till. Interior whitespace is refused, because a code with a
// space in it will not match when it is scanned again.
func validateCode(code, field string) (string, error) {
	cleaned := strings.TrimSpace(code)
	if cleaned == "" {
		return "", nil
	}
	if length := utf8.RuneCountInString(cleaned); length > MaxCodeLength {
		return "", fmt.Errorf("%w: %s is %d characters, the limit is %d",
			ErrInvalidCode, field, length, MaxCodeLength)
	}
	for _, character := range cleaned {
		if unicode.IsSpace(character) {
			return "", fmt.Errorf("%w: %s contains a space, so it would not match when scanned",
				ErrInvalidCode, field)
		}
		if unicode.In(character, unicode.C) {
			return "", fmt.Errorf("%w: %s contains the invisible character %U",
				ErrInvalidCode, field, character)
		}
	}
	return cleaned, nil
}

// validateUnit checks the unit of measure, which is required.
func validateUnit(unit string) (string, error) {
	cleaned := strings.TrimSpace(unit)
	if cleaned == "" {
		return "", fmt.Errorf("%w: a product needs a unit", ErrInvalidUnit)
	}
	if length := utf8.RuneCountInString(cleaned); length > MaxUnitLength {
		return "", fmt.Errorf("%w: %d characters, the limit is %d",
			ErrInvalidUnit, length, MaxUnitLength)
	}
	for _, character := range cleaned {
		if unicode.In(character, unicode.C) {
			return "", fmt.Errorf("%w: contains the invisible character %U", ErrInvalidUnit, character)
		}
	}
	return cleaned, nil
}

func validateOptionalText(value string, limit int, field string) (string, error) {
	cleaned := strings.TrimSpace(value)
	if cleaned == "" {
		return "", nil
	}
	if length := utf8.RuneCountInString(cleaned); length > limit {
		return "", fmt.Errorf("%w: %s is %d characters, the limit is %d",
			ErrInvalidName, field, length, limit)
	}
	for _, character := range cleaned {
		// Newlines are allowed in a description — it is prose someone may lay
		// out — but nothing else invisible is.
		if character == '\n' && limit == MaxDescriptionLength {
			continue
		}
		if unicode.In(character, unicode.C) {
			return "", fmt.Errorf("%w: %s contains the invisible character %U",
				ErrInvalidName, field, character)
		}
	}
	return cleaned, nil
}

// Snapshot returns the flat representation of the product.
func (p *Product) Snapshot() Snapshot {
	return Snapshot{
		ID:                 p.id,
		BusinessID:         p.businessID,
		CategoryID:         p.categoryID,
		Name:               p.name,
		SKU:                p.sku,
		Barcode:            p.barcode,
		Description:        p.description,
		Brand:              p.brand,
		Unit:               p.unit,
		Divisible:          p.divisible,
		PurchasePrice:      p.purchasePrice,
		SellingPrice:       p.sellingPrice,
		TaxRateBasisPoints: p.taxRateBasisPoints,
		MinimumStock:       p.minimumStock,
		Active:             p.active,
		CreatedAt:          p.createdAt,
		UpdatedAt:          p.updatedAt,
	}
}

// ID returns the immutable identifier.
func (p *Product) ID() ID { return p.id }

// BusinessID returns the business the product belongs to.
func (p *Product) BusinessID() business.ID { return p.businessID }

// CategoryID returns the category, and whether one was set.
func (p *Product) CategoryID() (CategoryID, bool) {
	return p.categoryID, !p.categoryID.IsZero()
}

// Name returns the product's name.
func (p *Product) Name() string { return p.name }

// SKU returns the business's own code for the product, if it has one.
func (p *Product) SKU() (string, bool) { return p.sku, p.sku != "" }

// Barcode returns the scannable code, if the product has one.
func (p *Product) Barcode() (string, bool) { return p.barcode, p.barcode != "" }

// Description returns the longer description, if there is one.
func (p *Product) Description() string { return p.description }

// Brand returns the brand, if there is one.
func (p *Product) Brand() string { return p.brand }

// Unit returns what one of this product is measured in.
func (p *Product) Unit() string { return p.unit }

// IsDivisible reports whether a fraction of a unit is meaningful.
func (p *Product) IsDivisible() bool { return p.divisible }

// PurchasePrice returns what the business pays, and whether that is known.
func (p *Product) PurchasePrice() (money.Money, bool) {
	return p.purchasePrice, p.purchasePrice.Valid()
}

// SellingPrice returns what the business charges.
func (p *Product) SellingPrice() money.Money { return p.sellingPrice }

// TaxRateBasisPoints returns the tax rate in hundredths of a percent.
func (p *Product) TaxRateBasisPoints() int { return p.taxRateBasisPoints }

// MinimumStock returns the reorder point. Zero means the product is not tracked
// for reordering.
func (p *Product) MinimumStock() quantity.Quantity { return p.minimumStock }

// IsActive reports whether the product is still sold.
func (p *Product) IsActive() bool { return p.active }

// CreatedAt returns when the product was created, in UTC.
func (p *Product) CreatedAt() time.Time { return p.createdAt }

// UpdatedAt returns when it last changed, in UTC.
func (p *Product) UpdatedAt() time.Time { return p.updatedAt }

// Scope returns the tenant scope the product belongs to.
func (p *Product) Scope() business.Scope {
	return business.ScopeOf(p.businessID, business.BranchID{})
}

// Margin returns what the business makes on one unit, and whether that can be
// worked out at all.
//
// It cannot when the purchase price is unknown, which is an honest answer: a
// margin computed against a guess would look like information.
func (p *Product) Margin() (money.Money, bool) {
	if !p.purchasePrice.Valid() {
		return money.Money{}, false
	}
	margin, err := p.sellingPrice.Sub(p.purchasePrice)
	if err != nil {
		return money.Money{}, false
	}
	return margin, true
}

// AllowsQuantity reports whether a quantity makes sense for this product.
//
// A bottle cannot be sold in halves. Checking here means the refusal happens
// where someone typed the quantity, rather than as a fractional bottle in a
// stock report.
func (p *Product) AllowsQuantity(q quantity.Quantity) error {
	if !p.divisible && !q.IsWhole() {
		return fmt.Errorf("%w: %s is sold in whole %s, got %s", ErrIndivisible, p.name, p.unit, q)
	}
	return nil
}

// Rename changes the product's name.
func (p *Product) Rename(name string, at time.Time) error {
	cleaned, err := validate.Name(name)
	if err != nil {
		return err
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	p.name = cleaned
	p.touch(at)
	return nil
}

// Reprice changes what the business charges and, if known, what it pays.
//
// This is a sensitive operation: §39 lists a product price change as something
// that writes an audit record, and the caller is expected to do so.
func (p *Product) Reprice(purchase, selling money.Money, at time.Time) error {
	if err := validatePrices(purchase, selling); err != nil {
		return err
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if p.purchasePrice == purchase && p.sellingPrice == selling {
		return nil
	}
	p.purchasePrice, p.sellingPrice = purchase, selling
	p.touch(at)
	return nil
}

// SetCodes changes the SKU and barcode. An empty value clears one.
func (p *Product) SetCodes(sku, barcode string, at time.Time) error {
	cleanedSKU, err := validateCode(sku, "SKU")
	if err != nil {
		return err
	}
	cleanedBarcode, err := validateCode(barcode, "barcode")
	if err != nil {
		return err
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if p.sku == cleanedSKU && p.barcode == cleanedBarcode {
		return nil
	}
	p.sku, p.barcode = cleanedSKU, cleanedBarcode
	p.touch(at)
	return nil
}

// SetCategory files the product under a category. A zero identifier clears it.
func (p *Product) SetCategory(categoryID CategoryID, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if p.categoryID == categoryID {
		return nil
	}
	p.categoryID = categoryID
	p.touch(at)
	return nil
}

// SetMinimumStock changes the reorder point. Zero stops tracking the product
// for reordering.
func (p *Product) SetMinimumStock(minimum quantity.Quantity, at time.Time) error {
	if minimum.IsNegative() {
		return fmt.Errorf("%w: %s", ErrInvalidMinimumStock, minimum)
	}
	if !p.divisible && !minimum.IsWhole() {
		return fmt.Errorf("%w: a minimum of %s", ErrIndivisible, minimum)
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if p.minimumStock.Equal(minimum) {
		return nil
	}
	p.minimumStock = minimum
	p.touch(at)
	return nil
}

// Deactivate stops the product being sold. It is idempotent.
//
// This is not deletion. The product still appears in every sale that ever
// included it, and removing it would tear a hole in the history those sales
// depend on (§40).
func (p *Product) Deactivate(at time.Time) error { return p.setActive(false, at) }

// Activate returns the product to sale. It is idempotent.
func (p *Product) Activate(at time.Time) error { return p.setActive(true, at) }

func (p *Product) setActive(active bool, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if p.active == active {
		return nil
	}
	p.active = active
	p.touch(at)
	return nil
}

func (p *Product) touch(at time.Time) { p.updatedAt = at.UTC() }
