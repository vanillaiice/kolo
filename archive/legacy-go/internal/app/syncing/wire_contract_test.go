package syncing_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// The payloads below are the literal bytes the client emits.
//
// They were taken from what `suppliers.ts` and `purchases.ts` actually queued,
// not written by hand to match the Go structs — which is the only way this test
// is worth anything. The two sides are halves of one wire format and nothing but
// a test holds them together: the server refuses a payload carrying a field it
// does not know, so a field added on one side and not the other **rejects every
// event from that client**, with the delivery already recorded on the till and
// nothing there to explain it.
//
// If one of these fails after a change to the client, the fix is to change both
// sides together, never to loosen the decoder.
const (
	clientSupplierSaved = `{"supplier":{` +
		`"id":"77777777-7777-7777-8777-777777777777",` +
		`"name":"Grossiste Mokolo",` +
		`"created_at":"2026-08-01T08:00:00.000Z",` +
		`"updated_at":"2026-08-14T09:00:00.000Z",` +
		`"phone":"+237677889900",` +
		`"address":"Marché Mokolo",` +
		`"contact":"Mama Ngo",` +
		`"notes":"livre le mardi",` +
		`"active":false}}`

	clientPurchaseRecorded = `{"purchase":{` +
		`"id":"88888888-8888-7888-8888-888888888888",` +
		`"occurred_at":"2026-08-14T09:00:00.000Z",` +
		`"items":[{"id":"99999999-9999-7999-8999-999999999999",` +
		`"product_id":"66666666-6666-7666-8666-666666666666",` +
		`"unit_cost_minor":5000,"quantity":20000}],` +
		`"supplier_id":"77777777-7777-7777-8777-777777777777",` +
		`"reference":"BL-2026-118",` +
		`"supplier_transaction_id":"cccccccc-cccc-7ccc-8ccc-cccccccccccc",` +
		`"note":"livré le matin"},` +
		`"payments":[{"id":"bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",` +
		`"account_id":"55555555-5555-7555-8555-555555555555",` +
		`"amount_minor":-40000,"reason":"acompte",` +
		`"occurred_at":"2026-08-14T09:00:00.000Z"}],` +
		`"movements":[{"id":"aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",` +
		`"product_id":"66666666-6666-7666-8666-666666666666",` +
		`"type":"PURCHASE","quantity":20000,"unit_cost_minor":5000,` +
		`"reference_kind":"PURCHASE",` +
		`"reference_id":"88888888-8888-7888-8888-888888888888"}]}`

	clientSupplierPayment = `{"payment":{` +
		`"id":"eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee",` +
		`"supplier_id":"77777777-7777-7777-8777-777777777777",` +
		`"account_id":"55555555-5555-7555-8555-555555555555",` +
		`"amount_minor":50000,` +
		`"occurred_at":"2026-08-14T09:00:00.000Z",` +
		`"note":"acompte sur la facture 118"}}`
)

// What the client sends is what this build reads.
func TestTheClientsSupplierAndPurchasePayloadsAreAccepted(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		eventType sync.Type
		payload   string
	}{
		{"a wholesaler", sync.SupplierSaved, clientSupplierSaved},
		{"a delivery", sync.PurchaseRecorded, clientPurchaseRecorded},
		{"settling an account", sync.SupplierPaid, clientSupplierPayment},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)

			envelope := f.envelope(1)
			envelope.Type = testCase.eventType
			envelope.Payload = json.RawMessage(testCase.payload)

			result := f.push(t, envelope).Results[0]
			if result.Status != syncing.Accepted {
				t.Fatalf("Status = %q (%s), want accepted — the client and the server "+
					"disagree about this payload", result.Status, result.Reason)
			}
		})
	}
}

// The delivery arrives whole, and the debt is the server's own arithmetic: the
// client sent no figure for it, and 100,000 less the 40,000 handed over is
// 60,000 on both sides.
func TestTheClientsDeliveryLandsWithTheDebtTheServerWorksOut(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.Type = sync.PurchaseRecorded
	envelope.Payload = json.RawMessage(clientPurchaseRecorded)
	f.push(t, envelope)

	purchaseID, err := purchases.ParseID("88888888-8888-7888-8888-888888888888")
	if err != nil {
		t.Fatalf("ParseID: %v", err)
	}
	if f.store.purchase(purchaseID) == nil {
		t.Fatal("the client's delivery was not recorded")
	}

	supplierID, err := suppliers.ParseID("77777777-7777-7777-8777-777777777777")
	if err != nil {
		t.Fatalf("ParseID: %v", err)
	}
	owed := f.store.owedTo(supplierID)
	if len(owed) != 1 {
		t.Fatalf("recorded %d ledger entries, want 1", len(owed))
	}
	if got := owed[0].Amount().Amount(); got != 60_000 {
		t.Errorf("owed %d, want the 60000 the delivery's own arithmetic leaves", got)
	}

	// The identifiers are the ones the client drew, not composed from anything:
	// every identifier in a payload is parsed as a UUID on arrival (ADR-011),
	// and that identifier is what makes a replay a duplicate.
	if got := owed[0].ID().String(); got != "cccccccc-cccc-7ccc-8ccc-cccccccccccc" {
		t.Errorf("the ledger entry is %s, want the identifier the device drew", got)
	}
	if got := len(f.store.applied(envelope.ID)); got != 1 {
		t.Errorf("applied %d movements, want the stock that arrived", got)
	}
}

// A field one side knows and the other does not is the failure this pair of
// files exists to prevent, so the refusal itself is worth a test: it must be a
// rejection the device can see, not a field quietly dropped.
func TestAFieldTheServerDoesNotKnowIsRefusedRatherThanDropped(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.Type = sync.SupplierSaved
	// As if a newer client had added payment terms and the server had not.
	envelope.Payload = json.RawMessage(`{"supplier":{` +
		`"id":"77777777-7777-7777-8777-777777777777","name":"Grossiste Mokolo",` +
		`"created_at":"2026-08-01T08:00:00.000Z","updated_at":"2026-08-14T09:00:00.000Z",` +
		`"payment_terms_days":30}}`)

	result := f.push(t, envelope).Results[0]
	if result.Status != syncing.Rejected {
		t.Fatalf("Status = %q, want rejected", result.Status)
	}
	if result.Reason == "" {
		t.Error("a rejection the device cannot act on")
	}
}
