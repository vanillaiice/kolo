package syncing_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// A stock event that is merely filed is a server whose ledger disagrees with
// the device that sent it. Accepting one has to move the stock.
func TestAnAcceptedStockEventMovesStock(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	response := f.push(t, envelope)

	if got := response.Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	applied := f.store.applied(envelope.ID)
	if len(applied) != 1 {
		t.Fatalf("the event moved %d movements, want 1", len(applied))
	}

	snapshot := applied[0].Snapshot()
	if snapshot.BusinessID != f.tenant {
		t.Errorf("the movement landed in business %s, want %s", snapshot.BusinessID, f.tenant)
	}
	if snapshot.DeviceID != f.till {
		t.Errorf("DeviceID = %s, want the pushing device %s", snapshot.DeviceID, f.till)
	}
	if snapshot.UserID != f.user {
		t.Errorf("UserID = %s, want %s", snapshot.UserID, f.user)
	}
	// The stock moved when the device said it did, not when the server heard.
	if !snapshot.OccurredAt.Equal(occurredAt) {
		t.Errorf("OccurredAt = %s, want %s", snapshot.OccurredAt, occurredAt)
	}
	if !snapshot.RecordedAt.Equal(recordedAt) {
		t.Errorf("RecordedAt = %s, want %s", snapshot.RecordedAt, recordedAt)
	}
}

// One event can move several products, as a sale of three lines does, and all
// of them have to land.
func TestOneEventMovesEveryProductItNames(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.Payload = stockPayload(movementLine{}, movementLine{}, movementLine{})

	f.push(t, envelope)

	if applied := f.store.applied(envelope.ID); len(applied) != 3 {
		t.Fatalf("the event moved %d movements, want 3", len(applied))
	}
}

// A device that resends its backlog must not sell the same unit twice. This is
// the property §27 is about, seen from the ledger rather than the event log.
func TestAReplayedStockEventMovesNothingTwice(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	f.push(t, envelope)
	f.push(t, envelope)
	f.push(t, envelope)

	if got := f.store.appliedTotal(); got != 1 {
		t.Errorf("the ledger holds %d movements after three pushes, want 1", got)
	}
	if got := f.store.recorded(); got != 1 {
		t.Errorf("the log holds %d events, want 1", got)
	}
}

// The failure this whole design exists to prevent: if applying fails, the event
// must not be left recorded. Were it recorded, the device would be told the
// event landed, stop resending, and the stock would be lost with nothing able
// to detect it.
func TestAFailureToApplyLeavesTheEventUnrecorded(t *testing.T) {
	f := newFixture(t)
	f.store.failApply = true

	envelope := f.envelope(1)
	response := f.push(t, envelope)

	if f.store.recorded() != 0 {
		t.Error("the event was recorded even though its movements were not applied")
	}
	if f.store.appliedTotal() != 0 {
		t.Error("movements were applied even though the store failed")
	}
	// And the device must be told to try again, not that it is done.
	result := response.Results[0]
	if result.Settled() {
		t.Errorf("Status = %q, so the device would stop retrying and lose the stock", result.Status)
	}
}

// After the store recovers, the same event goes through. Nothing about the
// earlier failure is remembered against it.
func TestAnEventRetriedAfterAFailureIsApplied(t *testing.T) {
	f := newFixture(t)
	f.store.failApply = true

	envelope := f.envelope(1)
	f.push(t, envelope)

	f.store.failApply = false
	response := f.push(t, envelope)

	if got := response.Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted on the retry", got)
	}
	if got := f.store.appliedTotal(); got != 1 {
		t.Errorf("the ledger holds %d movements, want 1", got)
	}
}

