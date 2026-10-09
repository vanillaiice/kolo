package syncing_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// paymentPayload builds a CUSTOMER_PAYMENT body.
func paymentPayload(
	transactionID customers.TransactionID, customerID customers.ID, amountMinor int64,
	extra ...func(map[string]any),
) json.RawMessage {
	payment := map[string]any{
		"id":           transactionID.String(),
		"customer_id":  customerID.String(),
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

func (f *fixture) paymentEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.CustomerPaid
	envelope.Payload = payload
	return envelope
}

// §13's other half: a customer settling their tab. The payment is against the
// account, not against any one sale, which is what lets a shopkeeper take 5,000
// off a debt built from a fortnight of small buys.
func TestACustomerPaymentReducesWhatTheyOwe(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	transactionID := customers.NewTransactionID()
	envelope := f.paymentEvent(1, paymentPayload(transactionID, customerID, 10_000))

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	ledger := f.store.creditOf(customerID)
	if len(ledger) != 1 {
		t.Fatalf("the ledger holds %d entries, want the payment", len(ledger))
	}
	entry := ledger[0]
	if entry.Type() != customers.Payment {
		t.Errorf("type = %s, want PAYMENT", entry.Type())
	}
	// Negative in the ledger, though the device sent what was handed over. The
	// sign is the server's to apply, so a device cannot record a payment that
	// increases a debt.
	if got := entry.Amount().Amount(); got != -10_000 {
		t.Errorf("amount = %d, want -10000", got)
	}
	if _, named := entry.Account(); !named {
		t.Error("a payment landed with no account to have gone into")
	}
}

// A till resending its backlog must not credit the customer twice.
func TestAReplayedPaymentIsNotCountedTwice(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	envelope := f.paymentEvent(1, paymentPayload(customers.NewTransactionID(), customerID, 10_000))

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	if got := f.push(t, envelope).Results[0].Status; got != syncing.Duplicate {
		t.Fatalf("Status = %q, want duplicate", got)
	}

	if entries := f.store.creditOf(customerID); len(entries) != 1 {
		t.Errorf("the ledger holds %d entries after a resend, want 1", len(entries))
	}
}

// Overpaying leaves a customer in credit rather than being refused. It is money
// the shopkeeper has already taken, and clamping it would quietly lose theirs.
func TestAPaymentLargerThanTheDebtIsAccepted(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	envelope := f.paymentEvent(1, paymentPayload(customers.NewTransactionID(), customerID, 999_999))

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Errorf("Status = %q, want accepted", got)
	}
}

// A payment carries a note, which is what makes a statement readable months
// later (§39).
func TestAPaymentKeepsItsNote(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	payload := paymentPayload(customers.NewTransactionID(), customerID, 10_000,
		func(payment map[string]any) { payment["note"] = "payé par son fils" })

	if got := f.push(t, f.paymentEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	ledger := f.store.creditOf(customerID)
	if len(ledger) != 1 || ledger[0].Reason() != "payé par son fils" {
		t.Errorf("the note did not survive: %v", ledger)
	}
}

func TestABadPaymentPayloadIsRejected(t *testing.T) {
	customerID := customers.NewID()
	transactionID := customers.NewTransactionID()

	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{
			"no identifier",
			paymentPayload(transactionID, customerID, 10_000,
				func(payment map[string]any) { payment["id"] = "" }),
		},
		{
			"no customer",
			paymentPayload(transactionID, customerID, 10_000,
				func(payment map[string]any) { payment["customer_id"] = "" }),
		},
		{
			"no account for the money to go into",
			paymentPayload(transactionID, customerID, 10_000,
				func(payment map[string]any) { payment["account_id"] = "" }),
		},
		{
			"a payment of nothing",
			paymentPayload(transactionID, customerID, 0),
		},
		{
			// The sign is the server's to apply. A device sending a negative
			// amount is describing something this event cannot mean.
			"a payment of less than nothing",
			paymentPayload(transactionID, customerID, -10_000),
		},
		{
			"a payment from the future",
			paymentPayload(transactionID, customerID, 10_000,
				func(payment map[string]any) { payment["occurred_at"] = "2099-01-01T00:00:00Z" }),
		},
		{
			"an unreadable moment",
			paymentPayload(transactionID, customerID, 10_000,
				func(payment map[string]any) { payment["occurred_at"] = "sometime on Tuesday" }),
		},
		{
			"a field this build does not know",
			paymentPayload(transactionID, customerID, 10_000,
				func(payment map[string]any) { payment["balance_after_minor"] = 5_000 }),
		},
		{
			"not an object at all",
			json.RawMessage(`{"payment":"10000"}`),
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			response := f.push(t, f.paymentEvent(1, testCase.payload))
			if got := response.Results[0].Status; got != syncing.Rejected {
				t.Errorf("Status = %q, want rejected", got)
			}
			if response.Results[0].Reason == "" {
				t.Error("a rejection said nothing about why")
			}
		})
	}
}

// A payment made on a till that was offline lands on the day it happened, not
// the day the server heard about it — which is what keeps last month's
// statement stable once the tills catch up.
func TestABacklogOfPaymentsKeepsItsOwnDates(t *testing.T) {
	f := newFixture(t)

	customerID := customers.NewID()
	paid := "2026-08-10T14:00:00Z"
	payload := paymentPayload(customers.NewTransactionID(), customerID, 10_000,
		func(payment map[string]any) { payment["occurred_at"] = paid })

	if got := f.push(t, f.paymentEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	ledger := f.store.creditOf(customerID)
	if len(ledger) != 1 {
		t.Fatalf("the ledger holds %d entries, want the payment", len(ledger))
	}
	if got := ledger[0].OccurredAt().Format("2006-01-02T15:04:05Z07:00"); got != paid {
		t.Errorf("OccurredAt = %s, want the device's %s", got, paid)
	}
}
