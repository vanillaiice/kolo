package customers_test

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

var (
	happenedAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)
	writtenAt  = time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)
)

type ledger struct {
	customerID customers.ID
	businessID business.ID
	userID     users.ID
	deviceID   devices.ID
}

func newLedger() *ledger {
	return &ledger{
		customerID: customers.NewID(),
		businessID: business.NewID(),
		userID:     users.NewID(),
		deviceID:   devices.NewID(),
	}
}

// entry builds one transaction, defaulting what a test does not care about.
func (l *ledger) entry(
	t *testing.T, kind customers.TransactionType, amount int64,
	mutate ...func(*customers.TransactionSnapshot),
) *customers.Transaction {
	t.Helper()

	snapshot := customers.TransactionSnapshot{
		ID:         customers.NewTransactionID(),
		CustomerID: l.customerID,
		BusinessID: l.businessID,
		Type:       kind,
		Amount:     money.FromXAF(amount),
		UserID:     l.userID,
		DeviceID:   l.deviceID,
		OccurredAt: happenedAt,
		RecordedAt: writtenAt,
	}
	if kind.RequiresReference() {
		snapshot.Reference = customers.Reference{Kind: "SALE", ID: customers.NewID().String()}
	}
	if kind.RequiresReason() {
		snapshot.Reason = "convenu avec le patron"
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	transaction, err := customers.RecordTransaction(snapshot)
	if err != nil {
		t.Fatalf("RecordTransaction(%s): %v", kind, err)
	}
	return transaction
}

func (l *ledger) balance(t *testing.T, transactions ...*customers.Transaction) customers.Balance {
	t.Helper()
	balance, err := customers.DeriveBalance(l.customerID, transactions)
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}
	return balance
}

// The worked example from §13: Jean buys 25,000 and pays 10,000.
func TestJeanOwesFifteenThousand(t *testing.T) {
	l := newLedger()

	balance := l.balance(t,
		l.entry(t, customers.CreditSale, 25_000),
		l.entry(t, customers.Payment, -10_000),
	)

	if got := balance.Outstanding.Amount(); got != 15_000 {
		t.Errorf("outstanding = %d, want 15000", got)
	}
	if !balance.Owes() {
		t.Error("a customer with 15000 outstanding was not reported as owing")
	}
	if balance.InCredit() {
		t.Error("a customer who owes was reported as in credit")
	}
}

// A device syncing a week late inserts entries among ones already recorded, so
// the order they are summed in cannot change the answer.
func TestABalanceDoesNotDependOnOrder(t *testing.T) {
	l := newLedger()

	sale := l.entry(t, customers.CreditSale, 25_000)
	payment := l.entry(t, customers.Payment, -10_000)
	ret := l.entry(t, customers.Return, -3_000)

	forwards := l.balance(t, sale, payment, ret)
	backwards := l.balance(t, ret, payment, sale)
	shuffled := l.balance(t, payment, sale, ret)

	if forwards.Outstanding != backwards.Outstanding || forwards.Outstanding != shuffled.Outstanding {
		t.Errorf("order changed the balance: %s, %s, %s",
			forwards.Outstanding, backwards.Outstanding, shuffled.Outstanding)
	}
	if got := forwards.Outstanding.Amount(); got != 12_000 {
		t.Errorf("outstanding = %d, want 12000", got)
	}
}

// Every type moves the balance the way its name says.
func TestEachTypeMovesTheBalanceItsOwnWay(t *testing.T) {
	l := newLedger()

	for _, testCase := range []struct {
		kind   customers.TransactionType
		amount int64
		want   int64
	}{
		{customers.CreditSale, 5_000, 5_000},
		{customers.OpeningBalance, 8_000, 8_000},
		{customers.Payment, -5_000, -5_000},
		{customers.Return, -2_000, -2_000},
		{customers.WriteOff, -1_000, -1_000},
		{customers.Adjustment, 500, 500},
		{customers.Adjustment, -500, -500},
	} {
		t.Run(testCase.kind.String(), func(t *testing.T) {
			balance := l.balance(t, l.entry(t, testCase.kind, testCase.amount))
			if got := balance.Outstanding.Amount(); got != testCase.want {
				t.Errorf("outstanding = %d, want %d", got, testCase.want)
			}
		})
	}
}