// A payload the server cannot turn into movements is rejected, and rejected
// alone: the events around it are unaffected.
func TestABadStockPayloadIsRejectedOnItsOwn(t *testing.T) {
	good, bad := 0, 0
	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{"no movements", json.RawMessage(`{"movements":[]}`)},
		{"no movements key", json.RawMessage(`{}`)},
		{"a movement with no identifier", stockPayload(movementLine{id: "-"})},
		{"a movement with no product", stockPayload(movementLine{productID: "-"})},
		{"an unknown movement type", stockPayload(movementLine{kind: "TELEPORT"})},
		{"a sale that adds stock", stockPayload(movementLine{quantity: 1000})},
		{"a movement of nothing", stockPayload(movementLine{quantity: 0, kind: string(inventory.Adjustment)})},
		{"a field from a newer client", json.RawMessage(`{"movements":[],"discount":5}`)},
		{"movements that are not a list", json.RawMessage(`{"movements":"three"}`)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)

			before, after := f.envelope(1), f.envelope(3)
			broken := f.envelope(2)
			broken.Payload = testCase.payload

			response := f.push(t, before, broken, after)

			if got := response.Results[1].Status; got != syncing.Rejected {
				t.Errorf("the bad event was %q, want rejected", got)
			}
			for _, index := range []int{0, 2} {
				if got := response.Results[index].Status; got != syncing.Accepted {
					t.Errorf("the event at %d was %q, want accepted", index, got)
				}
			}
			if got := f.store.appliedTotal(); got != 2 {
				t.Errorf("the ledger holds %d movements, want the 2 good ones", got)
			}
			good, bad = good+2, bad+1
		})
	}
	if good == 0 || bad == 0 {
		t.Fatal("the table did not run")
	}
}

// A payload cannot put stock in another business's ledger. The identity comes
// from the authenticated envelope, so there is nowhere to say otherwise — this
// test pins that there is no such field rather than that it is ignored.
func TestAPayloadCannotNameAnotherTenant(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.Payload = json.RawMessage(`{"movements":[{"id":"` + inventory.NewMovementID().String() +
		`","product_id":"` + products.NewID().String() +
		`","type":"ADJUSTMENT","quantity":1000,"reason":"found some",` +
		`"business_id":"` + id.New().String() + `"}]}`)

	response := f.push(t, envelope)

	if got := response.Results[0].Status; got != syncing.Rejected {
		t.Fatalf("Status = %q, want rejected: business_id is not a field a device may send", got)
	}
	if f.store.appliedTotal() != 0 {
		t.Error("a movement was applied from a payload naming another tenant")
	}
}

// A movement claiming to have happened after it arrived is refused. A device
// clock can be wrong, and a future-dated movement would land in reports for a
// day that has not happened.
func TestAMovementFromTheFutureIsRejected(t *testing.T) {
	f := newFixture(t)

	future := recordedAt.Add(time.Hour).Format(time.RFC3339Nano)
	envelope := f.envelope(1)
	envelope.Payload = json.RawMessage(`{"movements":[{"id":"` + inventory.NewMovementID().String() +
		`","product_id":"` + products.NewID().String() +
		`","type":"ADJUSTMENT","quantity":1000,"reason":"found some","occurred_at":"` + future + `"}]}`)

	response := f.push(t, envelope)

	if got := response.Results[0].Status; got != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", got)
	}
}

// A backlog from days ago is not from the future, and must go through. This is
// the ordinary case §45 describes, and the guard above must not catch it.
func TestABacklogFromDaysAgoIsAccepted(t *testing.T) {
	f := newFixture(t)

	past := recordedAt.AddDate(0, 0, -9).Format(time.RFC3339Nano)
	envelope := f.envelope(1)
	envelope.Payload = json.RawMessage(`{"movements":[{"id":"` + inventory.NewMovementID().String() +
		`","product_id":"` + products.NewID().String() +
		`","type":"ADJUSTMENT","quantity":1000,"reason":"found some","occurred_at":"` + past + `"}]}`)

	response := f.push(t, envelope)

	if got := response.Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	if got := f.store.applied(envelope.ID)[0].Snapshot().OccurredAt.Format(time.RFC3339Nano); got != past {
		t.Errorf("OccurredAt = %s, want the device's time %s", got, past)
	}
}

