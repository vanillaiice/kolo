package syncing_test

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// delivery describes one PURCHASE_RECORDED for a test. The zero value is §15's
// worked example — 20 crates at 5,000, paid in full at the door — so a test
// states only what it cares about.
type delivery struct {
	purchaseID purchases.ID
	supplierID suppliers.ID
	productID  products.ID
	// unitCostMinor and units make the bill. 20 × 5,000 is 100,000.
	unitCostMinor int64
	units         int64
	// paidMinor is what was handed over. Zero means nothing was, which puts the
	// whole bill on the supplier's account.
	paidMinor int64
	accountID finance.AccountID
	// owedID is the ledger entry for what is left owing, drawn by the device.
	owedID suppliers.TransactionID
	// noSupplier makes it a crate bought at the market, with nobody to name.
	noSupplier bool
	// omitMovements leaves out the stock, for the tests about the fan-out.
	omitMovements bool
}

func (d delivery) payload(extra ...func(map[string]any)) json.RawMessage {
	if d.purchaseID.IsZero() {
		d.purchaseID = purchases.NewID()
	}
	if d.supplierID.IsZero() {
		d.supplierID = suppliers.NewID()
	}
	if d.productID.IsZero() {
		d.productID = products.NewID()
	}
	if d.unitCostMinor == 0 {
		d.unitCostMinor = 5_000
	}
	if d.units == 0 {
		d.units = 20
	}

	purchase := map[string]any{
		"id": d.purchaseID.String(),
		"items": []any{map[string]any{
			"id":              purchases.NewItemID().String(),
			"product_id":      d.productID.String(),
			"unit_cost_minor": d.unitCostMinor,
			"quantity":        d.units * 1_000,
		}},
		"occurred_at": occurredAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	if !d.noSupplier {
		purchase["supplier_id"] = d.supplierID.String()
	}
	if !d.owedID.IsZero() {
		purchase["supplier_transaction_id"] = d.owedID.String()
	}

	body := map[string]any{"purchase": purchase}
	if d.paidMinor != 0 {
		if d.accountID.IsZero() {
			d.accountID = finance.NewAccountID()
		}
		body["payments"] = []any{map[string]any{
			"id":           finance.NewMovementID().String(),
			"account_id":   d.accountID.String(),
			"amount_minor": -d.paidMinor,
			"reason":       "payé au livreur",
		}}
	}
	if !d.omitMovements {
		body["movements"] = []any{map[string]any{
			"id":              inventory.NewMovementID().String(),
			"product_id":      d.productID.String(),
			"type":            "PURCHASE",
			"quantity":        d.units * 1_000,
			"unit_cost_minor": d.unitCostMinor,
			"reference_kind":  "PURCHASE",
			"reference_id":    d.purchaseID.String(),
		}}
	}

	for _, change := range extra {
		change(body)
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return encoded
}

func (f *fixture) purchaseEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.PurchaseRecorded
	envelope.Payload = payload
	return envelope
}

// §15's first case: paid at the door. Stock arrives, cash leaves, and the
// wholesaler is owed nothing.
func TestADeliveryPaidAtTheDoorIsAppliedWhole(t *testing.T) {
	f := newFixture(t)

	purchaseID, supplierID := purchases.NewID(), suppliers.NewID()
	accountID := finance.NewAccountID()
	event := f.purchaseEvent(1, delivery{
		purchaseID: purchaseID,
		supplierID: supplierID,
		paidMinor:  100_000,
		accountID:  accountID,
	}.payload())

	if got := f.push(t, event).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	saved := f.store.purchase(purchaseID)
	if saved == nil {
		t.Fatal("the delivery was not recorded")
	}
	total, err := saved.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if total.Amount() != 100_000 {
		t.Errorf("total = %d, want 100000", total.Amount())
	}
	if saved.BusinessID() != f.tenant {
		t.Errorf("the delivery landed in %s, want %s", saved.BusinessID(), f.tenant)
	}

	// The stock it brought in, in the same event.
	if got := len(f.store.applied(event.ID)); got != 1 {
		t.Errorf("applied %d movements, want the stock that arrived", got)
	}
	// The money that left, against the account it left.
	paid := f.store.cashOf(accountID)
	if len(paid) != 1 {
		t.Fatalf("recorded %d payments, want 1", len(paid))
	}
	if got := paid[0].Amount().Amount(); got != -100_000 {
		t.Errorf("the payment was %d, want -100000: money leaving is negative", got)
	}
	if paid[0].Type() != finance.CashOut {
		t.Errorf("the payment is a %s, want CASH_OUT", paid[0].Type())
	}
	// And nothing owed, which is the whole point of paying at the door.
	if owed := f.store.owedTo(supplierID); len(owed) != 0 {
		t.Errorf("the supplier is owed %d entries for a delivery paid for", len(owed))
	}
}

// §15's second case: on credit. Stock arrives, no cash moves, and the ledger
// carries the whole bill.
func TestADeliveryOnCreditOwesTheWholeBill(t *testing.T) {
	f := newFixture(t)

	purchaseID, supplierID := purchases.NewID(), suppliers.NewID()
	owedID := suppliers.NewTransactionID()
	event := f.purchaseEvent(1, delivery{
		purchaseID: purchaseID,
		supplierID: supplierID,
		owedID:     owedID,
	}.payload())

	if got := f.push(t, event).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	owed := f.store.owedTo(supplierID)
	if len(owed) != 1 {
		t.Fatalf("recorded %d ledger entries, want 1", len(owed))
	}
	entry := owed[0]
	if entry.ID() != owedID {
		t.Errorf("the entry is %s, want the identifier the device drew", entry.ID())
	}
	if entry.Type() != suppliers.Purchase {
		t.Errorf("the entry is a %s, want PURCHASE", entry.Type())
	}
	if got := entry.Amount().Amount(); got != 100_000 {
		t.Errorf("owed %d, want the whole 100000", got)
	}
	// Traced back to the delivery note it came from (§16, §40).
	reference, named := entry.Reference()
	if !named || reference.Kind != "PURCHASE" || reference.ID != purchaseID.String() {
		t.Errorf("reference = %v (%t), want the delivery", reference, named)
	}
	if entry.SupplierID() != supplierID {
		t.Errorf("owed to %s, want the delivery's supplier %s", entry.SupplierID(), supplierID)
	}
}

// The debt is the delivery's own arithmetic, not a figure on the wire: 100,000
// less the 40,000 handed over is 60,000, and no payload says so.
func TestAPartlyPaidDeliveryOwesTheRest(t *testing.T) {
	f := newFixture(t)

	supplierID := suppliers.NewID()
	event := f.purchaseEvent(1, delivery{
		supplierID: supplierID,
		paidMinor:  40_000,
		owedID:     suppliers.NewTransactionID(),
	}.payload())

	if got := f.push(t, event).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	owed := f.store.owedTo(supplierID)
	if len(owed) != 1 {
		t.Fatalf("recorded %d ledger entries, want 1", len(owed))
	}
	if got := owed[0].Amount().Amount(); got != 60_000 {
		t.Errorf("owed %d, want the 60000 the delivery's own arithmetic leaves", got)
	}
}

// A crate bought at the market names nobody. The money still has to be recorded
// as having left the drawer, which is why a door payment is a movement against
// the account rather than an entry in a ledger that does not exist.
func TestADeliveryFromNobodyStillRecordsTheMoneyLeaving(t *testing.T) {
	f := newFixture(t)

	accountID := finance.NewAccountID()
	event := f.purchaseEvent(1, delivery{
		noSupplier: true,
		paidMinor:  100_000,
		accountID:  accountID,
	}.payload())

	if got := f.push(t, event).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	if got := len(f.store.cashOf(accountID)); got != 1 {
		t.Errorf("recorded %d payments, want the money that left the drawer", got)
	}
}

// What is left owing has to be owed to someone, or it could never be paid or
// reported (§16). The device is told rather than the debt being dropped.
func TestADeliveryLeftOwingWithNobodyToOweIsRejected(t *testing.T) {
	f := newFixture(t)

	event := f.purchaseEvent(1, delivery{
		noSupplier: true,
		owedID:     suppliers.NewTransactionID(),
	}.payload())

	result := f.push(t, event).Results[0]
	if result.Status != syncing.Rejected {
		t.Fatalf("Status = %q, want rejected", result.Status)
	}
	if result.Reason == "" {
		t.Error("a rejection with nothing to say why")
	}
}

// Whether a delivery is on credit is the settlement's answer, not the presence
// of an identifier. A device that disagrees is told, rather than having one of
// the two silently preferred.
func TestADeliveryAndItsLedgerEntryMustAgree(t *testing.T) {
	for _, testCase := range []struct {
		name string
		bill delivery
	}{
		{"owing with no entry to carry it", delivery{}},
		{"an entry against a delivery that owes nothing", delivery{
			paidMinor: 100_000,
			owedID:    suppliers.NewTransactionID(),
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			result := f.push(t, f.purchaseEvent(1, testCase.bill.payload())).Results[0]

			if result.Status != syncing.Rejected {
				t.Fatalf("Status = %q, want rejected", result.Status)
			}
			if result.Reason == "" {
				t.Error("a rejection with nothing to say why")
			}
		})
	}
}

// Paying more than the delivery came to is someone recording the wrong figure.
// Storing it would take money out of an account the business never handed over.
func TestADeliveryPaidMoreThanItCostIsRejected(t *testing.T) {
	f := newFixture(t)

	result := f.push(t, f.purchaseEvent(1, delivery{paidMinor: 150_000}.payload())).Results[0]
	if result.Status != syncing.Rejected {
		t.Fatalf("Status = %q, want rejected", result.Status)
	}
}

func TestABadDeliveryPayloadIsRejected(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{"not JSON at all", json.RawMessage(`{`)},
		{"no identifier", delivery{purchaseID: purchases.ID{}}.payload(
			func(body map[string]any) {
				body["purchase"].(map[string]any)["id"] = purchases.ID{}.String()
			})},
		{"an identifier that is not one", delivery{}.payload(
			func(body map[string]any) {
				body["purchase"].(map[string]any)["id"] = "not-a-uuid"
			})},
		{"a supplier that is not an identifier", delivery{}.payload(
			func(body map[string]any) {
				body["purchase"].(map[string]any)["supplier_id"] = "chez le grossiste"
			})},
		{"a delivery of nothing", delivery{}.payload(
			func(body map[string]any) {
				body["purchase"].(map[string]any)["items"] = []any{}
			})},
		{"a line of no quantity", delivery{units: 0}.payload(
			func(body map[string]any) {
				items := body["purchase"].(map[string]any)["items"].([]any)
				items[0].(map[string]any)["quantity"] = 0
			})},
		{"a line costing less than nothing", delivery{}.payload(
			func(body map[string]any) {
				items := body["purchase"].(map[string]any)["items"].([]any)
				items[0].(map[string]any)["unit_cost_minor"] = -1
			})},
		{"a line naming no product", delivery{}.payload(
			func(body map[string]any) {
				items := body["purchase"].(map[string]any)["items"].([]any)
				items[0].(map[string]any)["product_id"] = ""
			})},
		{"a delivery that arrived in the future", delivery{}.payload(
			func(body map[string]any) {
				body["purchase"].(map[string]any)["occurred_at"] = "2027-01-01T00:00:00Z"
			})},
		{"an arrival time that is not a time", delivery{}.payload(
			func(body map[string]any) {
				body["purchase"].(map[string]any)["occurred_at"] = "mardi"
			})},
		{"a payment naming no account", delivery{paidMinor: 100_000}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["account_id"] = ""
			})},
		{"a payment with no reason for the cash leaving", delivery{paidMinor: 100_000}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["reason"] = ""
			})},
		{"a payment that puts money in rather than taking it out", delivery{paidMinor: 100_000}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["amount_minor"] = 100_000
			})},
		{"a line identifier that is not one", delivery{}.payload(
			func(body map[string]any) {
				items := body["purchase"].(map[string]any)["items"].([]any)
				items[0].(map[string]any)["id"] = "ligne 1"
			})},
		{"a ledger entry identifier that is not one", delivery{}.payload(
			func(body map[string]any) {
				body["purchase"].(map[string]any)["supplier_transaction_id"] = "la dette"
			})},
		{"a payment identifier that is not one", delivery{paidMinor: 100_000}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["id"] = "le paiement"
			})},
		{"a payment time that is not a time", delivery{paidMinor: 100_000}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["occurred_at"] = "à midi"
			})},
		{"a payment made in the future", delivery{paidMinor: 100_000}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["occurred_at"] = "2027-01-01T00:00:00Z"
			})},
		{"stock that arrived in the future", delivery{}.payload(
			func(body map[string]any) {
				movements := body["movements"].([]any)
				movements[0].(map[string]any)["occurred_at"] = "2027-01-01T00:00:00Z"
			})},
		// The arithmetic has an edge, and a delivery at it is refused rather
		// than wrapping round into one that looks paid for.
		{"a payment of more money than there is", delivery{paidMinor: 1}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["amount_minor"] = math.MinInt64
			})},
		{"two payments that cannot be added", delivery{paidMinor: 1}.payload(
			func(body map[string]any) {
				payments := body["payments"].([]any)
				payments[0].(map[string]any)["amount_minor"] = -math.MaxInt64
				second := map[string]any{
					"id":           finance.NewMovementID().String(),
					"account_id":   finance.NewAccountID().String(),
					"amount_minor": -math.MaxInt64,
					"reason":       "payé au livreur",
				}
				body["payments"] = append(payments, second)
			})},
		// A field this build does not know might be the very thing that changes
		// what the delivery means, so it is refused rather than dropped.
		{"a field from a newer client", delivery{}.payload(
			func(body map[string]any) { body["carrier"] = "Camion 4" })},
		{"a line field from a newer client", delivery{}.payload(
			func(body map[string]any) {
				items := body["purchase"].(map[string]any)["items"].([]any)
				items[0].(map[string]any)["batch_number"] = "L-42"
			})},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			result := f.push(t, f.purchaseEvent(1, testCase.payload)).Results[0]

			if result.Status != syncing.Rejected {
				t.Fatalf("Status = %q, want rejected", result.Status)
			}
			if result.Reason == "" {
				t.Error("a rejection with nothing to say why")
			}
			if f.store.rejectedCount() != 1 {
				t.Error("the rejection was not kept for anyone to see")
			}
		})
	}
}

