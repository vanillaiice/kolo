package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
)

// ProductSavedPayload is the body of a PRODUCT_SAVED event (ADR-006).
//
// One event carries one product. A product is edited as a whole, and a device
// that changed a price and a name recorded one edit, not two.
type ProductSavedPayload struct {
	Product ProductPayload `json:"product"`
}

// ProductPayload is a product as a device describes it.
//
// As with a movement, it carries no business: the tenant comes from the
// authenticated envelope (ADR-008). Unlike a movement, it carries timestamps
// that decide a conflict, so they are required rather than inferred.
type ProductPayload struct {
	ID                 string `json:"id"`
	CategoryID         string `json:"category_id,omitempty"`
	Name               string `json:"name"`
	SKU                string `json:"sku,omitempty"`
	Barcode            string `json:"barcode,omitempty"`
	Description        string `json:"description,omitempty"`
	Brand              string `json:"brand,omitempty"`
	Unit               string `json:"unit"`
	Divisible          bool   `json:"divisible,omitempty"`
	PurchasePriceMinor *int64 `json:"purchase_price_minor,omitempty"`
	SellingPriceMinor  int64  `json:"selling_price_minor"`
	TaxRateBasisPoints int    `json:"tax_rate_basis_points,omitempty"`
	MinimumStock       int64  `json:"minimum_stock,omitempty"`
	Active             *bool  `json:"active,omitempty"`
	CreatedAt          string `json:"created_at"`
	// UpdatedAt is when the shopkeeper made this edit, on their own clock. It
	// decides which of two conflicting edits wins, so it is the device's time
	// and deliberately not the server's: an edit made on Monday and synced on
	// Friday must not beat one made on Wednesday (ADR-015).
	UpdatedAt string `json:"updated_at"`
}

// savedProduct reads a PRODUCT_SAVED payload into a domain product.
//
// The device that made the edit comes from the envelope and becomes the
// product's UpdatedByDevice, which is what breaks a tie between two edits
// stamped the same instant. Taking it from the envelope rather than the payload
// means a device cannot nominate itself the winner by claiming to be another.
func savedProduct(
	scope business.Scope, envelope sync.Envelope,
) (*products.Product, error) {
	var payload ProductSavedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	line := payload.Product
	productID, err := products.ParseID(line.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	categoryID := products.CategoryID{}
	if line.CategoryID != "" {
		categoryID, err = products.ParseCategoryID(line.CategoryID)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
		}
	}

	createdAt, err := moment(line.CreatedAt, "product", "created_at")
	if err != nil {
		return nil, err
	}
	updatedAt, err := moment(line.UpdatedAt, "product", "updated_at")
	if err != nil {
		return nil, err
	}

	sellingPrice, err := money.New(line.SellingPriceMinor, money.XAF)
	if err != nil {
		return nil, fmt.Errorf("%w: selling price: %w", sync.ErrInvalidPayload, err)
	}
	purchasePrice := money.Money{}
	if line.PurchasePriceMinor != nil {
		purchasePrice, err = money.New(*line.PurchasePriceMinor, money.XAF)
		if err != nil {
			return nil, fmt.Errorf("%w: purchase price: %w", sync.ErrInvalidPayload, err)
		}
	}

	// Absent means active. A device that has never sent the field is not saying
	// the product is archived.
	active := true
	if line.Active != nil {
		active = *line.Active
	}

	// Restore rather than New: this is a product that already exists on another
	// device, with its own timestamps, not one being created here. New would
	// stamp it with this moment and lose the ordering a conflict depends on.
	product, err := products.Restore(products.Snapshot{
		ID:                 productID,
		BusinessID:         scope.Business(),
		CategoryID:         categoryID,
		Name:               line.Name,
		SKU:                line.SKU,
		Barcode:            line.Barcode,
		Description:        line.Description,
		Brand:              line.Brand,
		Unit:               line.Unit,
		Divisible:          line.Divisible,
		PurchasePrice:      purchasePrice,
		SellingPrice:       sellingPrice,
		TaxRateBasisPoints: line.TaxRateBasisPoints,
		MinimumStock:       quantity.FromThousandths(line.MinimumStock),
		Active:             active,
		UpdatedByDevice:    envelope.DeviceID,
		CreatedAt:          createdAt,
		UpdatedAt:          updatedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return product, nil
}

// moment reads a timestamp a conflict is decided by, which is why it is
// required rather than inferred: a record with no updated_at could not be
// compared with the one already stored.
func moment(text, what, field string) (time.Time, error) {
	if text == "" {
		return time.Time{}, fmt.Errorf("%w: a %s needs a %s", sync.ErrInvalidPayload, what, field)
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: %s: %w", sync.ErrInvalidPayload, field, err)
	}
	return parsed.UTC(), nil
}