// A device reusing a movement identifier under a new event is a client bug, and
// resending will not fix it. It is settled as rejected rather than left to
// retry forever.
func TestAReusedMovementIdentifierIsRejected(t *testing.T) {
	f := newFixture(t)

	reused := inventory.NewMovementID().String()
	first := f.envelope(1)
	first.Payload = stockPayload(movementLine{id: reused})
	f.push(t, first)

	second := f.envelope(2)
	second.Payload = stockPayload(movementLine{id: reused})
	response := f.push(t, second)

	result := response.Results[0]
	if result.Status != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", result.Status)
	}
	if !result.Settled() {
		t.Error("the device was told to retry an event that can never succeed")
	}
	if got := f.store.appliedTotal(); got != 1 {
		t.Errorf("the ledger holds %d movements, want 1", got)
	}
}

// An event type this build does not know is refused, and refused on the way in.
//
// This is the opposite of how an unknown *field* inside a payload is treated,
// and deliberately so. A device running ahead of the server must find out that
// its events are not landing, rather than being told "accepted" and believing
// its data arrived. The other half of the rule lives in domain/sync: a stored
// event of an unknown type is still relayed on the way out, so one row an older
// build accepted cannot fail the pull for every device.
func TestAnEventTypeThisBuildDoesNotKnowIsRefused(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.Type = "LOYALTY_POINTS_AWARDED"
	envelope.Payload = json.RawMessage(`{"points":40}`)

	result := f.push(t, envelope).Results[0]
	if result.Status != syncing.Rejected {
		t.Fatalf("Status = %q, want rejected", result.Status)
	}
	if !result.Settled() {
		t.Error("the device was left retrying an event the server will never take")
	}
	if f.store.appliedTotal() != 0 {
		t.Error("an event this build cannot apply changed something")
	}
	// It is kept as a rejection rather than dropped, so an operator can see
	// which devices are ahead of the server.
	if f.store.rejectedCount() != 1 {
		t.Error("the refusal was not recorded")
	}
}

// The unit cost a device sends is kept as XAF whole francs, never as a float
// (§46, ADR-010).
func TestAUnitCostIsKeptInWholeFrancs(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.Payload = json.RawMessage(`{"movements":[{"id":"` + inventory.NewMovementID().String() +
		`","product_id":"` + products.NewID().String() +
		`","type":"PURCHASE","quantity":5000,"unit_cost_minor":2500,` +
		`"reference_kind":"PURCHASE","reference_id":"` + id.New().String() + `"}]}`)

	f.push(t, envelope)

	applied := f.store.applied(envelope.ID)
	if len(applied) != 1 {
		t.Fatalf("the event moved %d movements, want 1", len(applied))
	}
	cost := applied[0].Snapshot().UnitCost
	if cost.Amount() != 2500 || cost.Currency() != money.XAF {
		t.Errorf("UnitCost = %s, want 2500 XAF", cost)
	}
}

// productPayload builds a PRODUCT_SAVED body.
func productPayload(id products.ID, price int64, updatedAt string) json.RawMessage {
	encoded, err := json.Marshal(map[string]any{
		"product": map[string]any{
			"id":                  id.String(),
			"name":                "Riz parfumé 5kg",
			"unit":                "sac",
			"selling_price_minor": price,
			"created_at":          "2026-08-01T08:00:00Z",
			"updated_at":          updatedAt,
		},
	})
	if err != nil {
		panic(err)
	}
	return encoded
}

func (f *fixture) productEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.ProductSaved
	envelope.Payload = payload
	return envelope
}

