package syncing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/quantity"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// PurchaseRecordedPayload is the body of a PURCHASE_RECORDED event (ADR-006).
//
// One event carries the whole fan-out: the delivery and its lines, the stock
// that arrived, and what was handed over at the door. They travel together
// because they happened together — §15 is explicit that a purchase is not an
// inventory operation, and a device that sent the parts separately could have
// some of them accepted and the rest refused.
//
// What the supplier is still owed is deliberately *not* on the wire. It is
// derived here from the delivery's own arithmetic, for the reason a sale's debt
// is: a device that sent a figure could send a wrong one, and a wholesaler owed
// 60,000 recorded as owed 6,000 is a disagreement nothing later could settle.
type PurchaseRecordedPayload struct {
	Purchase  PurchasePayload          `json:"purchase"`
	Payments  []PurchasePaymentPayload `json:"payments,omitempty"`
	Movements []MovementPayload        `json:"movements,omitempty"`
}

// PurchasePayload is a delivery as a device describes it.
type PurchasePayload struct {
	ID string `json:"id"`
	// SupplierID may be absent: a shopkeeper buying a crate at the market has
	// no wholesaler to name, and requiring one would stop them recording the
	// stock at all (§15).
	SupplierID string `json:"supplier_id,omitempty"`
	// Reference is the supplier's invoice or delivery-note number, when there
	// is one.
	Reference string                `json:"reference,omitempty"`
	Items     []PurchaseItemPayload `json:"items"`
	Note      string                `json:"note,omitempty"`
	// SupplierTransactionID names the ledger entry for what this delivery left
	// owing, and is absent from one paid at the door.
	//
	// The device draws it, as it draws every other identifier here, because
	// that identifier is what makes a replay a duplicate (§27). A server that
	// invented one would write a second debt every time a till resent its
	// backlog, and the shop would owe twice for one delivery.
	SupplierTransactionID string `json:"supplier_transaction_id,omitempty"`
	OccurredAt            string `json:"occurred_at"`
}

// PurchaseItemPayload is one line of a delivery.
//
// The cost is required, unlike a sale line's price being optional to look up:
// this is where a cost is *learned*, and a delivery with no cost tells the shop
// nothing about what its stock is worth (§8).
type PurchaseItemPayload struct {
	ID            string `json:"id"`
	ProductID     string `json:"product_id"`
	UnitCostMinor int64  `json:"unit_cost_minor"`
	Quantity      int64  `json:"quantity"`
}

// PurchasePaymentPayload is money handed over at the door.
//
// It names an account, never a method, which is what keeps Mobile Money
// providers configurable (§10). It becomes a movement against that account
// rather than an entry in the supplier's ledger, because a delivery bought at
// the market has no supplier to have a ledger — and money that left the till
// has to be recorded whether anyone was named or not.
type PurchasePaymentPayload struct {
	// ID is the movement's own identifier, drawn by the device. It is what
	// makes a resent payment a duplicate rather than a second one (§27).
	ID        string `json:"id"`
	AccountID string `json:"account_id"`
	// AmountMinor is signed as it will be stored: negative, because this is
	// money leaving. The sign is checked against the type rather than
	// corrected, since a payment that read as a deposit would make a drawer
	// look full that is empty.
	AmountMinor int64 `json:"amount_minor"`
	// Reason is why cash left the drawer, and is required: §41 makes taking
	// money out a sensitive operation, and "it was a purchase" is not an answer
	// an owner reading the day's cash can do anything with.
	Reason     string `json:"reason"`
	OccurredAt string `json:"occurred_at,omitempty"`
}

