package postgres_test

import (
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// A customer is state, not an event, so two devices editing one cannot both
// win — the same problem a product has, resolved by the same rule (ADR-015).
// What the customer owes is not state and is never resolved this way: those are
// ledger entries, and both devices' entries stand.

// editedCustomer builds one device's version of the same customer.
func (f *applyFixture) editedCustomer(
	t *testing.T, customerID customers.ID, name string, at time.Time, device devices.ID,
) *customers.Customer {
	t.Helper()

	customer, err := customers.Restore(customers.Snapshot{
		ID:              customerID,
		BusinessID:      f.tenant,
		Name:            name,
		CreditLimit:     money.FromXAF(50_000),
		Active:          true,
		UpdatedByDevice: device,
		CreatedAt:       registered,
		UpdatedAt:       at,
	})
	if err != nil {
		t.Fatalf("customers.Restore: %v", err)
	}
	return customer
}

// applyCustomer pushes one customer edit through the event path.
func (f *applyFixture) applyCustomer(t *testing.T, sequence int64, customer *customers.Customer) {
	t.Helper()

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, sequence),
		postgres.Effects{Customers: []*customers.Customer{customer}}); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}
}

// nameOf reads back what the customer is now called.
func (f *applyFixture) nameOf(t *testing.T, customerID customers.ID) string {
	t.Helper()

	stored, err := postgres.NewCustomerRepository(f.pool).Get(f.ctx, f.scope, customerID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	return stored.Name()
}

func TestTheNewerCustomerEditWins(t *testing.T) {
	f := newApplyFixture(t)
	id := customers.NewID()

	f.applyCustomer(t, 1, f.editedCustomer(t, id, "Jean Mbarga", earlier, f.till))
	f.applyCustomer(t, 2, f.editedCustomer(t, id, "Jean-Paul Mbarga", later, f.phone))

	if got := f.nameOf(t, id); got != "Jean-Paul Mbarga" {
		t.Errorf("name = %q, want the newer one", got)
	}
}

// The case the ordering exists for: the same two edits the other way round.
func TestAnOlderCustomerEditArrivingLastDoesNotWin(t *testing.T) {
	f := newApplyFixture(t)
	id := customers.NewID()

	f.applyCustomer(t, 1, f.editedCustomer(t, id, "Jean-Paul Mbarga", later, f.phone))
	f.applyCustomer(t, 2, f.editedCustomer(t, id, "Jean Mbarga", earlier, f.till))

	if got := f.nameOf(t, id); got != "Jean-Paul Mbarga" {
		t.Errorf("name = %q, want the newer edit to survive the later arrival", got)
	}
}

// Two edits stamped the same instant settle the same way whichever order they
// arrive in. Without the tie-break, two devices holding the same two edits
// would disagree about a customer's name permanently, with nothing to detect it.
func TestASimultaneousCustomerEditIsBrokenTheSameWayWhicheverArrivesFirst(t *testing.T) {
	first, second := newApplyFixture(t), newApplyFixture(t)

	high, low := first.till, first.phone
	if high.String() < low.String() {
		high, low = low, high
	}

	id := customers.NewID()
	first.applyCustomer(t, 1, first.editedCustomer(t, id, "Jean Mbarga", earlier, low))
	first.applyCustomer(t, 2, first.editedCustomer(t, id, "Jean-Paul Mbarga", earlier, high))

	otherID := customers.NewID()
	second.applyCustomer(t, 1, second.editedCustomer(t, otherID, "Jean-Paul Mbarga", earlier, high))
	second.applyCustomer(t, 2, second.editedCustomer(t, otherID, "Jean Mbarga", earlier, low))

	forwards, backwards := first.nameOf(t, id), second.nameOf(t, otherID)
	if forwards != backwards {
		t.Errorf("the same two edits gave %q one way and %q the other, so devices diverge",
			forwards, backwards)
	}
	if forwards != "Jean-Paul Mbarga" {
		t.Errorf("name = %q, want the higher device's edit", forwards)
	}
}

// A losing edit is discarded rather than reported. It lost; an error would turn
// an ordinary sync into a failure the device would keep retrying.
func TestALosingCustomerEditIsNotAnError(t *testing.T) {
	f := newApplyFixture(t)
	id := customers.NewID()

	f.applyCustomer(t, 1, f.editedCustomer(t, id, "Jean-Paul Mbarga", later, f.till))

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 2),
		postgres.Effects{Customers: []*customers.Customer{
			f.editedCustomer(t, id, "Jean Mbarga", earlier, f.phone),
		}}); err != nil {
		t.Fatalf("a losing edit was reported as a failure: %v", err)
	}
	if got := f.nameOf(t, id); got != "Jean-Paul Mbarga" {
		t.Errorf("name = %q, want the newer edit", got)
	}
}

