package postgres_test

import (
	"context"
	"errors"
	"math/rand"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// creditFixture is a business with a customer to owe it money, and the till and
// cashier every ledger entry has to name.
type creditFixture struct {
	ledger    *postgres.CreditRepository
	customers *postgres.CustomerRepository
	pool      *pgxpool.Pool
	ctx       context.Context

	scope    business.Scope
	tenant   business.ID
	user     users.ID
	till     devices.ID
	customer customers.ID
}

func newCreditFixture(t *testing.T) *creditFixture {
	t.Helper()
	return newCreditFixtureOn(t, pgtest.Pool(t))
}

// newCreditFixtureOn builds the same fixture against a given pool, for the one
// test that needs a database of its own because it changes the schema.
func newCreditFixtureOn(t *testing.T, pool *pgxpool.Pool) *creditFixture {
	t.Helper()

	ctx := context.Background()
	tenant, scope := newTenant(t, postgres.NewBusinessRepository(pool), ctx)

	user := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleCashier)
	if err := postgres.NewUserRepository(pool).Create(ctx, scope, user); err != nil {
		t.Fatalf("creating the user: %v", err)
	}
	device := newDevice(t, tenant.ID(), "Till 1")
	if err := postgres.NewDeviceRepository(pool).Create(ctx, scope, device); err != nil {
		t.Fatalf("creating the device: %v", err)
	}

	customerRepo := postgres.NewCustomerRepository(pool)
	f := &creditFixture{
		ledger:    postgres.NewCreditRepository(pool),
		customers: customerRepo,
		pool:      pool,
		ctx:       ctx,
		scope:     scope,
		tenant:    tenant.ID(),
		user:      user.ID(),
		till:      device.ID(),
	}
	f.customer = f.newCustomer(t, "Jean Mbarga").ID()
	return f
}

func (f *creditFixture) newCustomer(t *testing.T, name string, mutate ...func(*customers.Snapshot)) *customers.Customer {
	t.Helper()

	snapshot := customers.Snapshot{
		ID:         customers.NewID(),
		BusinessID: f.tenant,
		Name:       name,
		CreatedAt:  createdAt,
	}
	for _, change := range mutate {
		change(&snapshot)
	}
	customer, err := customers.New(snapshot)
	if err != nil {
		t.Fatalf("customers.New: %v", err)
	}
	if err := f.customers.Create(f.ctx, f.scope, customer); err != nil {
		t.Fatalf("creating a customer: %v", err)
	}
	return customer
}

