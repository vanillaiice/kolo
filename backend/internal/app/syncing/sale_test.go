package syncing_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// saleBody builds a SALE_COMPLETED payload, defaulting to the §11 worked
// example: 18,500 settled by 10,000 cash and 8,500 Mobile Money.
type saleBody struct {
	saleID     sales.ID
	customerID string
	items      []map[string]any
	payments   []map[string]any
	movements  []map[string]any
	discount   int64
}

func (b saleBody) payload(t *testing.T) json.RawMessage {
	t.Helper()

	if b.saleID.IsZero() {
		b.saleID = sales.NewID()
	}
	productID := products.NewID().String()
	if b.items == nil {
		b.items = []map[string]any{{
			"id":               sales.NewItemID().String(),
			"product_id":       productID,
			"name":             "Riz parfumé 5kg",
			"unit_price_minor": 18_500,
			"quantity":         1_000,
		}}
	}
	if b.payments == nil {
		b.payments = []map[string]any{
			{
				"id":           sales.NewPaymentID().String(),
				"account_id":   finance.NewAccountID().String(),
				"amount_minor": 10_000,
			},
			{
				"id":           sales.NewPaymentID().String(),
				"account_id":   finance.NewAccountID().String(),
				"amount_minor": 8_500,
				"reference":    "MP260814.0930.A12345",
			},
		}
	}

	sale := map[string]any{
		"id":          b.saleID.String(),
		"number":      "V-" + b.saleID.String(),
		"items":       b.items,
		"occurred_at": occurredAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	if b.customerID != "" {
		sale["customer_id"] = b.customerID
	}
	if b.discount != 0 {
		sale["discount_minor"] = b.discount
	}

	body := map[string]any{"sale": sale, "payments": b.payments}
	if b.movements != nil {
		body["movements"] = b.movements
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}
	return encoded
}

func (f *fixture) saleEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.SaleCompleted
	envelope.Payload = payload
	return envelope
}

// A sale pushed from a till lands whole: the sale, its lines, and its payments.
func TestACompletedSaleIsApplied(t *testing.T) {
	f := newFixture(t)

	saleID := sales.NewID()
	envelope := f.saleEvent(1, saleBody{saleID: saleID}.payload(t))

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	stored := f.store.sale(saleID)
	if stored == nil {
		t.Fatal("the sale was not applied")
	}
	total, err := stored.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if total.Amount() != 18_500 {
		t.Errorf("total = %s, want 18500 XAF", total)
	}
	if stored.BusinessID() != f.tenant {
		t.Errorf("the sale landed in %s, want %s", stored.BusinessID(), f.tenant)
	}
	// Who sold it and on what comes from the envelope, not the payload.
	if stored.UserID() != f.user || stored.DeviceID() != f.till {
		t.Errorf("attributed to %s/%s, want %s/%s",
			stored.UserID(), stored.DeviceID(), f.user, f.till)
	}

	payments := f.store.paymentsOf(saleID)
	if len(payments) != 2 {
		t.Fatalf("got %d payments, want the split of 2", len(payments))
	}
	settlement, err := sales.Settle(stored, payments)
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if !settlement.Settled() {
		t.Errorf("outstanding = %s, want a settled sale", settlement.Outstanding)
	}
}

// The stock a sale released travels with it and lands in the same event.
func TestACompletedSaleMovesItsStock(t *testing.T) {
	f := newFixture(t)

	saleID := sales.NewID()
	productID := products.NewID().String()
	body := saleBody{
		saleID: saleID,
		items: []map[string]any{{
			"id":               sales.NewItemID().String(),
			"product_id":       productID,
			"name":             "Riz parfumé 5kg",
			"unit_price_minor": 18_500,
			"quantity":         1_000,
		}},
		movements: []map[string]any{{
			"id":             inventory.NewMovementID().String(),
			"product_id":     productID,
			"type":           "SALE",
			"quantity":       -1_000,
			"reference_kind": "SALE",
			"reference_id":   saleID.String(),
		}},
	}

	envelope := f.saleEvent(1, body.payload(t))
	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	if got := len(f.store.applied(envelope.ID)); got != 1 {
		t.Errorf("the sale moved %d movements, want 1", got)
	}
}