// A payment that increased a debt is invisible in a total and unarguable in a
// statement, so the sign is checked against the type on the way in.
func TestTheSignMustAgreeWithTheType(t *testing.T) {
	l := newLedger()

	for _, testCase := range []struct {
		name   string
		kind   customers.TransactionType
		amount int64
	}{
		{"a credit sale that reduces the debt", customers.CreditSale, -1_000},
		{"an opening balance below zero", customers.OpeningBalance, -1_000},
		{"a payment that increases the debt", customers.Payment, 1_000},
		{"a return that increases the debt", customers.Return, 1_000},
		{"a write-off that increases the debt", customers.WriteOff, 1_000},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := customers.RecordTransaction(customers.TransactionSnapshot{
				ID:         customers.NewTransactionID(),
				CustomerID: l.customerID,
				BusinessID: l.businessID,
				Type:       testCase.kind,
				Amount:     money.FromXAF(testCase.amount),
				Reference:  customers.Reference{Kind: "SALE", ID: "s"},
				Reason:     "because",
				UserID:     l.userID,
				DeviceID:   l.deviceID,
				OccurredAt: happenedAt,
				RecordedAt: writtenAt,
			})
			if !errors.Is(err, customers.ErrInvalidAmount) {
				t.Errorf("err = %v, want ErrInvalidAmount", err)
			}
		})
	}

	// An adjustment goes either way: a correction can find more or less owed.
	for _, amount := range []int64{500, -500} {
		if _, err := customers.RecordTransaction(customers.TransactionSnapshot{
			ID: customers.NewTransactionID(), CustomerID: l.customerID, BusinessID: l.businessID,
			Type: customers.Adjustment, Amount: money.FromXAF(amount), Reason: "recount",
			UserID: l.userID, DeviceID: l.deviceID, OccurredAt: happenedAt, RecordedAt: writtenAt,
		}); err != nil {
			t.Errorf("an adjustment of %d was refused: %v", amount, err)
		}
	}
}

// Overpaying leaves a customer in credit, and the honest answer is a negative
// balance rather than a zero one that loses their money.
func TestOverpayingLeavesACustomerInCredit(t *testing.T) {
	l := newLedger()

	balance := l.balance(t,
		l.entry(t, customers.CreditSale, 5_000),
		l.entry(t, customers.Payment, -8_000),
	)

	if got := balance.Outstanding.Amount(); got != -3_000 {
		t.Errorf("outstanding = %d, want -3000", got)
	}
	if !balance.InCredit() {
		t.Error("a customer who paid too much was not reported as in credit")
	}
	if balance.Owes() {
		t.Error("a customer in credit was reported as owing")
	}
}

// Owing nothing because you always pay, and owing nothing because you have
// never bought anything, are different facts.
func TestABalanceSaysWhetherThereIsAnyHistory(t *testing.T) {
	l := newLedger()

	fresh := l.balance(t)
	if fresh.HasHistory() {
		t.Error("a customer with no transactions was reported as having history")
	}
	if !fresh.Outstanding.IsZero() {
		t.Errorf("outstanding = %s, want zero", fresh.Outstanding)
	}

	settled := l.balance(t,
		l.entry(t, customers.CreditSale, 5_000),
		l.entry(t, customers.Payment, -5_000),
	)
	if !settled.HasHistory() {
		t.Error("a customer who bought and paid was reported as having no history")
	}
	if !settled.Outstanding.IsZero() {
		t.Errorf("outstanding = %s, want zero", settled.Outstanding)
	}
	if settled.Entries != 2 {
		t.Errorf("Entries = %d, want 2", settled.Entries)
	}
}