// A replay must not double a delivery, its stock, or what the shop owes: a till
// back from a week offline resends everything it holds (§27).
func TestReplayingADeliveryIsADuplicate(t *testing.T) {
	f := newFixture(t)

	supplierID := suppliers.NewID()
	event := f.purchaseEvent(1, delivery{
		supplierID: supplierID,
		owedID:     suppliers.NewTransactionID(),
	}.payload())

	if got := f.push(t, event).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("first push: Status = %q, want accepted", got)
	}
	if got := f.push(t, event).Results[0].Status; got != syncing.Duplicate {
		t.Errorf("second push: Status = %q, want duplicate", got)
	}

	if owed := f.store.owedTo(supplierID); len(owed) != 1 {
		t.Errorf("the supplier is owed %d entries after a resend, want 1", len(owed))
	}
	if got := f.store.appliedTotal(); got != 1 {
		t.Errorf("the ledger holds %d movements after a resend, want 1", got)
	}
}

// The identity of everything a delivery produces comes from the envelope, so a
// device cannot write into another business's books by saying so (ADR-008).
func TestADeliveryTakesItsIdentityFromTheEnvelope(t *testing.T) {
	f := newFixture(t)

	purchaseID := purchases.NewID()
	event := f.purchaseEvent(1, delivery{purchaseID: purchaseID, paidMinor: 100_000}.payload())
	f.push(t, event)

	saved := f.store.purchase(purchaseID)
	if saved == nil {
		t.Fatal("the delivery was not recorded")
	}
	if saved.UserID() != f.user || saved.DeviceID() != f.till {
		t.Errorf("the delivery names user %s on device %s, want the authenticated caller",
			saved.UserID(), saved.DeviceID())
	}
}