// A product event is applied, not merely filed, the same as a stock event.
func TestAnAcceptedProductEventSavesTheProduct(t *testing.T) {
	f := newFixture(t)

	productID := products.NewID()
	envelope := f.productEvent(1, productPayload(productID, 6_500, "2026-08-14T09:00:00Z"))

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	saved := f.store.product(productID)
	if saved == nil {
		t.Fatal("the product was not saved")
	}
	snapshot := saved.Snapshot()
	if snapshot.BusinessID != f.tenant {
		t.Errorf("the product landed in %s, want %s", snapshot.BusinessID, f.tenant)
	}
	// The editing device comes from the envelope, which is what breaks a tie
	// between two edits stamped the same instant (ADR-015).
	if snapshot.UpdatedByDevice != f.till {
		t.Errorf("UpdatedByDevice = %s, want the pushing device %s", snapshot.UpdatedByDevice, f.till)
	}
	if snapshot.SellingPrice.Amount() != 6_500 {
		t.Errorf("price = %s, want 6500 XAF", snapshot.SellingPrice)
	}
}

// The device's own edit time is kept, not the moment the server heard. An edit
// made offline on Monday and synced on Friday is a Monday edit.
func TestAProductKeepsTheDevicesEditTime(t *testing.T) {
	f := newFixture(t)

	productID := products.NewID()
	edited := "2026-08-05T11:00:00Z"
	f.push(t, f.productEvent(1, productPayload(productID, 6_500, edited)))

	saved := f.store.product(productID)
	if saved == nil {
		t.Fatal("the product was not saved")
	}
	if got := saved.Snapshot().UpdatedAt.Format(time.RFC3339); got != edited {
		t.Errorf("UpdatedAt = %s, want the device's %s", got, edited)
	}
}

// A newer edit wins, whichever order the two arrive in.
func TestTheNewerProductEditWinsEitherWay(t *testing.T) {
	earlier, later := "2026-08-14T09:00:00Z", "2026-08-14T17:00:00Z"

	for _, testCase := range []struct{ name, first, second string }{
		{"newer last", earlier, later},
		{"newer first", later, earlier},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			productID := products.NewID()

			price := map[string]int64{earlier: 6_500, later: 7_000}
			f.push(t, f.productEvent(1, productPayload(productID, price[testCase.first], testCase.first)))
			f.push(t, f.productEvent(2, productPayload(productID, price[testCase.second], testCase.second)))

			saved := f.store.product(productID)
			if saved == nil {
				t.Fatal("the product was not saved")
			}
			if got := saved.Snapshot().SellingPrice.Amount(); got != 7_000 {
				t.Errorf("price = %d, want the newer 7000", got)
			}
		})
	}
}