// The balance reports when the customer last dealt with the shop, by when it
// happened rather than when it was recorded.
func TestABalanceReportsTheLastTimeItMoved(t *testing.T) {
	l := newLedger()

	monday := happenedAt.AddDate(0, 0, -4)
	balance := l.balance(t,
		l.entry(t, customers.CreditSale, 5_000, func(s *customers.TransactionSnapshot) {
			s.OccurredAt = happenedAt
		}),
		l.entry(t, customers.Payment, -1_000, func(s *customers.TransactionSnapshot) {
			s.OccurredAt = monday
		}),
	)

	if !balance.LastMovedAt.Equal(happenedAt) {
		t.Errorf("LastMovedAt = %s, want the most recent %s", balance.LastMovedAt, happenedAt)
	}
}

// A transaction from someone else's ledger must not be summed into this one.
func TestATransactionFromAnotherCustomerIsRefused(t *testing.T) {
	l, other := newLedger(), newLedger()

	_, err := customers.DeriveBalance(l.customerID, []*customers.Transaction{
		l.entry(t, customers.CreditSale, 5_000),
		other.entry(t, customers.CreditSale, 99_000),
	})
	if !errors.Is(err, customers.ErrInvalidID) {
		t.Errorf("err = %v, want a refusal", err)
	}
}

func TestATransactionIsRefusedWithoutWhatItNeeds(t *testing.T) {
	l := newLedger()
	base := func() customers.TransactionSnapshot {
		return l.entry(t, customers.CreditSale, 5_000).Snapshot()
	}

	for _, testCase := range []struct {
		name   string
		mutate func(*customers.TransactionSnapshot)
		want   error
	}{
		{"no identifier", func(s *customers.TransactionSnapshot) {
			s.ID = customers.TransactionID{}
		}, customers.ErrInvalidID},
		{"no customer", func(s *customers.TransactionSnapshot) { s.CustomerID = customers.ID{} },
			customers.ErrInvalidID},
		{"no business", func(s *customers.TransactionSnapshot) { s.BusinessID = business.ID{} },
			customers.ErrInvalidID},
		{"no user", func(s *customers.TransactionSnapshot) { s.UserID = users.ID{} },
			customers.ErrInvalidID},
		{"no device", func(s *customers.TransactionSnapshot) { s.DeviceID = devices.ID{} },
			customers.ErrInvalidID},
		{"an unknown type", func(s *customers.TransactionSnapshot) { s.Type = "FORGIVEN" },
			customers.ErrInvalidTransactionType},
		{"no type", func(s *customers.TransactionSnapshot) { s.Type = "" },
			customers.ErrInvalidTransactionType},
		{"no currency", func(s *customers.TransactionSnapshot) { s.Amount = money.Money{} },
			customers.ErrInvalidAmount},
		{"an entry of nothing", func(s *customers.TransactionSnapshot) { s.Amount = money.FromXAF(0) },
			customers.ErrInvalidAmount},
		{"a credit sale with no sale", func(s *customers.TransactionSnapshot) {
			s.Reference = customers.Reference{}
		}, customers.ErrMissingReference},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := base()
			testCase.mutate(&snapshot)

			_, err := customers.RecordTransaction(snapshot)
			if !errors.Is(err, testCase.want) {
				t.Errorf("err = %v, want %v", err, testCase.want)
			}
		})
	}
}

// A correction or a write-off moves money with no business event behind it, so
// it has to say why (§39).
func TestACorrectionMustSayWhy(t *testing.T) {
	l := newLedger()

	for _, kind := range []customers.TransactionType{customers.Adjustment, customers.WriteOff} {
		t.Run(kind.String(), func(t *testing.T) {
			amount := int64(500)
			if kind.Decreases() {
				amount = -500
			}
			for _, reason := range []string{"", "   ", "\t"} {
				_, err := customers.RecordTransaction(customers.TransactionSnapshot{
					ID: customers.NewTransactionID(), CustomerID: l.customerID,
					BusinessID: l.businessID, Type: kind, Amount: money.FromXAF(amount),
					Reason: reason, UserID: l.userID, DeviceID: l.deviceID,
					OccurredAt: happenedAt, RecordedAt: writtenAt,
				})
				if !errors.Is(err, customers.ErrMissingReason) {
					t.Errorf("a %s with reason %q was accepted: %v", kind, reason, err)
				}
			}
		})
	}
}