// A sale left partly unpaid is credit, and needs a customer to owe it (§13).
func TestACreditSaleNeedsItsCustomer(t *testing.T) {
	t.Run("with one", func(t *testing.T) {
		f := newFixture(t)
		saleID := sales.NewID()

		body := saleBody{
			saleID:     saleID,
			customerID: customers.NewID().String(),
			payments: []map[string]any{{
				"id":           sales.NewPaymentID().String(),
				"account_id":   finance.NewAccountID().String(),
				"amount_minor": 10_000,
			}},
		}
		if got := f.push(t, f.saleEvent(1, body.payload(t))).Results[0].Status; got != syncing.Accepted {
			t.Fatalf("Status = %q, want accepted", got)
		}

		settlement, err := sales.Settle(f.store.sale(saleID), f.store.paymentsOf(saleID))
		if err != nil {
			t.Fatalf("Settle: %v", err)
		}
		if got := settlement.Outstanding.Amount(); got != 8_500 {
			t.Errorf("outstanding = %d, want 8500", got)
		}
	})

	t.Run("without one", func(t *testing.T) {
		f := newFixture(t)
		body := saleBody{
			payments: []map[string]any{{
				"id":           sales.NewPaymentID().String(),
				"account_id":   finance.NewAccountID().String(),
				"amount_minor": 10_000,
			}},
		}

		// A debt with no debtor could never be collected. The server refuses it
		// rather than storing a balance nobody owes.
		if got := f.push(t, f.saleEvent(1, body.payload(t))).Results[0].Status; got != syncing.Rejected {
			t.Errorf("Status = %q, want rejected", got)
		}
	})
}

// Paying more than the bill is a device sending the wrong figure, and would put
// money in the accounts the business never took.
func TestAnOverpaidSaleIsRejected(t *testing.T) {
	f := newFixture(t)

	body := saleBody{payments: []map[string]any{{
		"id":           sales.NewPaymentID().String(),
		"account_id":   finance.NewAccountID().String(),
		"amount_minor": 18_501,
	}}}

	if got := f.push(t, f.saleEvent(1, body.payload(t))).Results[0].Status; got != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", got)
	}
}

// A sale is immutable. A second event carrying the same sale under a different
// event identifier must not overwrite the first (§41).
func TestASaleCannotBeOverwrittenByALaterEvent(t *testing.T) {
	f := newFixture(t)

	saleID := sales.NewID()
	first := f.saleEvent(1, saleBody{saleID: saleID}.payload(t))
	if got := f.push(t, first).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("the first push: %q", got)
	}

	// The same sale, different money, under a new event.
	second := f.saleEvent(2, saleBody{
		saleID: saleID,
		items: []map[string]any{{
			"id":               sales.NewItemID().String(),
			"product_id":       products.NewID().String(),
			"name":             "Riz parfumé 5kg",
			"unit_price_minor": 1,
			"quantity":         1_000,
		}},
		payments: []map[string]any{{
			"id":           sales.NewPaymentID().String(),
			"account_id":   finance.NewAccountID().String(),
			"amount_minor": 1,
		}},
	}.payload(t))

	result := f.push(t, second).Results[0]
	if result.Status != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", result.Status)
	}

	total, err := f.store.sale(saleID).Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if total.Amount() != 18_500 {
		t.Errorf("total = %s, want the original 18500", total)
	}
}

// Replaying the same event is a success that changes nothing.
func TestAReplayedSaleEventIsADuplicate(t *testing.T) {
	f := newFixture(t)

	saleID := sales.NewID()
	envelope := f.saleEvent(1, saleBody{saleID: saleID}.payload(t))

	f.push(t, envelope)
	if got := f.push(t, envelope).Results[0].Status; got != syncing.Duplicate {
		t.Errorf("Status = %q, want duplicate", got)
	}

	total, err := f.store.sale(saleID).Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if total.Amount() != 18_500 {
		t.Errorf("total = %s, want it unchanged", total)
	}
}

