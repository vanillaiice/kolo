package syncing_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// cashPayload builds a CASH_MOVED body.
func cashPayload(movements ...map[string]any) json.RawMessage {
	encoded, err := json.Marshal(map[string]any{"movements": movements})
	if err != nil {
		panic(err)
	}
	return encoded
}

func aCashMovement(
	id finance.MovementID, account finance.AccountID, kind string, amountMinor int64,
	extra ...func(map[string]any),
) map[string]any {
	movement := map[string]any{
		"id":           id.String(),
		"account_id":   account.String(),
		"type":         kind,
		"amount_minor": amountMinor,
		"occurred_at":  occurredAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	for _, change := range extra {
		change(movement)
	}
	return movement
}

func (f *fixture) cashEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.CashMoved
	envelope.Payload = payload
	return envelope
}

// The float put into a drawer at opening, from the till that opened it.
func TestCashPutIntoAnAccountIsApplied(t *testing.T) {
	f := newFixture(t)

	account := finance.NewAccountID()
	movementID := finance.NewMovementID()
	payload := cashPayload(aCashMovement(movementID, account, "OPENING_BALANCE", 50_000))

	if got := f.push(t, f.cashEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	moved := f.store.cashOf(account)
	if len(moved) != 1 {
		t.Fatalf("the account holds %d movements, want the float", len(moved))
	}
	if moved[0].ID() != movementID {
		t.Errorf("ID = %s, want the identifier the device drew", moved[0].ID())
	}
	if got := moved[0].Amount().Amount(); got != 50_000 {
		t.Errorf("amount = %d, want 50000", got)
	}
	if moved[0].BusinessID() != f.tenant {
		t.Errorf("the movement landed in %s, want %s", moved[0].BusinessID(), f.tenant)
	}
}

// A transfer is two movements in one event, so they land together: half a
// transfer is money genuinely lost.
func TestATransferTravelsAsOneEvent(t *testing.T) {
	f := newFixture(t)

	till, wallet := finance.NewAccountID(), finance.NewAccountID()
	payload := cashPayload(
		aCashMovement(finance.NewMovementID(), till, "TRANSFER_OUT", -20_000,
			func(m map[string]any) { m["counterpart_id"] = wallet.String() }),
		aCashMovement(finance.NewMovementID(), wallet, "TRANSFER_IN", 20_000,
			func(m map[string]any) { m["counterpart_id"] = till.String() }),
	)

	if got := f.push(t, f.cashEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	if len(f.store.cashOf(till)) != 1 || len(f.store.cashOf(wallet)) != 1 {
		t.Errorf("the transfer landed as %d and %d movements",
			len(f.store.cashOf(till)), len(f.store.cashOf(wallet)))
	}
}

// A till resending its backlog must not empty the drawer twice.
func TestAReplayedCashEventMovesNothingTwice(t *testing.T) {
	f := newFixture(t)

	account := finance.NewAccountID()
	payload := cashPayload(aCashMovement(finance.NewMovementID(), account, "CASH_OUT", -20_000,
		func(m map[string]any) { m["reason"] = "porté à la banque" }))
	envelope := f.cashEvent(1, payload)

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	if got := f.push(t, envelope).Results[0].Status; got != syncing.Duplicate {
		t.Fatalf("Status = %q, want duplicate", got)
	}
	if moved := f.store.cashOf(account); len(moved) != 1 {
		t.Errorf("the account holds %d movements after a resend, want 1", len(moved))
	}
}

func TestABadCashPayloadIsRejected(t *testing.T) {
	account, other := finance.NewAccountID(), finance.NewAccountID()
	movementID := finance.NewMovementID()

	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{"no movements at all", cashPayload()},
		{
			"no identifier",
			cashPayload(aCashMovement(movementID, account, "CASH_IN", 5_000,
				func(m map[string]any) { m["id"] = "" })),
		},
		{
			"no account",
			cashPayload(aCashMovement(movementID, account, "CASH_IN", 5_000,
				func(m map[string]any) { m["account_id"] = "" })),
		},
		{
			"a type this build does not know",
			cashPayload(aCashMovement(movementID, account, "LOAN", 5_000)),
		},
		{
			// A withdrawal that read as a deposit would make a drawer look full
			// that is empty, and only a count would ever find it.
			"a withdrawal with the wrong sign",
			cashPayload(aCashMovement(movementID, account, "CASH_OUT", 5_000,
				func(m map[string]any) { m["reason"] = "porté à la banque" })),
		},
		{
			"a withdrawal with no reason",
			cashPayload(aCashMovement(movementID, account, "CASH_OUT", -5_000)),
		},
		{"a movement of nothing", cashPayload(aCashMovement(movementID, account, "CASH_IN", 0))},
		{
			"half a transfer",
			cashPayload(aCashMovement(movementID, account, "TRANSFER_OUT", -5_000)),
		},
		{
			"a transfer to the same account",
			cashPayload(aCashMovement(movementID, account, "TRANSFER_OUT", -5_000,
				func(m map[string]any) { m["counterpart_id"] = account.String() })),
		},
		{
			"a counterpart on something that is not a transfer",
			cashPayload(aCashMovement(movementID, account, "CASH_IN", 5_000,
				func(m map[string]any) { m["counterpart_id"] = other.String() })),
		},
		{
			"money that moved in the future",
			cashPayload(aCashMovement(movementID, account, "CASH_IN", 5_000,
				func(m map[string]any) { m["occurred_at"] = "2099-01-01T00:00:00Z" })),
		},
		{
			"an unreadable moment",
			cashPayload(aCashMovement(movementID, account, "CASH_IN", 5_000,
				func(m map[string]any) { m["occurred_at"] = "sometime on Tuesday" })),
		},
		{
			"a field this build does not know",
			cashPayload(aCashMovement(movementID, account, "CASH_IN", 5_000,
				func(m map[string]any) { m["balance_after_minor"] = 50_000 })),
		},
		{"not a list at all", json.RawMessage(`{"movements":{"id":"one"}}`)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			response := f.push(t, f.cashEvent(1, testCase.payload))
			if got := response.Results[0].Status; got != syncing.Rejected {
				t.Errorf("Status = %q, want rejected", got)
			}
			if response.Results[0].Reason == "" {
				t.Error("a rejection said nothing about why")
			}
		})
	}
}

// Money moved on a till that was offline lands on the day it moved, which is
// what keeps yesterday's cash report stable once the tills catch up.
func TestABacklogOfCashKeepsItsOwnDates(t *testing.T) {
	f := newFixture(t)

	account := finance.NewAccountID()
	moved := "2026-08-10T14:00:00Z"
	payload := cashPayload(aCashMovement(finance.NewMovementID(), account, "CASH_IN", 5_000,
		func(m map[string]any) { m["occurred_at"] = moved }))

	if got := f.push(t, f.cashEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	stored := f.store.cashOf(account)
	if len(stored) != 1 {
		t.Fatalf("the account holds %d movements", len(stored))
	}
	if got := stored[0].OccurredAt().Format("2006-01-02T15:04:05Z07:00"); got != moved {
		t.Errorf("OccurredAt = %s, want the device's %s", got, moved)
	}
}
