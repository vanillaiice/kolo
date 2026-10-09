// Package products identifies the things a business sells, buys, and stores.
//
// Only the identifiers live here for now. The Product entity — its name, SKU,
// barcode, prices, and tax configuration (SPECIFICATION.md §6) — follows; the
// inventory ledger needs something to point at first, and a product identifier
// needs one home rather than a copy in each domain that refers to one.
//
// A product's identifier is internal and immutable. The barcode is not the
// identifier: barcodes are reassigned by manufacturers, mistyped, and shared
// between products in the same range, so a record keyed by one would follow
// whatever the barcode came to mean (§6).
package products

import "github.com/vanillaiice/kolo/backend/internal/kernel/id"

type (
	productTag  struct{}
	categoryTag struct{}
)

// ID identifies a product. It is immutable once assigned.
type ID = id.Typed[productTag]

// CategoryID identifies a product category. It is immutable once assigned.
type CategoryID = id.Typed[categoryTag]

// NewID returns a new product identifier.
func NewID() ID { return id.NewTyped[productTag]() }

// NewCategoryID returns a new category identifier.
func NewCategoryID() CategoryID { return id.NewTyped[categoryTag]() }

// IDFrom tags an identifier drawn from a generator as a product identifier.
func IDFrom(value id.ID) ID { return id.TypedFrom[productTag](value) }

// CategoryIDFrom tags an identifier drawn from a generator as a category
// identifier.
func CategoryIDFrom(value id.ID) CategoryID { return id.TypedFrom[categoryTag](value) }

// ParseID reads a product identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[productTag](text) }

// ParseCategoryID reads a category identifier from its text form.
func ParseCategoryID(text string) (CategoryID, error) { return id.ParseTyped[categoryTag](text) }
