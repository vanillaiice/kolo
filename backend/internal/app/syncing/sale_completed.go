package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// SaleCompletedPayload is the body of a SALE_COMPLETED event (ADR-006).
//
// One event carries the whole fan-out: the sale, its lines, its payments, and
// the stock it released. They travel together because they happened together,
// and a device that sent them separately could have half of them accepted (§9).
type SaleCompletedPayload struct {
	Sale      SalePayload          `json:"sale"`
	Payments  []SalePaymentPayload `json:"payments,omitempty"`
	Movements []MovementPayload    `json:"movements,omitempty"`
}

// SalePayload is a sale as a device describes it.
type SalePayload struct {
	ID         string            `json:"id"`
	CustomerID string            `json:"customer_id,omitempty"`
	Number     string            `json:"number"`
	Items      []SaleItemPayload `json:"items"`
	// CreditTransactionID names the customer's ledger entry for what this sale
	// left owing, and is absent from a sale paid in full.
	//
	// The device draws it, as it draws every other identifier here, because
	// that identifier is what makes a replay a duplicate (§27). A server that
	// invented one would write a second debt every time a till resent its
	// backlog, and the customer would owe twice for one purchase.
	CreditTransactionID string `json:"credit_transaction_id,omitempty"`
	// DiscountMinor is taken off the whole sale, after the lines.
	DiscountMinor int64  `json:"discount_minor,omitempty"`
	Note          string `json:"note,omitempty"`
	OccurredAt    string `json:"occurred_at"`
}

// SaleItemPayload is one line of a sale.
//
// The name and the prices travel rather than being looked up from the product,
// because a receipt reprinted next year must show what was charged, and the
// product will have been repriced by then (§41).
type SaleItemPayload struct {
	ID                 string `json:"id"`
	ProductID          string `json:"product_id"`
	Name               string `json:"name"`
	UnitPriceMinor     int64  `json:"unit_price_minor"`
	Quantity           int64  `json:"quantity"`
	DiscountMinor      int64  `json:"discount_minor,omitempty"`
	TaxRateBasisPoints int    `json:"tax_rate_basis_points,omitempty"`
	UnitCostMinor      *int64 `json:"unit_cost_minor,omitempty"`
}

// SalePaymentPayload is one payment against a sale.
//
// It names an account, never a method, which is what keeps Mobile Money
// providers configurable (§10).
type SalePaymentPayload struct {
	ID          string `json:"id"`
	AccountID   string `json:"account_id"`
	AmountMinor int64  `json:"amount_minor"`
	Reference   string `json:"reference,omitempty"`
	Note        string `json:"note,omitempty"`
	OccurredAt  string `json:"occurred_at,omitempty"`
}

