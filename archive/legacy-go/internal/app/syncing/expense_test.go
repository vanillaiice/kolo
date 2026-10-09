package syncing_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/expenses"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
)

// expensePayload builds an EXPENSE_RECORDED body.
func expensePayload(
	id expenses.ID, category string, amountMinor int64, extra ...func(map[string]any),
) json.RawMessage {
	expense := map[string]any{
		"id":           id.String(),
		"category":     category,
		"account_id":   finance.NewAccountID().String(),
		"amount_minor": amountMinor,
		"occurred_at":  occurredAt.Format("2006-01-02T15:04:05Z07:00"),
	}
	for _, change := range extra {
		change(expense)
	}

	encoded, err := json.Marshal(map[string]any{"expense": expense})
	if err != nil {
		panic(err)
	}
	return encoded
}

func (f *fixture) expenseEvent(sequence int64, payload json.RawMessage) sync.Envelope {
	envelope := f.envelope(sequence)
	envelope.Type = sync.ExpenseRecorded
	envelope.Payload = payload
	return envelope
}

func TestAnExpenseIsApplied(t *testing.T) {
	f := newFixture(t)

	expenseID := expenses.NewID()
	payload := expensePayload(expenseID, "RENT", 50_000,
		func(e map[string]any) {
			e["description"] = "loyer d'août"
			e["reference"] = "REC-0012"
		})

	if got := f.push(t, f.expenseEvent(1, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	spent := f.store.expenseOf(expenseID)
	if spent == nil {
		t.Fatal("the expense was not recorded")
	}
	if spent.Category() != expenses.Rent {
		t.Errorf("category = %s, want RENT", spent.Category())
	}
	if got := spent.Amount().Amount(); got != 50_000 {
		t.Errorf("amount = %d, want 50000", got)
	}
	if spent.BusinessID() != f.tenant {
		t.Errorf("the expense landed in %s, want %s", spent.BusinessID(), f.tenant)
	}
	if spent.Reference() != "REC-0012" {
		t.Errorf("reference = %q", spent.Reference())
	}
	if spent.IsReversal() {
		t.Error("a cost read as a reversal")
	}
}

// A reversal is another expense and travels as its own event: the cost was
// recorded on Monday and corrected on Friday, which is two decisions.
func TestAReversalTravelsAsItsOwnExpense(t *testing.T) {
	f := newFixture(t)

	original := expenses.NewID()
	f.push(t, f.expenseEvent(1, expensePayload(original, "TRANSPORT", 15_000)))

	reversalID := expenses.NewID()
	payload := expensePayload(reversalID, "TRANSPORT", -15_000,
		func(e map[string]any) { e["reverses_id"] = original.String() })
	if got := f.push(t, f.expenseEvent(2, payload)).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}

	reversal := f.store.expenseOf(reversalID)
	if reversal == nil {
		t.Fatal("the reversal was not recorded")
	}
	if !reversal.IsReversal() {
		t.Error("a reversal does not read as one")
	}
	if undone, _ := reversal.Reverses(); undone != original {
		t.Errorf("it undoes %s, want %s", undone, original)
	}

	// Together they cost nothing, by plain addition.
	total, err := expenses.Total([]*expenses.Expense{f.store.expenseOf(original), reversal})
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if !total.IsZero() {
		t.Errorf("a reversed expense still cost %s", total)
	}
}

func TestAReplayedExpenseIsNotRecordedTwice(t *testing.T) {
	f := newFixture(t)

	expenseID := expenses.NewID()
	envelope := f.expenseEvent(1, expensePayload(expenseID, "RENT", 50_000))

	if got := f.push(t, envelope).Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted", got)
	}
	if got := f.push(t, envelope).Results[0].Status; got != syncing.Duplicate {
		t.Errorf("Status = %q, want duplicate", got)
	}
}

func TestABadExpensePayloadIsRejected(t *testing.T) {
	expenseID := expenses.NewID()

	for _, testCase := range []struct {
		name    string
		payload json.RawMessage
	}{
		{
			"no identifier",
			expensePayload(expenseID, "RENT", 50_000, func(e map[string]any) { e["id"] = "" }),
		},
		{
			"a category this build does not know",
			expensePayload(expenseID, "BRIBE", 50_000),
		},
		{
			"no account for the money to come out of",
			expensePayload(expenseID, "RENT", 50_000, func(e map[string]any) { e["account_id"] = "" }),
		},
		{"an expense of nothing", expensePayload(expenseID, "RENT", 0)},
		{
			// Money appearing in the accounts with no explanation.
			"a negative expense that undoes nothing",
			expensePayload(expenseID, "RENT", -50_000),
		},
		{
			"a cost that also claims to be a reversal",
			expensePayload(expenseID, "RENT", 50_000,
				func(e map[string]any) { e["reverses_id"] = expenses.NewID().String() }),
		},
		{
			// "OTHER, 15,000" says nothing at all.
			"other with nothing written on it",
			expensePayload(expenseID, "OTHER", 15_000),
		},
		{
			"money spent in the future",
			expensePayload(expenseID, "RENT", 50_000,
				func(e map[string]any) { e["occurred_at"] = "2099-01-01T00:00:00Z" }),
		},
		{
			"an unreadable moment",
			expensePayload(expenseID, "RENT", 50_000,
				func(e map[string]any) { e["occurred_at"] = "sometime on Tuesday" }),
		},
		{
			"a field this build does not know",
			expensePayload(expenseID, "RENT", 50_000,
				func(e map[string]any) { e["vat_minor"] = 9_625 }),
		},
		{"not an object at all", json.RawMessage(`{"expense":"50000"}`)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			f := newFixture(t)
			response := f.push(t, f.expenseEvent(1, testCase.payload))
			if got := response.Results[0].Status; got != syncing.Rejected {
				t.Errorf("Status = %q, want rejected", got)
			}
			if response.Results[0].Reason == "" {
				t.Error("a rejection said nothing about why")
			}
		})
	}
}
