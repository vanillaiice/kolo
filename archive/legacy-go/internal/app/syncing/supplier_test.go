package syncing_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// supplierPayload builds a SUPPLIER_SAVED body.
func supplierPayload(
	id suppliers.ID, name, updatedAt string, extra ...func(map[string]any),
) json.RawMessage {
	supplier := map[string]any{
		"id":         id.String(),
		"name":       name,
		"created_at": "2026-08-01T08:00:00Z",
		"updated_at": updatedAt,
	}
	for _, change := range extra {
		change(supplier)
	}

	encoded, err := json.Marshal(map[string]any{"supplier": supplier})
	if err != nil {
		panic(err)
	}
	return encoded
}

func (f *fixture) supplierEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.SupplierSaved
	envelope.Payload = payload
	return envelope
}

// §14: a wholesaler added on the owner's phone is on every till after the next
// sync, and the contact is the person a shopkeeper actually asks for.
func TestASupplierAddedOnOneDeviceReachesTheServer(t *testing.T) {
	f := newFixture(t)

	supplierID := suppliers.NewID()
	payload := supplierPayload(supplierID, "Grossiste Mokolo", "2026-08-14T09:00:00Z",
		func(s map[string]any) {
			s["phone"] = "+237677889900"
			s["address"] = "Marché Mokolo, Yaoundé"
			s["contact"] = "Mama Ngo"
			s["notes"] = "livre le mardi"
		})

	if got := f.push(t, f.supplierEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	saved := f.store.supplier(supplierID)
	if saved == nil {
		t.Fatal("the supplier was not saved")
	}
	if saved.Name() != "Grossiste Mokolo" {
		t.Errorf("Name = %q", saved.Name())
	}
	if number, ok := saved.Phone(); !ok || number.String() != "+237677889900" {
		t.Errorf("Phone = %v (%t)", number, ok)
	}
	if saved.Contact() != "Mama Ngo" {
		t.Errorf("Contact = %q", saved.Contact())
	}
	if saved.Notes() != "livre le mardi" {
		t.Errorf("Notes = %q", saved.Notes())
	}
	if saved.BusinessID() != f.tenant {
		t.Errorf("the supplier landed in %s, want %s", saved.BusinessID(), f.tenant)
	}
	// Taken from the envelope, never the payload: a device cannot nominate
	// itself the winner of a conflict by claiming to be another (ADR-008).
	if saved.UpdatedByDevice() != f.till {
		t.Errorf("UpdatedByDevice = %s, want the pushing device", saved.UpdatedByDevice())
	}
	if !saved.Active() {
		t.Error("a supplier arrives active unless the payload says otherwise")
	}
}

// ADR-015 over a supplier: the newer edit wins whichever order it arrives in,
// which is the property that lets a device settle a conflict with no network.
func TestTheNewerSupplierEditWinsEitherWay(t *testing.T) {
	earlier, later := "2026-08-14T09:00:00Z", "2026-08-14T17:00:00Z"

	for _, testCase := range []struct{ name, first, second string }{
		{"in order", earlier, later},
		{"out of order", later, earlier},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			supplierID := suppliers.NewID()

			names := map[string]string{earlier: "Grossiste Mokolo", later: "Grossiste Mokolo SARL"}
			f.push(t,
				f.supplierEvent(1, supplierPayload(supplierID, names[testCase.first], testCase.first)),
				f.supplierEvent(2, supplierPayload(supplierID, names[testCase.second], testCase.second)))

			saved := f.store.supplier(supplierID)
			if saved == nil {
				t.Fatal("the supplier was not saved")
			}
			if saved.Name() != names[later] {
				t.Errorf("Name = %q, want the later edit %q", saved.Name(), names[later])
			}
		})
	}
}

// A losing edit is discarded, not an error: treating it as a failure would make
// the device defer the event forever.
func TestALosingSupplierEditIsStillAccepted(t *testing.T) {
	f := newFixture(t)
	supplierID := suppliers.NewID()

	f.push(t, f.supplierEvent(1, supplierPayload(supplierID, "Grossiste Mokolo SARL", "2026-08-14T17:00:00Z")))
	response := f.push(t, f.supplierEvent(2, supplierPayload(supplierID, "Grossiste Mokolo", "2026-08-14T09:00:00Z")))

	if got := response.Results[0].Status; got != syncing.Accepted {
		t.Errorf("Status = %q, want accepted: a losing edit is not a failure", got)
	}
}

