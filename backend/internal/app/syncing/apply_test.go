package syncing_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
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

// An event type this build cannot apply is still recorded and still passed on.
// Refusing it would strand a device on a newer client with a backlog it can
// never clear.
func TestAnEventTypeThisBuildCannotApplyIsStillKept(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.Type = sync.SaleCompleted
	envelope.Payload = json.RawMessage(`{"total_minor":15000}`)

	response := f.push(t, envelope)

	if got := response.Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	if f.store.recorded() != 1 {
		t.Error("the event was not recorded")
	}
	if f.store.appliedTotal() != 0 {
		t.Error("an event this build cannot apply moved stock anyway")
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