func TestReapplyingTheSameCustomerEditChangesNothing(t *testing.T) {
	f := newApplyFixture(t)
	id := customers.NewID()

	same := f.editedCustomer(t, id, "Jean Mbarga", earlier, f.till)
	f.applyCustomer(t, 1, same)
	f.applyCustomer(t, 2, same)
	f.applyCustomer(t, 3, f.editedCustomer(t, id, "Jean-Paul Mbarga", later, f.phone))
	f.applyCustomer(t, 4, same)

	if got := f.nameOf(t, id); got != "Jean-Paul Mbarga" {
		t.Errorf("name = %q: a replay undid a newer edit", got)
	}
}

func TestACustomerArrivingForTheFirstTimeIsCreated(t *testing.T) {
	f := newApplyFixture(t)
	id := customers.NewID()

	f.applyCustomer(t, 1, f.editedCustomer(t, id, "Jean Mbarga", earlier, f.till))

	if got := f.nameOf(t, id); got != "Jean Mbarga" {
		t.Errorf("name = %q, want the customer created", got)
	}
}

// A customer edit cannot move someone into another tenant. The business is not
// in the SET list, and the scope refuses it before that anyway (ADR-008).
func TestACustomerEditCannotChangeItsBusiness(t *testing.T) {
	f, stranger := newApplyFixture(t), newApplyFixture(t)

	id := customers.NewID()
	f.applyCustomer(t, 1, f.editedCustomer(t, id, "Jean Mbarga", earlier, f.till))

	if _, err := f.events.RecordAndApply(stranger.ctx, stranger.scope, stranger.event(t, 1),
		postgres.Effects{Customers: []*customers.Customer{
			f.editedCustomer(t, id, "Volé", later, f.till),
		}}); err == nil {
		t.Fatal("a customer edit for another business was accepted")
	}
	if got := f.nameOf(t, id); got != "Jean Mbarga" {
		t.Errorf("name = %q, want the original", got)
	}
}

// An edit that wins must not disturb the ledger. What someone owes is the sum
// of their transactions, and a device correcting a name has said nothing about
// their debts.
func TestACustomerEditLeavesTheirBalanceAlone(t *testing.T) {
	f := newSaleFixture(t)

	customerID := f.customer(t, "Jean Mbarga")
	sale := f.sale(t, func(s *sales.Snapshot) { s.CustomerID = customerID })
	if err := f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{f.payment(t, sale, 10_000)}, nil,
		f.creditFor(t, sale, customerID, 3_000)); err != nil {
		t.Fatalf("Record: %v", err)
	}

	f.applyCustomer(t, 9, f.editedCustomer(t, customerID, "Jean-Paul Mbarga", later, f.phone))

	balance, err := postgres.NewCreditRepository(f.pool).BalanceOf(f.ctx, f.scope, customerID)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if got := balance.Outstanding; !got.Equal(money.FromXAF(3_000)) {
		t.Errorf("outstanding = %s, want the debt untouched by a name change", got)
	}
	if got := f.nameOf(t, customerID); got != "Jean-Paul Mbarga" {
		t.Errorf("name = %q, want the edit applied", got)
	}
}

// An account settles the same way, and for the same reason: it is state. What
// it holds is not, and is never resolved this way.

func (f *applyFixture) editedAccount(
	t *testing.T, accountID finance.AccountID, name string, at time.Time, device devices.ID,
) *finance.Account {
	t.Helper()

	account, err := finance.RestoreAccount(finance.AccountSnapshot{
		ID:              accountID,
		BusinessID:      f.tenant,
		Name:            name,
		Kind:            finance.MobileMoney,
		Currency:        money.XAF,
		Active:          true,
		UpdatedByDevice: device,
		CreatedAt:       registered,
		UpdatedAt:       at,
	})
	if err != nil {
		t.Fatalf("finance.RestoreAccount: %v", err)
	}
	return account
}

