package syncing_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// customerPayload builds a CUSTOMER_SAVED body.
func customerPayload(id customers.ID, name, updatedAt string, extra ...func(map[string]any)) json.RawMessage {
	customer := map[string]any{
		"id":         id.String(),
		"name":       name,
		"created_at": "2026-08-01T08:00:00Z",
		"updated_at": updatedAt,
	}
	for _, change := range extra {
		change(customer)
	}

	encoded, err := json.Marshal(map[string]any{"customer": customer})
	if err != nil {
		panic(err)
	}
	return encoded
}

func (f *fixture) customerEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.CustomerSaved
	envelope.Payload = payload
	return envelope
}

// A customer written on one till reaches the server, which is what makes a
// credit sale from a second till possible at all.
func TestAnAcceptedCustomerEventSavesTheCustomer(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	envelope := f.customerEvent(1, customerPayload(customerID, "Jean Mbarga", "2026-08-14T09:00:00Z"))

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	saved := f.store.customer(customerID)
	if saved == nil {
		t.Fatal("the customer was not saved")
	}
	snapshot := saved.Snapshot()
	if snapshot.BusinessID != f.tenant {
		t.Errorf("the customer landed in %s, want %s", snapshot.BusinessID, f.tenant)
	}
	if snapshot.Name != "Jean Mbarga" {
		t.Errorf("Name = %q", snapshot.Name)
	}
	// The editing device comes from the envelope, so a device cannot nominate
	// itself the winner of a tie by claiming to be another (ADR-015).
	if snapshot.UpdatedByDevice != f.till {
		t.Errorf("UpdatedByDevice = %s, want the pushing device %s", snapshot.UpdatedByDevice, f.till)
	}
	if !snapshot.Active {
		t.Error("a customer arrived inactive without saying so")
	}
}

// The device's own edit time is kept, not the moment the server heard: an edit
// made offline on Monday and synced on Friday is a Monday edit.
func TestACustomerKeepsTheDevicesEditTime(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	edited := "2026-08-05T11:00:00Z"
	f.push(t, f.customerEvent(1, customerPayload(customerID, "Jean Mbarga", edited)))

	saved := f.store.customer(customerID)
	if saved == nil {
		t.Fatal("the customer was not saved")
	}
	if got := saved.UpdatedAt().Format(time.RFC3339); got != edited {
		t.Errorf("UpdatedAt = %s, want the device's %s", got, edited)
	}
}

// A newer edit wins whichever order the two arrive in, which is the property
// that keeps two devices from settling on different answers (ADR-015).
func TestTheNewerCustomerEditWinsEitherWay(t *testing.T) {
	earlier, later := "2026-08-14T09:00:00Z", "2026-08-14T17:00:00Z"

	for _, testCase := range []struct{ name, first, second string }{
		{"newer last", earlier, later},
		{"newer first", later, earlier},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			customerID := customers.NewID()
			name := map[string]string{earlier: "Jean Mbarga", later: "Jean-Paul Mbarga"}

			f.push(t, f.customerEvent(1, customerPayload(customerID, name[testCase.first], testCase.first)))
			f.push(t, f.customerEvent(2, customerPayload(customerID, name[testCase.second], testCase.second)))

			saved := f.store.customer(customerID)
			if saved == nil {
				t.Fatal("the customer was not saved")
			}
			if saved.Name() != "Jean-Paul Mbarga" {
				t.Errorf("Name = %q, want the newer edit", saved.Name())
			}
		})
	}
}

