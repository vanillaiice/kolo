package syncing_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

// accountPayload builds an ACCOUNT_SAVED body.
func accountPayload(
	id finance.AccountID, name, kind, updatedAt string, extra ...func(map[string]any),
) json.RawMessage {
	account := map[string]any{
		"id":         id.String(),
		"name":       name,
		"kind":       kind,
		"created_at": "2026-08-01T08:00:00Z",
		"updated_at": updatedAt,
	}
	for _, change := range extra {
		change(account)
	}

	encoded, err := json.Marshal(map[string]any{"account": account})
	if err != nil {
		panic(err)
	}
	return encoded
}

func (f *fixture) accountEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.AccountSaved
	envelope.Payload = payload
	return envelope
}

// §10, made concrete: the shopkeeper opens an Orange Money account on their
// phone and every till has it after the next sync. A row, not a release.
func TestAWalletOpenedOnOneDeviceReachesTheServer(t *testing.T) {
	f := newFixture(t)

	accountID := finance.NewAccountID()
	payload := accountPayload(accountID, "Orange Money", "MOBILE_MONEY", "2026-08-14T09:00:00Z",
		func(account map[string]any) { account["number"] = "+237699000000" })

	if got := f.push(t, f.accountEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	saved := f.store.account(accountID)
	if saved == nil {
		t.Fatal("the account was not saved")
	}
	if saved.Name() != "Orange Money" || saved.Kind() != finance.MobileMoney {
		t.Errorf("saved %s of kind %s", saved.Name(), saved.Kind())
	}
	if saved.Number() != "+237699000000" {
		t.Errorf("Number = %q", saved.Number())
	}
	if saved.BusinessID() != f.tenant {
		t.Errorf("the account landed in %s, want %s", saved.BusinessID(), f.tenant)
	}
	// Not on the wire, because everything is XAF (§46).
	if saved.Currency() != money.XAF {
		t.Errorf("Currency = %s, want XAF", saved.Currency())
	}
	if saved.UpdatedByDevice() != f.till {
		t.Errorf("UpdatedByDevice = %s, want the pushing device", saved.UpdatedByDevice())
	}
}

func TestTheNewerAccountEditWinsEitherWay(t *testing.T) {
	earlier, later := "2026-08-14T09:00:00Z", "2026-08-14T17:00:00Z"

	for _, testCase := range []struct{ name, first, second string }{
		{"newer last", earlier, later},
		{"newer first", later, earlier},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			accountID := finance.NewAccountID()
			name := map[string]string{earlier: "Caisse", later: "Caisse principale"}

			f.push(t, f.accountEvent(1, accountPayload(accountID, name[testCase.first], "CASH", testCase.first)))
			f.push(t, f.accountEvent(2, accountPayload(accountID, name[testCase.second], "CASH", testCase.second)))

			saved := f.store.account(accountID)
			if saved == nil {
				t.Fatal("the account was not saved")
			}
			if saved.Name() != "Caisse principale" {
				t.Errorf("Name = %q, want the newer edit", saved.Name())
			}
		})
	}
}

// Closing an account is an edit, not a deletion: the payments it took still
// name it, and history is not deleted (§40).
func TestAnAccountCanBeClosed(t *testing.T) {
	f := newFixture(t)

	accountID := finance.NewAccountID()
	payload := accountPayload(accountID, "Ancien portefeuille", "MOBILE_MONEY", "2026-08-14T09:00:00Z",
		func(account map[string]any) { account["active"] = false })

	if got := f.push(t, f.accountEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	saved := f.store.account(accountID)
	if saved == nil {
		t.Fatal("the account was not saved")
	}
	if saved.Active() {
		t.Error("an account sent as closed came back open")
	}
}

func TestABadAccountPayloadIsRejected(t *testing.T) {
	accountID := finance.NewAccountID()

	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{
			"no identifier",
			json.RawMessage(`{"account":{"name":"Caisse","kind":"CASH","created_at":"2026-08-01T08:00:00Z","updated_at":"2026-08-14T09:00:00Z"}}`),
		},
		{"no name", accountPayload(accountID, "  ", "CASH", "2026-08-14T09:00:00Z")},
		{"no kind", accountPayload(accountID, "Caisse", "", "2026-08-14T09:00:00Z")},
		{
			// A kind this build does not know is refused rather than stored: it
			// would decide whether the account is reconciled against a drawer.
			"a kind this build does not know",
			accountPayload(accountID, "Portefeuille crypto", "CRYPTO", "2026-08-14T09:00:00Z"),
		},
		{"no updated_at", accountPayload(accountID, "Caisse", "CASH", "")},
		{"updated before created", accountPayload(accountID, "Caisse", "CASH", "2026-07-01T08:00:00Z")},
		{"an unreadable moment", accountPayload(accountID, "Caisse", "CASH", "sometime on Tuesday")},
		{
			// A balance on the wire is the number being checked and the number
			// checking (§18, §59).
			"a field this build does not know",
			accountPayload(accountID, "Caisse", "CASH", "2026-08-14T09:00:00Z",
				func(account map[string]any) { account["balance_minor"] = 245_500 }),
		},
		{"not an object at all", json.RawMessage(`{"account":"Caisse"}`)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			response := f.push(t, f.accountEvent(1, testCase.payload))
			if got := response.Results[0].Status; got != syncing.Rejected {
				t.Errorf("Status = %q, want rejected", got)
			}
			if response.Results[0].Reason == "" {
				t.Error("a rejection said nothing about why")
			}
		})
	}
}