func (f *applyFixture) applyAccount(t *testing.T, sequence int64, account *finance.Account) {
	t.Helper()

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, sequence),
		postgres.Effects{Accounts: []*finance.Account{account}}); err != nil {
		t.Fatalf("RecordAndApply: %v", err)
	}
}

func (f *applyFixture) accountName(t *testing.T, accountID finance.AccountID) string {
	t.Helper()

	stored, err := postgres.NewAccountRepository(f.pool).Get(f.ctx, f.scope, accountID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	return stored.Name()
}

// An account opened on a phone reaches every till, and a later edit replaces an
// earlier one whichever order they arrive in (§10, ADR-015).
func TestAnAccountOpenedElsewhereArrivesAndSettles(t *testing.T) {
	f := newApplyFixture(t)
	id := finance.NewAccountID()

	f.applyAccount(t, 1, f.editedAccount(t, id, "Orange", earlier, f.till))
	if got := f.accountName(t, id); got != "Orange" {
		t.Errorf("name = %q, want the account created", got)
	}

	f.applyAccount(t, 2, f.editedAccount(t, id, "Orange Money", later, f.phone))
	if got := f.accountName(t, id); got != "Orange Money" {
		t.Errorf("name = %q, want the newer edit", got)
	}

	// The older edit arriving late changes nothing.
	f.applyAccount(t, 3, f.editedAccount(t, id, "Orange", earlier, f.till))
	if got := f.accountName(t, id); got != "Orange Money" {
		t.Errorf("name = %q: an older edit arriving last won", got)
	}
}

func TestASimultaneousAccountEditIsBrokenTheSameWayWhicheverArrivesFirst(t *testing.T) {
	first, second := newApplyFixture(t), newApplyFixture(t)

	high, low := first.till, first.phone
	if high.String() < low.String() {
		high, low = low, high
	}

	id := finance.NewAccountID()
	first.applyAccount(t, 1, first.editedAccount(t, id, "Orange", earlier, low))
	first.applyAccount(t, 2, first.editedAccount(t, id, "Orange Money", earlier, high))

	otherID := finance.NewAccountID()
	second.applyAccount(t, 1, second.editedAccount(t, otherID, "Orange Money", earlier, high))
	second.applyAccount(t, 2, second.editedAccount(t, otherID, "Orange", earlier, low))

	forwards, backwards := first.accountName(t, id), second.accountName(t, otherID)
	if forwards != backwards {
		t.Errorf("the same two edits gave %q one way and %q the other, so devices diverge",
			forwards, backwards)
	}
}

// A nil account is a caller bug, and an account belonging to someone else is
// refused however it arrives.
func TestANilOrForeignAccountIsRefused(t *testing.T) {
	f, stranger := newApplyFixture(t), newApplyFixture(t)

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
		postgres.Effects{Accounts: []*finance.Account{nil}}); err == nil {
		t.Fatal("a nil account was accepted")
	}

	id := finance.NewAccountID()
	f.applyAccount(t, 2, f.editedAccount(t, id, "Orange Money", earlier, f.till))
	if _, err := f.events.RecordAndApply(stranger.ctx, stranger.scope, stranger.event(t, 1),
		postgres.Effects{Accounts: []*finance.Account{
			f.editedAccount(t, id, "Volé", later, f.till),
		}}); err == nil {
		t.Fatal("an account edit for another business was accepted")
	}
	if got := f.accountName(t, id); got != "Orange Money" {
		t.Errorf("name = %q, want the original", got)
	}
}

// A nil customer in the slice is a caller bug, refused rather than written
// around.
func TestANilCustomerIsRefused(t *testing.T) {
	f := newApplyFixture(t)

	if _, err := f.events.RecordAndApply(f.ctx, f.scope, f.event(t, 1),
		postgres.Effects{Customers: []*customers.Customer{nil}}); err == nil {
		t.Fatal("a nil customer was accepted")
	}
}
