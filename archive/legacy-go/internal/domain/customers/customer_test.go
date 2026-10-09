package customers_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

func aCustomer(t *testing.T, mutate ...func(*customers.Snapshot)) *customers.Customer {
	t.Helper()

	snapshot := customers.Snapshot{
		ID:         customers.NewID(),
		BusinessID: business.NewID(),
		Name:       "Jean Mbarga",
		CreatedAt:  happenedAt,
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	customer, err := customers.New(snapshot)
	if err != nil {
		t.Fatalf("customers.New: %v", err)
	}
	return customer
}

// Only a name is required. A shopkeeper putting a regular on credit at the
// counter should not have to fill in a form first (§12).
func TestACustomerNeedsOnlyAName(t *testing.T) {
	customer := aCustomer(t)

	if customer.Name() != "Jean Mbarga" {
		t.Errorf("Name = %q", customer.Name())
	}
	if number, given := customer.Phone(); given {
		t.Errorf("Phone = %s, want none", number)
	}
	if limit, set := customer.CreditLimit(); set {
		t.Errorf("CreditLimit = %s, want none", limit)
	}
	if !customer.Active() {
		t.Error("a new customer is not active")
	}
}

// No limit and a limit of zero are different, and collapsing them would either
// refuse every regular who has never been given one, or extend unlimited credit
// to someone deliberately cut off.
func TestNoCreditLimitIsNotALimitOfZero(t *testing.T) {
	unlimited := aCustomer(t)
	cutOff := aCustomer(t, func(s *customers.Snapshot) { s.CreditLimit = money.FromXAF(0) })

	if _, set := unlimited.CreditLimit(); set {
		t.Error("a customer with no limit reported one")
	}
	limit, set := cutOff.CreditLimit()
	if !set {
		t.Fatal("a customer cut off to zero reported no limit")
	}
	if !limit.IsZero() {
		t.Errorf("CreditLimit = %s, want zero", limit)
	}

	// And they behave differently when asked.
	empty := customers.Balance{CustomerID: unlimited.ID()}
	if err := customers.CheckCreditLimit(unlimited, empty, money.FromXAF(1_000_000)); err != nil {
		t.Errorf("a customer with no limit was refused credit: %v", err)
	}
	if err := customers.CheckCreditLimit(cutOff, empty, money.FromXAF(1)); !errors.Is(
		err, customers.ErrCreditLimitExceeded,
	) {
		t.Errorf("err = %v, want ErrCreditLimitExceeded", err)
	}
}

func TestACreditLimitIsCheckedAgainstWhatIsAlreadyOwed(t *testing.T) {
	l := newLedger()
	customer := aCustomer(t, func(s *customers.Snapshot) {
		s.ID = l.customerID
		s.CreditLimit = money.FromXAF(20_000)
	})

	balance := l.balance(t, l.entry(t, customers.CreditSale, 15_000))

	// Up to the limit exactly is allowed: a limit is a ceiling, not a barrier
	// one franc below it.
	if err := customers.CheckCreditLimit(customer, balance, money.FromXAF(5_000)); err != nil {
		t.Errorf("reaching the limit exactly was refused: %v", err)
	}
	if err := customers.CheckCreditLimit(customer, balance, money.FromXAF(5_001)); !errors.Is(
		err, customers.ErrCreditLimitExceeded,
	) {
		t.Errorf("err = %v, want ErrCreditLimitExceeded", err)
	}
}

// A customer in credit has room beyond their limit, because what they owe is
// below zero.
func TestACustomerInCreditHasRoom(t *testing.T) {
	l := newLedger()
	customer := aCustomer(t, func(s *customers.Snapshot) {
		s.ID = l.customerID
		s.CreditLimit = money.FromXAF(10_000)
	})

	balance := l.balance(t, l.entry(t, customers.Payment, -5_000))

	if err := customers.CheckCreditLimit(customer, balance, money.FromXAF(15_000)); err != nil {
		t.Errorf("a customer 5000 in credit could not take 15000 against a 10000 limit: %v", err)
	}
}

func TestCheckingALimitRefusesNonsense(t *testing.T) {
	if err := customers.CheckCreditLimit(nil, customers.Balance{}, money.FromXAF(1)); err == nil {
		t.Error("a missing customer was accepted")
	}

	l := newLedger()
	customer := aCustomer(t, func(s *customers.Snapshot) {
		s.ID = l.customerID
		s.CreditLimit = money.FromXAF(10_000)
	})
	balance := l.balance(t, l.entry(t, customers.CreditSale, 1_000))

	euros, err := money.New(1, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	if err := customers.CheckCreditLimit(customer, balance, euros); !errors.Is(
		err, customers.ErrCurrencyMismatch,
	) {
		t.Errorf("err = %v, want ErrCurrencyMismatch", err)
	}

	// And with no history at all, where there is no balance to add to and the
	// mismatch is only found when the limit itself is compared.
	fresh := customers.Balance{CustomerID: customer.ID()}
	if err := customers.CheckCreditLimit(customer, fresh, euros); !errors.Is(
		err, customers.ErrCurrencyMismatch,
	) {
		t.Errorf("err = %v, want ErrCurrencyMismatch for a customer with no history", err)
	}
}

func TestACustomerIsRefusedWithoutWhatItNeeds(t *testing.T) {
	valid := func() customers.Snapshot {
		return customers.Snapshot{
			ID:         customers.NewID(),
			BusinessID: business.NewID(),
			Name:       "Jean Mbarga",
			CreatedAt:  happenedAt,
		}
	}

	for _, testCase := range []struct {
		name   string
		mutate func(*customers.Snapshot)
	}{
		{"no identifier", func(s *customers.Snapshot) { s.ID = customers.ID{} }},
		{"no business", func(s *customers.Snapshot) { s.BusinessID = business.ID{} }},
		{"no name", func(s *customers.Snapshot) { s.Name = "" }},
		{"a blank name", func(s *customers.Snapshot) { s.Name = "   " }},
		{"a name of control characters", func(s *customers.Snapshot) { s.Name = "Jean​" }},
		{"an overlong name", func(s *customers.Snapshot) { s.Name = strings.Repeat("a", 500) }},
		{"a negative credit limit", func(s *customers.Snapshot) { s.CreditLimit = money.FromXAF(-1) }},
		{"no creation time", func(s *customers.Snapshot) { s.CreatedAt = time.Time{} }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			snapshot := valid()
			testCase.mutate(&snapshot)

			if _, err := customers.New(snapshot); err == nil {
				t.Error("it was accepted")
			}
		})
	}
}

func TestACustomerRestoresToWhatItWas(t *testing.T) {
	number, err := phone.Parse("677123456")
	if err != nil {
		t.Fatalf("phone.Parse: %v", err)
	}

	original := aCustomer(t, func(s *customers.Snapshot) {
		s.Phone = number
		s.Address = "Marché Mokolo, Yaoundé"
		s.Notes = "paie toujours le vendredi"
		s.CreditLimit = money.FromXAF(50_000)
	})

	restored, err := customers.Restore(original.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Snapshot() != original.Snapshot() {
		t.Errorf("the customer changed:\n before %+v\n after  %+v",
			original.Snapshot(), restored.Snapshot())
	}

	if got, given := restored.Phone(); !given || got != number {
		t.Errorf("Phone = %s/%v, want %s", got, given, number)
	}
	if restored.Address() != "Marché Mokolo, Yaoundé" {
		t.Errorf("Address = %q", restored.Address())
	}
	if restored.Notes() != "paie toujours le vendredi" {
		t.Errorf("Notes = %q", restored.Notes())
	}
	if restored.BusinessID() != original.BusinessID() {
		t.Error("the customer changed business")
	}
	if scope := restored.Scope(); scope.Business() != original.BusinessID() {
		t.Errorf("Scope business = %s", scope.Business())
	}
	if !restored.CreatedAt().Equal(original.CreatedAt()) ||
		!restored.UpdatedAt().Equal(original.UpdatedAt()) {
		t.Error("the customer lost its timestamps")
	}
}

// A stored record is not trusted: the same rules apply on the way in, so a row
// written by an older build or synced from another device is checked.
func TestRestoreRefusesWhatNewWould(t *testing.T) {
	if _, err := customers.Restore(customers.Snapshot{
		ID:         customers.NewID(),
		BusinessID: business.NewID(),
		Name:       "  ",
		CreatedAt:  happenedAt,
		UpdatedAt:  happenedAt,
	}); err == nil {
		t.Error("a stored customer with no name was restored")
	}

	if _, err := customers.Restore(customers.Snapshot{
		ID:         customers.NewID(),
		BusinessID: business.NewID(),
		Name:       "Jean",
		CreatedAt:  writtenAt,
		UpdatedAt:  happenedAt,
	}); err == nil {
		t.Error("a customer updated before it was created was restored")
	}
}

// A customer is state, not an event, so two devices editing one cannot both
// win. The device whose edit is in force is kept for the same reason a
// product's is: it breaks a tie between two edits stamped the same instant, and
// without it the two devices could settle on different answers permanently
// (ADR-015).
func TestACustomerRemembersWhoseEditIsInForce(t *testing.T) {
	till := devices.NewID()
	customer := aCustomer(t, func(s *customers.Snapshot) { s.UpdatedByDevice = till })

	if customer.UpdatedByDevice() != till {
		t.Errorf("UpdatedByDevice = %s, want %s", customer.UpdatedByDevice(), till)
	}
	if customer.Snapshot().UpdatedByDevice != till {
		t.Error("the device did not survive a round trip through the snapshot")
	}

	// Zero is allowed: a customer written before the column existed, or created
	// on the server rather than on a device, names nobody. A null sorts below
	// any device, so a real edit always beats one from before.
	if written := aCustomer(t); !written.UpdatedByDevice().IsZero() {
		t.Errorf("UpdatedByDevice = %s, want none", written.UpdatedByDevice())
	}

	restored, err := customers.Restore(customer.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.UpdatedByDevice() != till {
		t.Errorf("UpdatedByDevice = %s after Restore, want %s", restored.UpdatedByDevice(), till)
	}
}

func TestAnArchivedCustomerStaysArchived(t *testing.T) {
	snapshot := aCustomer(t).Snapshot()
	snapshot.Active = false

	restored, err := customers.Restore(snapshot)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Active() {
		t.Error("an archived customer came back active")
	}
}

// A statement is the story of a customer's dealings with the shop: entries in
// the order they happened, with the balance after each (§13).
func TestAStatementRunsTheBalanceDownTheEntries(t *testing.T) {
	l := newLedger()

	monday := happenedAt.AddDate(0, 0, -3)
	wednesday := happenedAt.AddDate(0, 0, -1)

	// Deliberately built out of order, as two tills syncing days apart would.
	statement, err := customers.BuildStatement(l.customerID, []*customers.Transaction{
		l.entry(t, customers.Payment, -10_000, func(s *customers.TransactionSnapshot) {
			s.OccurredAt = wednesday
		}),
		l.entry(t, customers.CreditSale, 25_000, func(s *customers.TransactionSnapshot) {
			s.OccurredAt = monday
		}),
	})
	if err != nil {
		t.Fatalf("BuildStatement: %v", err)
	}

	if len(statement.Lines) != 2 {
		t.Fatalf("got %d lines, want 2", len(statement.Lines))
	}
	// Monday's purchase comes first even though Wednesday's payment was passed
	// in first: a statement is ordered by when things happened.
	if statement.Lines[0].Transaction.Type() != customers.CreditSale {
		t.Errorf("the first line is %s, want the purchase", statement.Lines[0].Transaction.Type())
	}
	if got := statement.Lines[0].Balance.Amount(); got != 25_000 {
		t.Errorf("balance after the purchase = %d, want 25000", got)
	}
	if got := statement.Lines[1].Balance.Amount(); got != 15_000 {
		t.Errorf("balance after the payment = %d, want 15000", got)
	}
	if got := statement.Closing.Amount(); got != 15_000 {
		t.Errorf("closing = %d, want 15000", got)
	}
}

// Two entries at the same instant read the same way on every device, or two
// people looking at the same statement would see different orders.
func TestAStatementReadsTheSameOnEveryDevice(t *testing.T) {
	l := newLedger()

	first := l.entry(t, customers.CreditSale, 5_000)
	second := l.entry(t, customers.CreditSale, 3_000)

	forwards, err := customers.BuildStatement(l.customerID, []*customers.Transaction{first, second})
	if err != nil {
		t.Fatalf("BuildStatement: %v", err)
	}
	backwards, err := customers.BuildStatement(l.customerID, []*customers.Transaction{second, first})
	if err != nil {
		t.Fatalf("BuildStatement: %v", err)
	}

	for i := range forwards.Lines {
		if forwards.Lines[i].Transaction.ID() != backwards.Lines[i].Transaction.ID() {
			t.Errorf("line %d differs depending on the order passed in", i)
		}
		if forwards.Lines[i].Balance != backwards.Lines[i].Balance {
			t.Errorf("the running balance at line %d differs", i)
		}
	}
}

func TestAnEmptyStatementIsNotAnError(t *testing.T) {
	l := newLedger()

	statement, err := customers.BuildStatement(l.customerID, nil)
	if err != nil {
		t.Fatalf("BuildStatement: %v", err)
	}
	if len(statement.Lines) != 0 {
		t.Errorf("got %d lines, want none", len(statement.Lines))
	}
	if !statement.Closing.IsZero() {
		t.Errorf("closing = %s, want zero", statement.Closing)
	}
}

// Building a statement cannot be used to see another customer's dealings.
func TestAStatementRefusesAnotherCustomersEntries(t *testing.T) {
	l, other := newLedger(), newLedger()

	_, err := customers.BuildStatement(l.customerID, []*customers.Transaction{
		other.entry(t, customers.CreditSale, 1_000),
	})
	if !errors.Is(err, customers.ErrInvalidID) {
		t.Errorf("err = %v, want a refusal", err)
	}
}

// The statement does not disturb the slice it was given, which a caller may
// still be holding in the order it fetched.
func TestBuildingAStatementDoesNotReorderTheCaller(t *testing.T) {
	l := newLedger()

	payment := l.entry(t, customers.Payment, -1_000, func(s *customers.TransactionSnapshot) {
		s.OccurredAt = happenedAt
	})
	sale := l.entry(t, customers.CreditSale, 5_000, func(s *customers.TransactionSnapshot) {
		s.OccurredAt = happenedAt.AddDate(0, 0, -1)
	})
	given := []*customers.Transaction{payment, sale}

	if _, err := customers.BuildStatement(l.customerID, given); err != nil {
		t.Fatalf("BuildStatement: %v", err)
	}
	if given[0] != payment || given[1] != sale {
		t.Error("the caller's slice was reordered")
	}
}

// A statement refuses the same nonsense a balance does, and refuses it before
// producing any lines.
func TestAStatementRefusesNonsense(t *testing.T) {
	l := newLedger()

	if _, err := customers.BuildStatement(customers.ID{}, nil); !errors.Is(
		err, customers.ErrInvalidID,
	) {
		t.Error("the zero customer was accepted")
	}

	if _, err := customers.BuildStatement(l.customerID, []*customers.Transaction{
		l.entry(t, customers.CreditSale, 1_000), nil,
	}); !errors.Is(err, customers.ErrInvalidID) {
		t.Error("a missing transaction was accepted")
	}

	// A ledger that mixes currencies cannot be run down, and saying so is
	// better than a statement whose running balance is meaningless.
	euros, err := money.New(1_000, money.EUR)
	if err != nil {
		t.Fatalf("money.New: %v", err)
	}
	mixed := l.entry(t, customers.CreditSale, 1_000, func(s *customers.TransactionSnapshot) {
		s.Amount = euros
		s.OccurredAt = happenedAt.Add(time.Hour)
	})
	if _, err := customers.BuildStatement(l.customerID, []*customers.Transaction{
		l.entry(t, customers.CreditSale, 1_000), mixed,
	}); !errors.Is(err, customers.ErrCurrencyMismatch) {
		t.Errorf("err = %v, want ErrCurrencyMismatch", err)
	}
}