// A payload the server cannot turn into a sale is rejected on its own, and the
// events around it are unaffected.
func TestABadSalePayloadIsRejected(t *testing.T) {
	item := func(mutate map[string]any) []map[string]any {
		line := map[string]any{
			"id":               sales.NewItemID().String(),
			"product_id":       products.NewID().String(),
			"name":             "Riz",
			"unit_price_minor": 1_000,
			"quantity":         1_000,
		}
		for key, value := range mutate {
			line[key] = value
		}
		return []map[string]any{line}
	}
	free := []map[string]any{}

	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{"no sale at all", json.RawMessage(`{}`)},
		{"no items", saleBody{items: []map[string]any{}, payments: free}.payload(t)},
		{"a line selling nothing", saleBody{items: item(map[string]any{"quantity": 0}), payments: free}.payload(t)},
		{"a negative line", saleBody{items: item(map[string]any{"quantity": -1_000}), payments: free}.payload(t)},
		{"a negative price", saleBody{items: item(map[string]any{"unit_price_minor": -1}), payments: free}.payload(t)},
		{"a line with no product", saleBody{items: item(map[string]any{"product_id": "nope"}), payments: free}.payload(t)},
		{"a discount above the line", saleBody{
			items:    item(map[string]any{"discount_minor": 1_001}),
			payments: free,
		}.payload(t)},
		{"a payment of nothing", saleBody{payments: []map[string]any{{
			"id": sales.NewPaymentID().String(), "account_id": finance.NewAccountID().String(),
			"amount_minor": 0,
		}}}.payload(t)},
		{"a payment with no account", saleBody{payments: []map[string]any{{
			"id": sales.NewPaymentID().String(), "account_id": "nope", "amount_minor": 1,
		}}}.payload(t)},
		{"a field from a newer client", json.RawMessage(`{"sale":{"id":"x"},"loyalty":true}`)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)

			before, after := f.envelope(1), f.envelope(3)
			broken := f.saleEvent(2, testCase.payload)

			response := f.push(t, before, broken, after)

			if got := response.Results[1].Status; got != syncing.Rejected {
				t.Errorf("the bad sale was %q, want rejected", got)
			}
			for _, index := range []int{0, 2} {
				if got := response.Results[index].Status; got != syncing.Accepted {
					t.Errorf("the event at %d was %q, want accepted", index, got)
				}
			}
		})
	}
}

// A sale dated after it arrived is refused, as a movement is.
func TestASaleFromTheFutureIsRejected(t *testing.T) {
	f := newFixture(t)

	saleID := sales.NewID()
	body := map[string]any{
		"sale": map[string]any{
			"id":     saleID.String(),
			"number": "V-1",
			"items": []map[string]any{{
				"id":               sales.NewItemID().String(),
				"product_id":       products.NewID().String(),
				"name":             "Riz",
				"unit_price_minor": 1_000,
				"quantity":         1_000,
			}},
			"occurred_at": recordedAt.Add(time.Hour).Format("2006-01-02T15:04:05Z07:00"),
		},
		"payments": []map[string]any{{
			"id":           sales.NewPaymentID().String(),
			"account_id":   finance.NewAccountID().String(),
			"amount_minor": 1_000,
		}},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}

	if got := f.push(t, f.saleEvent(1, encoded)).Results[0].Status; got != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", got)
	}
}

// A sale entirely on credit records no payment at all, which is a real thing a
// shop does for a regular customer (§13).
func TestASaleWhollyOnCreditIsAccepted(t *testing.T) {
	f := newFixture(t)

	saleID := sales.NewID()
	body := saleBody{
		saleID:     saleID,
		customerID: customers.NewID().String(),
		payments:   []map[string]any{},
	}

	if got := f.push(t, f.saleEvent(1, body.payload(t))).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	settlement, err := sales.Settle(f.store.sale(saleID), f.store.paymentsOf(saleID))
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}
	if !settlement.OnCredit() || settlement.Outstanding.Amount() != 18_500 {
		t.Errorf("outstanding = %s, want the whole 18500 owed", settlement.Outstanding)
	}
}