// Everything optional a customer can carry survives the wire (§12).
func TestACustomerCarriesItsOptionalFields(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	limit := int64(50_000)
	inactive := false
	payload := customerPayload(customerID, "Jean Mbarga", "2026-08-14T09:00:00Z",
		func(customer map[string]any) {
			customer["phone"] = "+237699123456"
			customer["address"] = "Carrefour Nsam, Yaoundé"
			customer["notes"] = "paie le vendredi"
			customer["credit_limit_minor"] = limit
			customer["active"] = inactive
		})

	if got := f.push(t, f.customerEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	saved := f.store.customer(customerID)
	if saved == nil {
		t.Fatal("the customer was not saved")
	}
	number, given := saved.Phone()
	if !given || number.String() != "+237699123456" {
		t.Errorf("Phone = %s", number)
	}
	if saved.Address() == "" || saved.Notes() == "" {
		t.Errorf("address %q and notes %q, want both kept", saved.Address(), saved.Notes())
	}
	stored, set := saved.CreditLimit()
	if !set || stored.Amount() != limit {
		t.Errorf("CreditLimit = %s, want %d", stored, limit)
	}
	if saved.Active() {
		t.Error("a customer sent as closed came back open")
	}
}

// A number typed the local way on one device has to match the same number typed
// internationally on another, which is what normalising to E.164 is for
// (ADR-012).
func TestACustomersNumberIsNormalised(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	payload := customerPayload(customerID, "Jean Mbarga", "2026-08-14T09:00:00Z",
		func(customer map[string]any) { customer["phone"] = "6 99 12 34 56" })

	if got := f.push(t, f.customerEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	saved := f.store.customer(customerID)
	if saved == nil {
		t.Fatal("the customer was not saved")
	}
	if number, _ := saved.Phone(); number.String() != "+237699123456" {
		t.Errorf("Phone = %s, want the E.164 form", number)
	}
}

// No limit and a limit of zero are different answers, and the wire has to keep
// them apart: absent means the shopkeeper has not decided, zero means this
// customer may not have credit.
func TestALimitOfZeroIsNotTheSameAsNoLimitOnTheWire(t *testing.T) {
	f := newFixture(t)

	cutOff := customers.NewID()
	zero := int64(0)
	f.push(t, f.customerEvent(1, customerPayload(cutOff, "Jean Mbarga", "2026-08-14T09:00:00Z",
		func(customer map[string]any) { customer["credit_limit_minor"] = zero })))

	undecided := customers.NewID()
	f.push(t, f.customerEvent(2, customerPayload(undecided, "Alice Ngo", "2026-08-14T09:00:00Z")))

	saved := f.store.customer(cutOff)
	if saved == nil {
		t.Fatal("the customer was not saved")
	}
	if limit, set := saved.CreditLimit(); !set || !limit.IsZero() {
		t.Errorf("a limit of zero arrived as %s (set: %t)", limit, set)
	}

	other := f.store.customer(undecided)
	if other == nil {
		t.Fatal("the second customer was not saved")
	}
	if limit, set := other.CreditLimit(); set {
		t.Errorf("no limit arrived as %s", limit)
	}
}

// A payload the server cannot use is rejected on its own, and says why. The
// unknown field matters most: ignoring it could half-apply a fact and report
// success.
func TestABadCustomerPayloadIsRejected(t *testing.T) {
	customerID := customers.NewID()

	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{
			"no identifier",
			json.RawMessage(`{"customer":{"name":"Jean","created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`),
		},
		{
			"no name",
			customerPayload(customerID, "", "2026-08-14T09:00:00Z"),
		},
		{
			"no updated_at",
			customerPayload(customerID, "Jean Mbarga", ""),
		},
		{
			"updated before created",
			customerPayload(customerID, "Jean Mbarga", "2026-07-01T08:00:00Z"),
		},
		{
			"an unreadable moment",
			customerPayload(customerID, "Jean Mbarga", "sometime on Tuesday"),
		},
		{
			"a number nobody could dial",
			customerPayload(customerID, "Jean Mbarga", "2026-08-14T09:00:00Z",
				func(customer map[string]any) { customer["phone"] = "+23" }),
		},
		{
			"a negative credit limit",
			customerPayload(customerID, "Jean Mbarga", "2026-08-14T09:00:00Z",
				func(customer map[string]any) { customer["credit_limit_minor"] = int64(-1) }),
		},
		{
			"a field this build does not know",
			customerPayload(customerID, "Jean Mbarga", "2026-08-14T09:00:00Z",
				func(customer map[string]any) { customer["balance_minor"] = 25_000 }),
		},
		{
			"not an object at all",
			json.RawMessage(`{"customer":"Jean Mbarga"}`),
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			response := f.push(t, f.customerEvent(1, testCase.payload))
			if got := response.Results[0].Status; got != syncing.Rejected {
				t.Errorf("Status = %q, want rejected", got)
			}
			if response.Results[0].Reason == "" {
				t.Error("a rejection said nothing about why")
			}
		})
	}
}

// A device cannot write a customer into another tenant by saying so in a
// payload: the business comes from the envelope, which was checked against the
// caller's scope (ADR-008).
func TestACustomerLandsInTheCallersBusiness(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	f.push(t, f.customerEvent(1, customerPayload(customerID, "Jean Mbarga", "2026-08-14T09:00:00Z")))

	saved := f.store.customer(customerID)
	if saved == nil {
		t.Fatal("the customer was not saved")
	}
	if saved.BusinessID() != f.tenant {
		t.Errorf("the customer landed in %s, want %s", saved.BusinessID(), f.tenant)
	}
}