// A payment needs no reference: cash handed over the counter has no document.
func TestAPaymentNeedsNoReference(t *testing.T) {
	l := newLedger()

	if _, err := customers.RecordTransaction(customers.TransactionSnapshot{
		ID: customers.NewTransactionID(), CustomerID: l.customerID, BusinessID: l.businessID,
		Type: customers.Payment, Amount: money.FromXAF(-1_000),
		UserID: l.userID, DeviceID: l.deviceID, OccurredAt: happenedAt, RecordedAt: writtenAt,
	}); err != nil {
		t.Errorf("a cash payment was refused: %v", err)
	}
}

func TestATransactionRecordedBeforeItHappenedIsRefused(t *testing.T) {
	l := newLedger()
	snapshot := l.entry(t, customers.CreditSale, 5_000).Snapshot()
	snapshot.RecordedAt = snapshot.OccurredAt.Add(-time.Second)

	if _, err := customers.RecordTransaction(snapshot); err == nil {
		t.Error("a transaction recorded before it happened was accepted")
	}
}

func TestATransactionRestoresToWhatItWas(t *testing.T) {
	l := newLedger()
	original := l.entry(t, customers.Adjustment, -750, func(s *customers.TransactionSnapshot) {
		s.BranchID = business.NewBranchID()
		s.Reference = customers.Reference{Kind: "STOCK_COUNT", ID: "abc"}
	})

	restored, err := customers.RestoreTransaction(original.Snapshot())
	if err != nil {
		t.Fatalf("RestoreTransaction: %v", err)
	}
	if restored.Snapshot() != original.Snapshot() {
		t.Errorf("the transaction changed:\n before %+v\n after  %+v",
			original.Snapshot(), restored.Snapshot())
	}
}

// A ledger that cannot be added is reported rather than producing a wrong
// total.
func TestABalanceThatOverflowsIsRefused(t *testing.T) {
	l := newLedger()

	_, err := customers.DeriveBalance(l.customerID, []*customers.Transaction{
		l.entry(t, customers.CreditSale, math.MaxInt64),
		l.entry(t, customers.CreditSale, math.MaxInt64),
	})
	if err == nil {
		t.Error("a ledger that cannot be summed produced a balance")
	}
}

func TestDerivingABalanceRefusesNonsense(t *testing.T) {
	l := newLedger()

	if _, err := customers.DeriveBalance(customers.ID{}, nil); !errors.Is(err, customers.ErrInvalidID) {
		t.Error("the zero customer was accepted")
	}
	if _, err := customers.DeriveBalance(l.customerID, []*customers.Transaction{nil}); err == nil {
		t.Error("a missing transaction was accepted")
	}
}

func TestEveryTransactionTypeIsDefinedAndNamed(t *testing.T) {
	kinds := customers.TransactionTypes()
	if len(kinds) != 6 {
		t.Fatalf("got %d types, want 6", len(kinds))
	}
	for _, kind := range kinds {
		if !kind.Defined() {
			t.Errorf("%s is listed but not defined", kind)
		}
		if kind.String() != string(kind) {
			t.Errorf("String() = %q, want %q", kind.String(), string(kind))
		}
		// A type either adds or reduces, never both.
		if kind.Increases() && kind.Decreases() {
			t.Errorf("%s both adds and reduces", kind)
		}
		parsed, err := customers.ParseTransactionType(string(kind))
		if err != nil || parsed != kind {
			t.Errorf("ParseTransactionType(%q) = %v, %v", kind, parsed, err)
		}
	}

	kinds[0] = "TAMPERED"
	if customers.TransactionTypes()[0] == "TAMPERED" {
		t.Error("editing the returned slice changed the types")
	}

	for _, text := range []string{"", "credit_sale", "FORGIVEN"} {
		if _, err := customers.ParseTransactionType(text); err == nil {
			t.Errorf("ParseTransactionType(%q) was accepted", text)
		}
	}
}