// entry builds one ledger entry against the fixture's customer.
func (f *creditFixture) entry(
	t *testing.T, transactionType customers.TransactionType, minor int64,
	mutate ...func(*customers.TransactionSnapshot),
) *customers.Transaction {
	t.Helper()

	snapshot := customers.TransactionSnapshot{
		ID:         customers.NewTransactionID(),
		CustomerID: f.customer,
		BusinessID: f.tenant,
		Type:       transactionType,
		Amount:     money.FromXAF(minor),
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	}
	if transactionType.RequiresReference() {
		snapshot.Reference = customers.Reference{Kind: "SALE", ID: customers.NewTransactionID().String()}
	}
	if transactionType.RequiresReason() {
		snapshot.Reason = "corrigé après comptage"
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	transaction, err := customers.RecordTransaction(snapshot)
	if err != nil {
		t.Fatalf("customers.RecordTransaction: %v", err)
	}
	return transaction
}

// record appends an entry, failing the test if the ledger refuses it.
func (f *creditFixture) record(
	t *testing.T, transactionType customers.TransactionType, minor int64,
	mutate ...func(*customers.TransactionSnapshot),
) *customers.Transaction {
	t.Helper()

	transaction := f.entry(t, transactionType, minor, mutate...)
	if err := f.ledger.Record(f.ctx, f.scope, transaction); err != nil {
		t.Fatalf("Record: %v", err)
	}
	return transaction
}

func (f *creditFixture) balance(t *testing.T) customers.Balance {
	t.Helper()

	balance, err := f.ledger.BalanceOf(f.ctx, f.scope, f.customer)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	return balance
}

// §13's worked example, end to end: Jean buys 25,000, pays 10,000, owes 15,000.
func TestTheWorkedExampleFromTheSpecification(t *testing.T) {
	f := newCreditFixture(t)

	f.record(t, customers.CreditSale, 25_000)
	f.record(t, customers.Payment, -10_000)

	balance := f.balance(t)
	if got, want := balance.Outstanding, money.FromXAF(15_000); !got.Equal(want) {
		t.Errorf("outstanding = %s, want %s", got, want)
	}
	if !balance.Owes() {
		t.Error("a customer owing 15,000 does not read as owing anything")
	}
	if balance.Entries != 2 {
		t.Errorf("entries = %d, want 2", balance.Entries)
	}
}

// A balance is derived, so the same entries summed two structurally different
// ways — by PostgreSQL and by the domain — must agree. If they ever disagree,
// the shopkeeper and the customer are reading different numbers.
func TestTheDerivedBalanceAgreesWithTheDomainsSum(t *testing.T) {
	f := newCreditFixture(t)

	random := rand.New(rand.NewSource(20260818))
	for i := range 40 {
		switch random.Intn(4) {
		case 0:
			f.record(t, customers.CreditSale, random.Int63n(90_000)+1, at(i))
		case 1:
			f.record(t, customers.Payment, -(random.Int63n(60_000) + 1), at(i))
		case 2:
			f.record(t, customers.Return, -(random.Int63n(20_000) + 1), at(i))
		default:
			f.record(t, customers.Adjustment, random.Int63n(20_001)-10_000, at(i),
				func(s *customers.TransactionSnapshot) {
					// An adjustment of zero is not an entry, and the domain
					// says so; the sign is what this case is about.
					if s.Amount.IsZero() {
						s.Amount = money.FromXAF(1)
					}
				})
		}
	}

	entries, err := f.ledger.ListForCustomer(f.ctx, f.scope, f.customer)
	if err != nil {
		t.Fatalf("ListForCustomer: %v", err)
	}
	inGo, err := customers.DeriveBalance(f.customer, entries)
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}

	inSQL := f.balance(t)
	if !inSQL.Outstanding.Equal(inGo.Outstanding) {
		t.Errorf("the database says %s and the domain says %s",
			inSQL.Outstanding, inGo.Outstanding)
	}
	if inSQL.Entries != inGo.Entries {
		t.Errorf("entries: database %d, domain %d", inSQL.Entries, inGo.Entries)
	}
	if !inSQL.LastMovedAt.Equal(inGo.LastMovedAt) {
		t.Errorf("last moved: database %s, domain %s", inSQL.LastMovedAt, inGo.LastMovedAt)
	}
}

// at spaces entries out in time, so ordering has something to order by.
func at(offset int) func(*customers.TransactionSnapshot) {
	return func(s *customers.TransactionSnapshot) {
		s.OccurredAt = createdAt.Add(time.Duration(offset) * time.Hour)
		s.RecordedAt = s.OccurredAt
	}
}

// Nobody has bought anything yet, which is not the same as owing zero francs.
func TestACustomerWithNoHistoryHasNoBalance(t *testing.T) {
	f := newCreditFixture(t)

	balance := f.balance(t)
	if balance.HasHistory() {
		t.Errorf("entries = %d, want none", balance.Entries)
	}
	if balance.Owes() || balance.InCredit() {
		t.Errorf("outstanding = %s, want nothing at all", balance.Outstanding)
	}
	if balance.Outstanding.Valid() {
		t.Errorf("outstanding carries a currency (%s) for a customer with no entries",
			balance.Outstanding)
	}
	if !balance.LastMovedAt.IsZero() {
		t.Errorf("last moved = %s, want the zero time", balance.LastMovedAt)
	}
}

// Overpaying leaves a customer in credit. Clamping the balance at zero would
// quietly lose their money.
func TestOverpayingLeavesACustomerInCredit(t *testing.T) {
	f := newCreditFixture(t)

	f.record(t, customers.CreditSale, 10_000)
	f.record(t, customers.Payment, -12_000)

	balance := f.balance(t)
	if !balance.InCredit() {
		t.Errorf("outstanding = %s, want a credit", balance.Outstanding)
	}
	if got, want := balance.Outstanding, money.FromXAF(-2_000); !got.Equal(want) {
		t.Errorf("outstanding = %s, want %s", got, want)
	}
}