// The timestamp is the device's own, so an edit made offline on Monday and
// synced on Friday does not beat one made on Wednesday (ADR-015).
func TestASupplierEditKeepsTheDevicesOwnEditTime(t *testing.T) {
	f := newFixture(t)

	supplierID := suppliers.NewID()
	f.push(t, f.supplierEvent(1, supplierPayload(supplierID, "Grossiste Mokolo", "2026-08-10T09:00:00Z")))

	saved := f.store.supplier(supplierID)
	if saved == nil {
		t.Fatal("the supplier was not saved")
	}
	if got := saved.UpdatedAt().Format("2006-01-02T15:04:05Z07:00"); got != "2026-08-10T09:00:00Z" {
		t.Errorf("UpdatedAt = %s, want the device's edit time, not the server's", got)
	}
}

// A wholesaler the shop has stopped buying from stays in the books; the flag
// says so, and absent means active because a device that never sent the field
// is not saying they were dropped.
func TestASupplierCanBeMarkedNoLongerUsed(t *testing.T) {
	f := newFixture(t)

	supplierID := suppliers.NewID()
	payload := supplierPayload(supplierID, "Grossiste Mokolo", "2026-08-14T09:00:00Z",
		func(s map[string]any) { s["active"] = false })
	f.push(t, f.supplierEvent(1, payload))

	saved := f.store.supplier(supplierID)
	if saved == nil {
		t.Fatal("the supplier was not saved")
	}
	if saved.Active() {
		t.Error("a supplier the payload closed came back active")
	}
}

func TestABadSupplierPayloadIsRejected(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{"not JSON at all", json.RawMessage(`{`)},
		{"no identifier", supplierPayload(suppliers.ID{}, "Grossiste Mokolo", "2026-08-14T09:00:00Z")},
		{"an identifier that is not one", json.RawMessage(
			`{"supplier":{"id":"not-a-uuid","name":"X","created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-01T08:00:00Z"}}`)},
		{"no name", supplierPayload(suppliers.NewID(), "   ", "2026-08-14T09:00:00Z")},
		{"a name of invisible characters", supplierPayload(
			suppliers.NewID(), "Grossiste​Mokolo", "2026-08-14T09:00:00Z")},
		{"a name longer than one can be", supplierPayload(
			suppliers.NewID(), strings.Repeat("a", 500), "2026-08-14T09:00:00Z")},
		{"a number nobody could dial", supplierPayload(
			suppliers.NewID(), "Grossiste Mokolo", "2026-08-14T09:00:00Z",
			func(s map[string]any) { s["phone"] = "+23" })},
		{"no creation time", json.RawMessage(
			`{"supplier":{"id":"` + suppliers.NewID().String() + `","name":"X","updated_at":"2026-08-01T08:00:00Z"}}`)},
		{"no edit time", json.RawMessage(
			`{"supplier":{"id":"` + suppliers.NewID().String() + `","name":"X","created_at":"2026-08-01T08:00:00Z"}}`)},
		{"an edit time that is not a time", supplierPayload(
			suppliers.NewID(), "Grossiste Mokolo", "the day before yesterday")},
		{"edited before it was created", supplierPayload(
			suppliers.NewID(), "Grossiste Mokolo", "2026-07-01T08:00:00Z")},
		// A field this build does not know might be the very thing that changes
		// what the record means, so it is refused rather than dropped.
		{"a field from a newer client", supplierPayload(
			suppliers.NewID(), "Grossiste Mokolo", "2026-08-14T09:00:00Z",
			func(s map[string]any) { s["payment_terms_days"] = 30 })},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			result := f.push(t, f.supplierEvent(1, testCase.payload)).Results[0]

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

// supplierPaymentPayload builds a SUPPLIER_PAYMENT body.
func supplierPaymentPayload(
	id suppliers.TransactionID, supplierID suppliers.ID, amountMinor int64,
	extra ...func(map[string]any),
) json.RawMessage {
	payment := map[string]any{
		"id":           id.String(),
		"supplier_id":  supplierID.String(),
		"account_id":   finance.NewAccountID().String(),
		"amount_minor": amountMinor,
		"occurred_at":  occurredAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	for _, change := range extra {
		change(payment)
	}

	encoded, err := json.Marshal(map[string]any{"payment": payment})
	if err != nil {
		panic(err)
	}
	return encoded
}

func (f *fixture) supplierPaymentEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.SupplierPaid
	envelope.Payload = payload
	return envelope
}

// §16: settling a wholesaler's account stands on its own, and the wire carries
// what was handed over as a positive amount — the sign is the server's to apply,
// so a device cannot record a payment that increases a bill.
func TestSettlingAWholesalerIsApplied(t *testing.T) {
	f := newFixture(t)

	supplierID := suppliers.NewID()
	entryID := suppliers.NewTransactionID()
	payload := supplierPaymentPayload(entryID, supplierID, 50_000,
		func(p map[string]any) { p["note"] = "acompte sur la facture 118" })

	if got := f.push(t, f.supplierPaymentEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	owed := f.store.owedTo(supplierID)
	if len(owed) != 1 {
		t.Fatalf("recorded %d entries, want 1", len(owed))
	}
	entry := owed[0]
	if entry.ID() != entryID {
		t.Errorf("the entry is %s, want the identifier the device drew", entry.ID())
	}
	if entry.Type() != suppliers.Payment {
		t.Errorf("the entry is a %s, want PAYMENT", entry.Type())
	}
	if got := entry.Amount().Amount(); got != -50_000 {
		t.Errorf("amount = %d, want -50000: a payment reduces what is owed", got)
	}
	// A payment names where the money came from, and only a payment does: that
	// is what makes the drawer fall by what was handed over (§18).
	if _, named := entry.Account(); !named {
		t.Error("a payment that names no account is money no report can place")
	}
	if entry.Reason() != "acompte sur la facture 118" {
		t.Errorf("note = %q, want the one on the wire", entry.Reason())
	}
	// It names no delivery, because it is not about any one of them.
	if reference, named := entry.Reference(); named {
		t.Errorf("the payment names delivery %s, want none", reference)
	}
}

func TestABadSupplierPaymentIsRejected(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{"not JSON at all", json.RawMessage(`{`)},
		{"no entry identifier", supplierPaymentPayload(
			suppliers.TransactionID{}, suppliers.NewID(), 50_000)},
		{"a supplier that is not an identifier", supplierPaymentPayload(
			suppliers.NewTransactionID(), suppliers.NewID(), 50_000,
			func(p map[string]any) { p["supplier_id"] = "chez le grossiste" })},
		{"no account for the money to come from", supplierPaymentPayload(
			suppliers.NewTransactionID(), suppliers.NewID(), 50_000,
			func(p map[string]any) { p["account_id"] = "" })},
		{"a payment of nothing", supplierPaymentPayload(
			suppliers.NewTransactionID(), suppliers.NewID(), 0)},
		// Sent negative, it would be a payment that increases a bill.
		{"a payment of less than nothing", supplierPaymentPayload(
			suppliers.NewTransactionID(), suppliers.NewID(), -50_000)},
		{"a payment made in the future", supplierPaymentPayload(
			suppliers.NewTransactionID(), suppliers.NewID(), 50_000,
			func(p map[string]any) { p["occurred_at"] = "2027-01-01T00:00:00Z" })},
		{"a time that is not a time", supplierPaymentPayload(
			suppliers.NewTransactionID(), suppliers.NewID(), 50_000,
			func(p map[string]any) { p["occurred_at"] = "hier" })},
		{"a field from a newer client", supplierPaymentPayload(
			suppliers.NewTransactionID(), suppliers.NewID(), 50_000,
			func(p map[string]any) { p["cheque_number"] = "004512" })},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			result := f.push(t, f.supplierPaymentEvent(1, testCase.payload)).Results[0]

			if result.Status != syncing.Rejected {
				t.Fatalf("Status = %q, want rejected", result.Status)
			}
			if result.Reason == "" {
				t.Error("a rejection with nothing to say why")
			}
		})
	}
}