// completedSale reads a SALE_COMPLETED payload into the domain objects it
// describes.
//
// The whole fan-out is built before any of it is written, so a payload that is
// wrong anywhere is rejected as one event rather than half-applied. Tenant,
// device, and user come from the envelope, as everywhere (ADR-008).
func completedSale(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (postgres.Effects, error) {
	var payload SaleCompletedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return postgres.Effects{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	sale, err := payload.Sale.toSale(scope, envelope, recordedAt)
	if err != nil {
		return postgres.Effects{}, err
	}

	payments := make([]*sales.Payment, 0, len(payload.Payments))
	for i, line := range payload.Payments {
		payment, err := line.toPayment(scope, envelope, sale, recordedAt)
		if err != nil {
			return postgres.Effects{}, fmt.Errorf("payment %d: %w", i, err)
		}
		payments = append(payments, payment)
	}

	movements := make([]*inventory.Movement, 0, len(payload.Movements))
	for i, line := range payload.Movements {
		movement, err := line.toMovement(scope, envelope, recordedAt)
		if err != nil {
			return postgres.Effects{}, fmt.Errorf("movement %d: %w", i, err)
		}
		movements = append(movements, movement)
	}

	// The arithmetic is checked here rather than left to the database. A sale
	// paid more than its total, or owed with nobody to owe it, is a payload the
	// server can read but must not store — and the device needs to be told,
	// because it has the same numbers on its own screen.
	settlement, err := sales.Settle(sale, payments)
	if err != nil {
		return postgres.Effects{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	credit, err := payload.Sale.toCredit(scope, envelope, sale, settlement, recordedAt)
	if err != nil {
		return postgres.Effects{}, err
	}

	effects := postgres.Effects{Sale: sale, Payments: payments, Movements: movements}
	if credit != nil {
		effects.Credit = []*customers.Transaction{credit}
	}
	return effects, nil
}

// toCredit builds the ledger entry a sale left unpaid produces, and nil for one
// paid in full.
//
// This is §9's fan-out reaching §13: goods left the shop and someone owes for
// them, so the customer's ledger gains an entry in the same transaction as the
// sale. Deriving it here rather than trusting an amount from the payload means
// the debt is the sale's own arithmetic — a device that sent a different figure
// could otherwise record a purchase of 25,000 as a debt of 2,500.
//
// Whether the sale is on credit is decided by the settlement, not by the
// presence of an identifier. A device that disagrees with the server about
// which of those is true is told, rather than having one of the two silently
// preferred.
func (s SalePayload) toCredit(
	scope business.Scope,
	envelope sync.Envelope,
	sale *sales.Sale,
	settlement sales.Settlement,
	recordedAt time.Time,
) (*customers.Transaction, error) {
	if !settlement.OnCredit() {
		if s.CreditTransactionID != "" {
			return nil, fmt.Errorf(
				"%w: the sale carries a credit entry but leaves nothing owing",
				sync.ErrInvalidPayload)
		}
		return nil, nil
	}
	if s.CreditTransactionID == "" {
		return nil, fmt.Errorf("%w: %s is left owing with no credit entry to carry it",
			sync.ErrInvalidPayload, settlement.Outstanding)
	}

	transactionID, err := customers.ParseTransactionID(s.CreditTransactionID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	// Settle has already refused an outstanding balance with nobody to owe it,
	// so the sale names a customer by the time this runs.
	customerID, _ := sale.Customer()

	branchID, _ := scope.Branch()
	credit, err := customers.RecordTransaction(customers.TransactionSnapshot{
		ID:         transactionID,
		CustomerID: customerID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		Type:       customers.CreditSale,
		Amount:     settlement.Outstanding,
		// What caused the debt, which is how a statement line is traced back to
		// what the customer actually took (§13, §40).
		Reference:  customers.Reference{Kind: "SALE", ID: sale.ID().String()},
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: sale.OccurredAt(),
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return credit, nil
}

func (s SalePayload) toSale(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (*sales.Sale, error) {
	saleID, err := sales.ParseID(s.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	customerID := customers.ID{}
	if s.CustomerID != "" {
		customerID, err = customers.ParseID(s.CustomerID)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
		}
	}

	occurredAt, err := saleMoment(s.OccurredAt, envelope.OccurredAt)
	if err != nil {
		return nil, err
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: the sale claims to have happened in the future", sync.ErrInvalidPayload)
	}

	discount, err := money.New(s.DiscountMinor, money.XAF)
	if err != nil {
		return nil, fmt.Errorf("%w: discount: %w", sync.ErrInvalidPayload, err)
	}

	items := make([]sales.ItemSnapshot, 0, len(s.Items))
	for i, line := range s.Items {
		item, err := line.toItem()
		if err != nil {
			return nil, fmt.Errorf("item %d: %w", i, err)
		}
		items = append(items, item)
	}

	branchID, _ := scope.Branch()
	sale, err := sales.Record(sales.Snapshot{
		ID:         saleID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		CustomerID: customerID,
		Number:     s.Number,
		Items:      items,
		Discount:   discount,
		Note:       s.Note,
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: occurredAt,
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return sale, nil
}

func (i SaleItemPayload) toItem() (sales.ItemSnapshot, error) {
	itemID, err := sales.ParseItemID(i.ID)
	if err != nil {
		return sales.ItemSnapshot{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	productID, err := products.ParseID(i.ProductID)
	if err != nil {
		return sales.ItemSnapshot{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	unitPrice, err := money.New(i.UnitPriceMinor, money.XAF)
	if err != nil {
		return sales.ItemSnapshot{}, fmt.Errorf("%w: unit price: %w", sync.ErrInvalidPayload, err)
	}
	discount, err := money.New(i.DiscountMinor, money.XAF)
	if err != nil {
		return sales.ItemSnapshot{}, fmt.Errorf("%w: discount: %w", sync.ErrInvalidPayload, err)
	}

	unitCost := money.Money{}
	if i.UnitCostMinor != nil {
		unitCost, err = money.New(*i.UnitCostMinor, money.XAF)
		if err != nil {
			return sales.ItemSnapshot{}, fmt.Errorf("%w: unit cost: %w", sync.ErrInvalidPayload, err)
		}
	}

	return sales.ItemSnapshot{
		ID:                 itemID,
		ProductID:          productID,
		Name:               i.Name,
		UnitPrice:          unitPrice,
		Quantity:           quantity.FromThousandths(i.Quantity),
		Discount:           discount,
		TaxRateBasisPoints: i.TaxRateBasisPoints,
		UnitCost:           unitCost,
	}, nil
}

func (p SalePaymentPayload) toPayment(
	scope business.Scope, envelope sync.Envelope, sale *sales.Sale, recordedAt time.Time,
) (*sales.Payment, error) {
	paymentID, err := sales.ParsePaymentID(p.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	accountID, err := finance.ParseAccountID(p.AccountID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	amount, err := money.New(p.AmountMinor, money.XAF)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	occurredAt, err := saleMoment(p.OccurredAt, sale.OccurredAt())
	if err != nil {
		return nil, err
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: the payment claims to have happened in the future",
			sync.ErrInvalidPayload)
	}

	branchID, _ := scope.Branch()
	payment, err := sales.RecordPayment(sales.PaymentSnapshot{
		ID:         paymentID,
		SaleID:     sale.ID(),
		BusinessID: scope.Business(),
		BranchID:   branchID,
		AccountID:  accountID,
		Amount:     amount,
		Reference:  p.Reference,
		Note:       p.Note,
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: occurredAt,
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return payment, nil
}

// saleMoment reads a timestamp, falling back to the envelope's when the payload
// leaves it out.
func saleMoment(text string, fallback time.Time) (time.Time, error) {
	if text == "" {
		return fallback, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return parsed.UTC(), nil
}