// The property that makes an append-only ledger work offline: an entry that
// arrives days late changes the total without disturbing anything already
// there, and lands in the statement where it happened rather than where it
// arrived.
func TestAnEntrySyncedLateLandsWhereItHappened(t *testing.T) {
	f := newCreditFixture(t)

	monday := createdAt
	tuesday := createdAt.Add(24 * time.Hour)
	friday := createdAt.Add(96 * time.Hour)

	f.record(t, customers.CreditSale, 25_000, func(s *customers.TransactionSnapshot) {
		s.OccurredAt, s.RecordedAt = tuesday, tuesday
	})
	// Made on Monday at a till that was offline, and only recorded on Friday.
	late := f.record(t, customers.Payment, -10_000, func(s *customers.TransactionSnapshot) {
		s.OccurredAt, s.RecordedAt = monday, friday
	})

	entries, err := f.ledger.ListForCustomer(f.ctx, f.scope, f.customer)
	if err != nil {
		t.Fatalf("ListForCustomer: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if entries[0].ID() != late.ID() {
		t.Error("the payment made on Monday did not read before the Tuesday purchase")
	}

	// And the balance as of Monday evening includes it, because it happened
	// then, whatever day the server heard about it.
	balance, err := f.ledger.BalanceAsOf(f.ctx, f.scope, f.customer, monday.Add(12*time.Hour))
	if err != nil {
		t.Fatalf("BalanceAsOf: %v", err)
	}
	if got, want := balance.Outstanding, money.FromXAF(-10_000); !got.Equal(want) {
		t.Errorf("balance on Monday evening = %s, want %s", got, want)
	}
}

func TestABalanceAsOfIgnoresWhatHappenedLater(t *testing.T) {
	f := newCreditFixture(t)

	f.record(t, customers.CreditSale, 25_000, at(0))
	f.record(t, customers.Payment, -10_000, at(48))

	before, err := f.ledger.BalanceAsOf(f.ctx, f.scope, f.customer, createdAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("BalanceAsOf: %v", err)
	}
	if got, want := before.Outstanding, money.FromXAF(25_000); !got.Equal(want) {
		t.Errorf("outstanding before the payment = %s, want %s", got, want)
	}
	if before.Entries != 1 {
		t.Errorf("entries = %d, want 1", before.Entries)
	}
}

func TestABalanceAsOfNeedsAMoment(t *testing.T) {
	f := newCreditFixture(t)

	if _, err := f.ledger.BalanceAsOf(f.ctx, f.scope, f.customer, time.Time{}); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// Everything an entry carries has to survive storage, because a statement is
// read months later and the reference is how a line is traced back.
func TestACreditTransactionRoundTripsThroughStorage(t *testing.T) {
	f := newCreditFixture(t)

	branch := newBranch(t, f.tenant, "Marché Central")
	if err := postgres.NewBusinessRepository(f.pool).CreateBranch(f.ctx, f.scope, branch); err != nil {
		t.Fatalf("creating the branch: %v", err)
	}

	recorded := f.record(t, customers.WriteOff, -5_000, func(s *customers.TransactionSnapshot) {
		s.BranchID = branch.ID()
		s.Reason = "créance abandonnée après deux ans"
		s.Reference = customers.Reference{Kind: "SALE", ID: "V-000012"}
		s.RecordedAt = s.OccurredAt.Add(90 * time.Minute)
	})

	entries, err := f.ledger.ListForCustomer(f.ctx, f.scope, f.customer)
	if err != nil {
		t.Fatalf("ListForCustomer: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].Snapshot() != recorded.Snapshot() {
		t.Errorf("stored %+v, want %+v", entries[0].Snapshot(), recorded.Snapshot())
	}
}

// The ledger is append-only in the database and not merely in the domain, so a
// support script or a migration has to record a compensating entry too.
func TestTheCreditLedgerRefusesAnEditEvenInRawSQL(t *testing.T) {
	f := newCreditFixture(t)

	recorded := f.record(t, customers.CreditSale, 25_000)

	_, err := f.pool.Exec(f.ctx,
		`UPDATE customer_transactions SET amount_minor = 1 WHERE id = $1`, recorded.ID().ID())
	if err == nil {
		t.Error("an entry was edited in place")
	}
	_, err = f.pool.Exec(f.ctx,
		`DELETE FROM customer_transactions WHERE id = $1`, recorded.ID().ID())
	if err == nil {
		t.Error("an entry was deleted")
	}

	if got := f.balance(t).Outstanding; !got.Equal(money.FromXAF(25_000)) {
		t.Errorf("outstanding = %s, want the original 25,000", got)
	}
}

// Recording the same entry twice is a conflict rather than a doubled debt. Sync
// resends a backlog, and a customer must not owe twice because a till retried.
func TestRecordingTheSameEntryTwiceConflicts(t *testing.T) {
	f := newCreditFixture(t)

	recorded := f.record(t, customers.CreditSale, 25_000)
	if err := f.ledger.Record(f.ctx, f.scope, recorded); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
	if got := f.balance(t).Outstanding; !got.Equal(money.FromXAF(25_000)) {
		t.Errorf("outstanding = %s, want the debt recorded once", got)
	}
}

// One entry cannot span two tenants, which plain foreign keys would allow
// because each identifier is individually valid.
func TestAnEntryForAnotherBusinessesCustomerIsRefused(t *testing.T) {
	f := newCreditFixture(t)
	other := newCreditFixture(t)

	stray := f.entry(t, customers.CreditSale, 25_000, func(s *customers.TransactionSnapshot) {
		s.CustomerID = other.customer
	})
	if err := f.ledger.Record(f.ctx, f.scope, stray); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

func TestAnotherBusinessesLedgerIsInvisible(t *testing.T) {
	f := newCreditFixture(t)
	other := newCreditFixture(t)

	other.record(t, customers.CreditSale, 25_000)

	entries, err := f.ledger.ListForCustomer(f.ctx, f.scope, other.customer)
	if err != nil {
		t.Fatalf("ListForCustomer: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("read %d of another business's entries", len(entries))
	}

	balance, err := f.ledger.BalanceOf(f.ctx, f.scope, other.customer)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if balance.HasHistory() {
		t.Errorf("another business's customer read as owing %s", balance.Outstanding)
	}
}

func TestRecordingAnotherBusinessesEntryIsRefused(t *testing.T) {
	f := newCreditFixture(t)
	other := newCreditFixture(t)

	theirs := other.entry(t, customers.CreditSale, 25_000)
	if err := f.ledger.Record(f.ctx, f.scope, theirs); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

// "Who owes me money" is the question a shopkeeper actually asks (§21), and the
// answer is a list of debts — not of everyone with a ledger.
func TestOutstandingListsWhoOwesMoneyLargestFirst(t *testing.T) {
	f := newCreditFixture(t)

	// The fixture's own customer owes the middle amount.
	f.record(t, customers.CreditSale, 15_000)

	big := f.newCustomer(t, "Alice Ngo")
	small := f.newCustomer(t, "Bertrand Fouda")
	settled := f.newCustomer(t, "Chantal Etoa")
	inCredit := f.newCustomer(t, "Didier Ateba")
	f.newCustomer(t, "Estelle Bella") // no ledger at all

	for _, entry := range []struct {
		customer customers.ID
		kind     customers.TransactionType
		minor    int64
	}{
		{big.ID(), customers.CreditSale, 40_000},
		{small.ID(), customers.CreditSale, 5_000},
		{settled.ID(), customers.CreditSale, 8_000},
		{settled.ID(), customers.Payment, -8_000},
		{inCredit.ID(), customers.CreditSale, 3_000},
		{inCredit.ID(), customers.Payment, -4_000},
	} {
		f.record(t, entry.kind, entry.minor, func(s *customers.TransactionSnapshot) {
			s.CustomerID = entry.customer
		})
	}

	debtors, err := f.ledger.Outstanding(f.ctx, f.scope)
	if err != nil {
		t.Fatalf("Outstanding: %v", err)
	}
	if len(debtors) != 3 {
		t.Fatalf("got %d debtors, want 3: %+v", len(debtors), debtors)
	}

	want := []struct {
		customer customers.ID
		minor    int64
	}{
		{big.ID(), 40_000},
		{f.customer, 15_000},
		{small.ID(), 5_000},
	}
	for i, expected := range want {
		if debtors[i].CustomerID != expected.customer {
			t.Errorf("debtor %d is %s, want a different customer", i, debtors[i].Name)
		}
		if got := debtors[i].Outstanding; !got.Equal(money.FromXAF(expected.minor)) {
			t.Errorf("debtor %d owes %s, want %s", i, got, money.FromXAF(expected.minor))
		}
	}
	if debtors[0].Name != "Alice Ngo" {
		t.Errorf("the largest debtor is named %q, want Alice Ngo", debtors[0].Name)
	}
	if debtors[0].Entries != 1 || debtors[0].LastMovedAt.IsZero() {
		t.Errorf("debtor %+v lost its entry count or its last movement", debtors[0])
	}
}

func TestOutstandingStaysWithinTheBusiness(t *testing.T) {
	f := newCreditFixture(t)
	other := newCreditFixture(t)

	other.record(t, customers.CreditSale, 25_000)

	debtors, err := f.ledger.Outstanding(f.ctx, f.scope)
	if err != nil {
		t.Fatalf("Outstanding: %v", err)
	}
	for _, debtor := range debtors {
		if debtor.CustomerID == other.customer {
			t.Fatal("another business's debtor appeared in the list")
		}
	}
}

// A total that added francs to euros would mean nothing, so a ledger the
// database could sum but the domain would refuse is refused here too (ADR-010).
func TestABalanceRefusesALedgerThatMixesCurrencies(t *testing.T) {
	f := newCreditFixture(t)

	f.record(t, customers.CreditSale, 25_000)
	f.insertRaw(t, `'CREDIT_SALE', 40, 'EUR', 'SALE', 'V-42', NULL`)

	if _, err := f.ledger.BalanceOf(f.ctx, f.scope, f.customer); !errors.Is(err, customers.ErrCurrencyMismatch) {
		t.Errorf("got %v, want ErrCurrencyMismatch", err)
	}
}

// The same ledger in the debtors list appears once per currency, rather than
// having unlike amounts added into one meaningless number.
func TestOutstandingSeparatesUnlikeCurrencies(t *testing.T) {
	f := newCreditFixture(t)

	f.record(t, customers.CreditSale, 25_000)
	f.insertRaw(t, `'CREDIT_SALE', 40, 'EUR', 'SALE', 'V-42', NULL`)

	debtors, err := f.ledger.Outstanding(f.ctx, f.scope)
	if err != nil {
		t.Fatalf("Outstanding: %v", err)
	}

	found := map[string]int64{}
	for _, debtor := range debtors {
		if debtor.CustomerID == f.customer {
			found[debtor.Outstanding.Currency().Code()] = debtor.Outstanding.Amount()
		}
	}
	if found["XAF"] != 25_000 || found["EUR"] != 40 {
		t.Errorf("got %v, want the two currencies kept apart", found)
	}
}

// insertRaw writes a ledger row the repository could not produce, for the rows
// that only a bad migration or an older build could leave behind (ADR-013).
func (f *creditFixture) insertRaw(t *testing.T, tail string) customers.TransactionID {
	t.Helper()

	transactionID := customers.NewTransactionID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO customer_transactions
			(id, customer_id, business_id, type, amount_minor, currency,
			 reference_kind, reference_id, reason,
			 user_id, device_id, occurred_at, recorded_at)
		VALUES ($1, $2, $3, `+tail+`, $4, $5, now(), now())`,
		transactionID.ID(), f.customer.ID(), f.tenant.ID(), f.user.ID(), f.till.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}
	return transactionID
}

// A currency this build does not know cannot become a balance. Neither a total
// nor a debtors list may quietly drop the entry it could not read.
func TestDerivingABalanceInAnUnknownCurrencyFails(t *testing.T) {
	f := newCreditFixture(t)

	f.insertRaw(t, `'CREDIT_SALE', 25000, 'ZZZ', 'SALE', 'V-42', NULL`)

	if _, err := f.ledger.BalanceOf(f.ctx, f.scope, f.customer); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("BalanceOf: got %v, want ErrQuery", err)
	}

	debtors, err := f.ledger.Outstanding(f.ctx, f.scope)
	if !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Outstanding: got %v (%d debtors), want ErrQuery", err, len(debtors))
	}
	if debtors != nil {
		t.Errorf("a failed listing returned %d debtors", len(debtors))
	}
}

func TestReadingACreditTransactionWithAnUnknownCurrencyFails(t *testing.T) {
	f := newCreditFixture(t)

	f.insertRaw(t, `'CREDIT_SALE', 25000, 'ZZZ', 'SALE', 'V-42', NULL`)

	if _, err := f.ledger.ListForCustomer(f.ctx, f.scope, f.customer); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// A device running ahead of this build could record a type it has never heard
// of. Refusing the row on the way in is the point: the alternative is an entry
// that sums into a balance while meaning something this build cannot say.
//
// The constraints are dropped to produce that row, because the schema and the
// domain agree today — which is exactly why the only way to reach the state a
// version skew would create is to take the schema's half away.
func TestReadingACreditTransactionOfATypeThisBuildDoesNotKnowFails(t *testing.T) {
	pool := pgtest.FreshPool(t)
	f := newCreditFixtureOn(t, pool)

	for _, constraint := range []string{
		"customer_transactions_type_known",
		"customer_transactions_direction",
	} {
		if _, err := pool.Exec(f.ctx,
			`ALTER TABLE customer_transactions DROP CONSTRAINT `+constraint); err != nil {
			t.Fatalf("dropping %s: %v", constraint, err)
		}
	}

	f.insertRaw(t, `'LOAN', 25000, 'XAF', NULL, NULL, NULL`)

	_, err := f.ledger.ListForCustomer(f.ctx, f.scope, f.customer)
	if !errors.Is(err, customers.ErrInvalidTransactionType) {
		t.Errorf("got %v, want ErrInvalidTransactionType", err)
	}
}

func TestCreditOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newCreditFixture(t)
	transaction := f.entry(t, customers.CreditSale, 25_000)
	var none business.Scope

	operations := map[string]func() error{
		"Record":          func() error { return f.ledger.Record(f.ctx, none, transaction) },
		"ListForCustomer": func() error { _, err := f.ledger.ListForCustomer(f.ctx, none, f.customer); return err },
		"BalanceOf":       func() error { _, err := f.ledger.BalanceOf(f.ctx, none, f.customer); return err },
		"BalanceAsOf": func() error {
			_, err := f.ledger.BalanceAsOf(f.ctx, none, f.customer, createdAt)
			return err
		},
		"Outstanding": func() error { _, err := f.ledger.Outstanding(f.ctx, none); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestCreditLookupsWithoutACustomerFail(t *testing.T) {
	f := newCreditFixture(t)

	if _, err := f.ledger.ListForCustomer(f.ctx, f.scope, customers.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("ListForCustomer: got %v, want ErrNotFound", err)
	}
	if _, err := f.ledger.BalanceOf(f.ctx, f.scope, customers.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("BalanceOf: got %v, want ErrNotFound", err)
	}
	if err := f.ledger.Record(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Record: got %v, want ErrQuery", err)
	}
}

// A ledger that came back empty with no error would read as "this customer owes
// nothing", which is a different and much worse answer than "the database is
// unreachable".
func TestCreditOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewCreditRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	customerID := customers.NewID()
	transaction, err := customers.RecordTransaction(customers.TransactionSnapshot{
		ID:         customers.NewTransactionID(),
		CustomerID: customerID,
		BusinessID: tenant,
		Type:       customers.OpeningBalance,
		Amount:     money.FromXAF(25_000),
		UserID:     users.NewID(),
		DeviceID:   devices.NewID(),
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("RecordTransaction: %v", err)
	}

	operations := map[string]func() error{
		"Record":          func() error { return repo.Record(ctx, scope, transaction) },
		"ListForCustomer": func() error { _, err := repo.ListForCustomer(ctx, scope, customerID); return err },
		"BalanceOf":       func() error { _, err := repo.BalanceOf(ctx, scope, customerID); return err },
		"BalanceAsOf": func() error {
			_, err := repo.BalanceAsOf(ctx, scope, customerID, createdAt)
			return err
		},
		"Outstanding": func() error { _, err := repo.Outstanding(ctx, scope); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}