// recordedPurchase reads a PURCHASE_RECORDED payload into the domain objects it
// describes.
//
// The whole fan-out is built before any of it is written, so a payload that is
// wrong anywhere is rejected as one event rather than half-applied. Tenant,
// branch, device, and user come from the envelope, as everywhere (ADR-008).
func recordedPurchase(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (postgres.Effects, error) {
	var payload PurchaseRecordedPayload
	decoder := json.NewDecoder(bytes.NewReader(envelope.Payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return postgres.Effects{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	purchase, err := payload.Purchase.toPurchase(scope, envelope, recordedAt)
	if err != nil {
		return postgres.Effects{}, err
	}

	paid := make([]*finance.Movement, 0, len(payload.Payments))
	for i, line := range payload.Payments {
		movement, err := line.toMovement(scope, envelope, purchase, recordedAt)
		if err != nil {
			return postgres.Effects{}, fmt.Errorf("payment %d: %w", i, err)
		}
		paid = append(paid, movement)
	}

	movements := make([]*inventory.Movement, 0, len(payload.Movements))
	for i, line := range payload.Movements {
		movement, err := line.toMovement(scope, envelope, recordedAt)
		if err != nil {
			return postgres.Effects{}, fmt.Errorf("movement %d: %w", i, err)
		}
		movements = append(movements, movement)
	}

	// The arithmetic is checked here rather than left to the database. A
	// delivery paid more than it came to, or left owing with no wholesaler to
	// owe it, is a payload the server can read but must not store — and the
	// device needs to be told, because it has the same numbers on its screen.
	handedOver, err := totalPaid(paid)
	if err != nil {
		return postgres.Effects{}, err
	}
	settlement, err := purchases.Settle(purchase, handedOver)
	if err != nil {
		return postgres.Effects{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	owed, err := payload.Purchase.toOwed(scope, envelope, purchase, settlement, recordedAt)
	if err != nil {
		return postgres.Effects{}, err
	}

	effects := postgres.Effects{
		Purchase:  purchase,
		Movements: movements,
		Cash:      paid,
	}
	if owed != nil {
		effects.Owed = []*suppliers.Transaction{owed}
	}
	return effects, nil
}

// totalPaid sums what was handed over, as a positive amount.
//
// The movements are negative — money left the account — while a settlement asks
// what was paid, which is the size of that and not its direction. Summing the
// magnitudes here rather than negating the settlement keeps the sign convention
// where it belongs: negative in the account's ledger, positive in the answer to
// "how much of this delivery has been paid for".
func totalPaid(movements []*finance.Movement) (money.Money, error) {
	total := money.Money{}
	for i, movement := range movements {
		amount, err := movement.Amount().Abs()
		if err != nil {
			return money.Money{}, fmt.Errorf("%w: payment %d: %w", sync.ErrInvalidPayload, i, err)
		}
		if i == 0 {
			total = amount
			continue
		}
		// Both amounts are XAF, fixed by the payload reader, so the only way
		// this fails is an overflow — which is refused rather than wrapped
		// round into a delivery that looks paid for.
		total, err = total.Add(amount)
		if err != nil {
			return money.Money{}, fmt.Errorf("%w: totalling what was paid: %w",
				sync.ErrInvalidPayload, err)
		}
	}
	return total, nil
}

// toOwed builds the ledger entry a delivery left unpaid produces, and nil for
// one paid at the door.
//
// This is §15's fan-out reaching §16: goods arrived and the shop owes for them,
// so the supplier's ledger gains an entry in the same transaction as the
// delivery. Deriving the amount here rather than trusting a figure from the
// payload means the debt is the delivery's own arithmetic.
//
// Whether the delivery is on credit is decided by the settlement, not by the
// presence of an identifier. A device that disagrees with the server about
// which of those is true is told, rather than having one silently preferred.
func (p PurchasePayload) toOwed(
	scope business.Scope,
	envelope sync.Envelope,
	purchase *purchases.Purchase,
	settlement purchases.Settlement,
	recordedAt time.Time,
) (*suppliers.Transaction, error) {
	if !settlement.OnCredit() {
		if p.SupplierTransactionID != "" {
			return nil, fmt.Errorf(
				"%w: the delivery carries a ledger entry but leaves nothing owing",
				sync.ErrInvalidPayload)
		}
		return nil, nil
	}
	if p.SupplierTransactionID == "" {
		return nil, fmt.Errorf("%w: %s is left owing with no ledger entry to carry it",
			sync.ErrInvalidPayload, settlement.Outstanding)
	}

	transactionID, err := suppliers.ParseTransactionID(p.SupplierTransactionID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	// Settle has already refused an outstanding balance with nobody to owe it,
	// so the delivery names a supplier by the time this runs.
	supplierID, _ := purchase.Supplier()

	branchID, _ := scope.Branch()
	owed, err := suppliers.RecordTransaction(suppliers.TransactionSnapshot{
		ID:         transactionID,
		SupplierID: supplierID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		Type:       suppliers.Purchase,
		Amount:     settlement.Outstanding,
		// What caused the debt, which is how a statement line is traced back to
		// the delivery note it came from (§16, §40).
		Reference:  suppliers.Reference{Kind: "PURCHASE", ID: purchase.ID().String()},
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: purchase.OccurredAt(),
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return owed, nil
}

func (p PurchasePayload) toPurchase(
	scope business.Scope, envelope sync.Envelope, recordedAt time.Time,
) (*purchases.Purchase, error) {
	purchaseID, err := purchases.ParseID(p.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	supplierID := suppliers.ID{}
	if p.SupplierID != "" {
		supplierID, err = suppliers.ParseID(p.SupplierID)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
		}
	}

	occurredAt, err := saleMoment(p.OccurredAt, envelope.OccurredAt)
	if err != nil {
		return nil, err
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: the delivery claims to have arrived in the future",
			sync.ErrInvalidPayload)
	}

	items := make([]purchases.ItemSnapshot, 0, len(p.Items))
	for i, line := range p.Items {
		item, err := line.toItem()
		if err != nil {
			return nil, fmt.Errorf("item %d: %w", i, err)
		}
		items = append(items, item)
	}

	branchID, _ := scope.Branch()
	purchase, err := purchases.Record(purchases.Snapshot{
		ID:         purchaseID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		SupplierID: supplierID,
		Reference:  p.Reference,
		Items:      items,
		Note:       p.Note,
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: occurredAt,
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return purchase, nil
}

func (i PurchaseItemPayload) toItem() (purchases.ItemSnapshot, error) {
	itemID, err := purchases.ParseItemID(i.ID)
	if err != nil {
		return purchases.ItemSnapshot{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	productID, err := products.ParseID(i.ProductID)
	if err != nil {
		return purchases.ItemSnapshot{}, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}

	// XAF is fixed here rather than read from the payload. §46 says the system
	// is XAF, and a device announcing another would put two currencies in one
	// delivery where nothing adds them up.
	unitCost, err := money.New(i.UnitCostMinor, money.XAF)
	if err != nil {
		return purchases.ItemSnapshot{}, fmt.Errorf("%w: unit cost: %w", sync.ErrInvalidPayload, err)
	}

	return purchases.ItemSnapshot{
		ID:        itemID,
		ProductID: productID,
		UnitCost:  unitCost,
		Quantity:  quantity.FromThousandths(i.Quantity),
	}, nil
}

func (p PurchasePaymentPayload) toMovement(
	scope business.Scope, envelope sync.Envelope,
	purchase *purchases.Purchase, recordedAt time.Time,
) (*finance.Movement, error) {
	movementID, err := finance.ParseMovementID(p.ID)
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

	occurredAt, err := saleMoment(p.OccurredAt, purchase.OccurredAt())
	if err != nil {
		return nil, err
	}
	if occurredAt.After(recordedAt) {
		return nil, fmt.Errorf("%w: the payment claims to have happened in the future",
			sync.ErrInvalidPayload)
	}

	branchID, _ := scope.Branch()
	movement, err := finance.RecordMovement(finance.MovementSnapshot{
		ID:         movementID,
		AccountID:  accountID,
		BusinessID: scope.Business(),
		BranchID:   branchID,
		Type:       finance.CashOut,
		Amount:     amount,
		Reason:     p.Reason,
		UserID:     envelope.UserID,
		DeviceID:   envelope.DeviceID,
		OccurredAt: occurredAt,
		RecordedAt: recordedAt,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", sync.ErrInvalidPayload, err)
	}
	return movement, nil
}