// Adjusting or writing off a debt moves money with no business event behind it,
// which is what §39 says needs an audit record.
func TestCorrectionsAreSensitive(t *testing.T) {
	sensitive := map[customers.TransactionType]bool{
		customers.Adjustment: true,
		customers.WriteOff:   true,
	}
	for _, kind := range customers.TransactionTypes() {
		if kind.IsSensitive() != sensitive[kind] {
			t.Errorf("%s: IsSensitive = %v, want %v", kind, kind.IsSensitive(), sensitive[kind])
		}
	}
}

func TestAReferenceReadsBack(t *testing.T) {
	l := newLedger()
	transaction := l.entry(t, customers.CreditSale, 1_000, func(s *customers.TransactionSnapshot) {
		s.Reference = customers.Reference{Kind: "SALE", ID: "abc"}
	})

	reference, named := transaction.Reference()
	if !named || reference.String() != "SALE:abc" {
		t.Errorf("Reference = %q/%v, want SALE:abc", reference, named)
	}
	if (customers.Reference{}).String() != "" {
		t.Error("the zero reference has a name")
	}
}

// Every accessor returns what was put in.
func TestATransactionReportsWhatItWasGiven(t *testing.T) {
	l := newLedger()
	branch := business.NewBranchID()
	transaction := l.entry(t, customers.WriteOff, -2_000, func(s *customers.TransactionSnapshot) {
		s.BranchID = branch
		s.Reason = "parti du village"
	})

	if transaction.CustomerID() != l.customerID {
		t.Errorf("CustomerID = %s, want %s", transaction.CustomerID(), l.customerID)
	}
	if transaction.BusinessID() != l.businessID {
		t.Errorf("BusinessID = %s, want %s", transaction.BusinessID(), l.businessID)
	}
	if transaction.BranchID() != branch {
		t.Errorf("BranchID = %s, want %s", transaction.BranchID(), branch)
	}
	if transaction.Type() != customers.WriteOff {
		t.Errorf("Type = %s, want WRITE_OFF", transaction.Type())
	}
	if transaction.Amount().Amount() != -2_000 {
		t.Errorf("Amount = %s, want -2000", transaction.Amount())
	}
	if transaction.Reason() != "parti du village" {
		t.Errorf("Reason = %q", transaction.Reason())
	}
	if transaction.UserID() != l.userID || transaction.DeviceID() != l.deviceID {
		t.Error("the transaction lost who recorded it")
	}
	if !transaction.OccurredAt().Equal(happenedAt) || !transaction.RecordedAt().Equal(writtenAt) {
		t.Error("the transaction lost its timestamps")
	}
	if transaction.ID().IsZero() {
		t.Error("ID is zero")
	}
}

func TestTransactionIdentifiersRoundTrip(t *testing.T) {
	transactionID := customers.NewTransactionID()

	parsed, err := customers.ParseTransactionID(transactionID.String())
	if err != nil || parsed != transactionID {
		t.Errorf("ParseTransactionID(%s) = %s, %v", transactionID, parsed, err)
	}
	if got := customers.TransactionIDFrom(transactionID.ID()); got != transactionID {
		t.Errorf("TransactionIDFrom lost the value: %s", got)
	}
	for _, text := range []string{"", "not-an-identifier"} {
		if _, err := customers.ParseTransactionID(text); err == nil {
			t.Errorf("ParseTransactionID(%q) was accepted", text)
		}
	}
}