// Two devices each taking a payment is two payments, and both stand — a ledger
// is not resolved the way a name is (§16, ADR-015).
func TestTwoDevicesSettlingTheSameWholesalerBothStand(t *testing.T) {
	f := newFixture(t)

	supplierID := suppliers.NewID()
	f.push(t,
		f.supplierPaymentEvent(1, supplierPaymentPayload(
			suppliers.NewTransactionID(), supplierID, 30_000)),
		f.supplierPaymentEvent(2, supplierPaymentPayload(
			suppliers.NewTransactionID(), supplierID, 20_000)))

	owed := f.store.owedTo(supplierID)
	if len(owed) != 2 {
		t.Fatalf("recorded %d entries, want both payments", len(owed))
	}
	total := int64(0)
	for _, entry := range owed {
		total += entry.Amount().Amount()
	}
	if total != -50_000 {
		t.Errorf("the payments come to %d, want -50000", total)
	}
}

// A replay is a success and applies nothing twice: a device on a bad link
// cannot tell whether its push arrived, so it pushes again (§27).
func TestReplayingASupplierEditIsADuplicate(t *testing.T) {
	f := newFixture(t)

	event := f.supplierEvent(1, supplierPayload(
		suppliers.NewID(), "Grossiste Mokolo", "2026-08-14T09:00:00Z"))

	if got := f.push(t, event).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("first push: Status = %q, want accepted", got)
	}
	if got := f.push(t, event).Results[0].Status; got != syncing.Duplicate {
		t.Errorf("second push: Status = %q, want duplicate", got)
	}
}