// A payload the server cannot read is rejected on its own.
func TestABadProductPayloadIsRejected(t *testing.T) {
	productID := products.NewID()

	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{"no product", json.RawMessage(`{}`)},
		{"no identifier", json.RawMessage(`{"product":{"name":"Riz","unit":"sac","selling_price_minor":1,"created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`)},
		{"no name", json.RawMessage(`{"product":{"id":"` + productID.String() + `","unit":"sac","selling_price_minor":1,"created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`)},
		{"a negative price", json.RawMessage(`{"product":{"id":"` + productID.String() + `","name":"Riz","unit":"sac","selling_price_minor":-1,"created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`)},
		{"no edit time", json.RawMessage(`{"product":{"id":"` + productID.String() + `","name":"Riz","unit":"sac","selling_price_minor":1,"created_at":"2026-08-01T08:00:00Z"}}`)},
		{"an unreadable edit time", json.RawMessage(`{"product":{"id":"` + productID.String() + `","name":"Riz","unit":"sac","selling_price_minor":1,"created_at":"2026-08-01T08:00:00Z","updated_at":"last Tuesday"}}`)},
		{"edited before it existed", json.RawMessage(`{"product":{"id":"` + productID.String() + `","name":"Riz","unit":"sac","selling_price_minor":1,"created_at":"2026-08-14T09:00:00Z","updated_at":"2026-08-01T08:00:00Z"}}`)},
		{"a field from a newer client", json.RawMessage(`{"product":{"id":"` + productID.String() + `","name":"Riz","unit":"sac","selling_price_minor":1,"created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z","colour":"red"}}`)},
		{"a business of its own choosing", json.RawMessage(`{"product":{"id":"` + productID.String() + `","business_id":"` + business.NewID().String() + `","name":"Riz","unit":"sac","selling_price_minor":1,"created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)

			response := f.push(t, f.productEvent(1, testCase.payload))

			if got := response.Results[0].Status; got != syncing.Rejected {
				t.Errorf("Status = %q, want rejected", got)
			}
			if f.store.product(productID) != nil {
				t.Error("a product was saved from a payload the server could not read")
			}
		})
	}
}

// Every optional field survives the trip, including the ones a shopkeeper fills
// in later (§6).
func TestAProductCarriesItsOptionalFields(t *testing.T) {
	f := newFixture(t)

	productID, categoryID := products.NewID(), products.NewCategoryID()
	payload, err := json.Marshal(map[string]any{
		"product": map[string]any{
			"id":                    productID.String(),
			"category_id":           categoryID.String(),
			"name":                  "Riz parfumé 5kg",
			"sku":                   "RIZ-5KG",
			"barcode":               "6001234567890",
			"description":           "Riz parfumé importé.",
			"brand":                 "Uncle Sam",
			"unit":                  "kg",
			"divisible":             true,
			"purchase_price_minor":  5_000,
			"selling_price_minor":   6_500,
			"tax_rate_basis_points": 1_925,
			"minimum_stock":         10_000,
			"active":                false,
			"created_at":            "2026-08-01T08:00:00Z",
			"updated_at":            "2026-08-14T09:00:00Z",
		},
	})
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}

	f.push(t, f.productEvent(1, payload))

	saved := f.store.product(productID)
	if saved == nil {
		t.Fatal("the product was not saved")
	}
	snapshot := saved.Snapshot()
	if snapshot.CategoryID != categoryID {
		t.Errorf("CategoryID = %s, want %s", snapshot.CategoryID, categoryID)
	}
	if snapshot.SKU != "RIZ-5KG" || snapshot.Barcode != "6001234567890" {
		t.Errorf("codes = %q/%q", snapshot.SKU, snapshot.Barcode)
	}
	if !snapshot.Divisible {
		t.Error("Divisible was lost")
	}
	if snapshot.PurchasePrice.Amount() != 5_000 {
		t.Errorf("PurchasePrice = %s, want 5000 XAF", snapshot.PurchasePrice)
	}
	if snapshot.TaxRateBasisPoints != 1_925 {
		t.Errorf("TaxRateBasisPoints = %d, want 1925", snapshot.TaxRateBasisPoints)
	}
	if snapshot.MinimumStock.Thousandths() != 10_000 {
		t.Errorf("MinimumStock = %s, want 10 units", snapshot.MinimumStock)
	}
	// Absent means active, but an explicit false means archived.
	if snapshot.Active {
		t.Error("an archived product came back active")
	}
}

// A category identifier that is not one is the event's problem, not the batch's.
func TestAProductWithAnUnreadableCategoryIsRejected(t *testing.T) {
	f := newFixture(t)

	productID := products.NewID()
	payload := json.RawMessage(`{"product":{"id":"` + productID.String() +
		`","category_id":"not-a-category","name":"Riz","unit":"sac",` +
		`"selling_price_minor":1,"created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`)

	if got := f.push(t, f.productEvent(1, payload)).Results[0].Status; got != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", got)
	}
}

// A purchase price below zero is refused. A business cannot have paid less than
// nothing, and money is checked rather than trusted (ADR-010).
func TestAProductWithANegativePurchasePriceIsRejected(t *testing.T) {
	f := newFixture(t)

	productID := products.NewID()
	payload := json.RawMessage(`{"product":{"id":"` + productID.String() +
		`","name":"Riz","unit":"sac","selling_price_minor":100,"purchase_price_minor":-5,` +
		`"created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`)

	if got := f.push(t, f.productEvent(1, payload)).Results[0].Status; got != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", got)
	}
}
