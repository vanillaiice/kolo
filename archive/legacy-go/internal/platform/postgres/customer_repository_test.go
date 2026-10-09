package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// customerFixture is a business with somewhere to keep its customers.
type customerFixture struct {
	repo   *postgres.CustomerRepository
	pool   *pgxpool.Pool
	ctx    context.Context
	scope  business.Scope
	tenant business.ID
}

func newCustomerFixture(t *testing.T) *customerFixture {
	t.Helper()

	pool := pgtest.Pool(t)
	ctx := context.Background()
	tenant, scope := newTenant(t, postgres.NewBusinessRepository(pool), ctx)

	return &customerFixture{
		repo:   postgres.NewCustomerRepository(pool),
		pool:   pool,
		ctx:    ctx,
		scope:  scope,
		tenant: tenant.ID(),
	}
}

// customer builds a customer of the fixture's business.
func (f *customerFixture) customer(t *testing.T, mutate ...func(*customers.Snapshot)) *customers.Customer {
	t.Helper()

	snapshot := customers.Snapshot{
		ID:         customers.NewID(),
		BusinessID: f.tenant,
		Name:       "Jean Mbarga",
		CreatedAt:  createdAt,
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

// stored writes a customer and hands it back, for tests whose subject is what
// happens afterwards.
func (f *customerFixture) stored(t *testing.T, mutate ...func(*customers.Snapshot)) *customers.Customer {
	t.Helper()

	customer := f.customer(t, mutate...)
	if err := f.repo.Create(f.ctx, f.scope, customer); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return customer
}

func TestCreateAndGetCustomer(t *testing.T) {
	f := newCustomerFixture(t)

	created := f.stored(t)
	loaded, err := f.repo.Get(f.ctx, f.scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
}

// A name is all §12 requires, and the record has to survive storage with
// everything else genuinely absent rather than blank.
func TestACustomerWithOnlyANameRoundTrips(t *testing.T) {
	f := newCustomerFixture(t)

	created := f.stored(t)
	loaded, err := f.repo.Get(f.ctx, f.scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if number, set := loaded.Phone(); set {
		t.Errorf("phone = %s, want none recorded", number)
	}
	if loaded.Address() != "" || loaded.Notes() != "" {
		t.Errorf("address %q and notes %q, want both empty",
			loaded.Address(), loaded.Notes())
	}
	if limit, set := loaded.CreditLimit(); set {
		t.Errorf("credit limit = %s, want none set", limit)
	}
}

func TestEverythingACustomerCarriesRoundTrips(t *testing.T) {
	f := newCustomerFixture(t)

	created := f.stored(t, func(s *customers.Snapshot) {
		s.Phone = phone.MustParse("+237699123456")
		s.Address = "Carrefour Nsam, Yaoundé"
		s.Notes = "paie le vendredi"
		s.CreditLimit = money.FromXAF(50_000)
	})

	loaded, err := f.repo.Get(f.ctx, f.scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
}

// The distinction the domain insists on has to survive the database too. A
// stored zero that came back as "no limit" would extend unlimited credit to
// someone deliberately cut off.
func TestALimitOfZeroIsStoredDistinctlyFromNoLimit(t *testing.T) {
	f := newCustomerFixture(t)

	cutOff := f.stored(t, func(s *customers.Snapshot) { s.CreditLimit = money.FromXAF(0) })
	undecided := f.stored(t)

	loadedCutOff, err := f.repo.Get(f.ctx, f.scope, cutOff.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	limit, set := loadedCutOff.CreditLimit()
	if !set {
		t.Fatal("a limit of zero came back as no limit at all")
	}
	if !limit.IsZero() {
		t.Errorf("limit = %s, want zero", limit)
	}

	loadedUndecided, err := f.repo.Get(f.ctx, f.scope, undecided.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if limit, set := loadedUndecided.CreditLimit(); set {
		t.Errorf("no limit came back as %s", limit)
	}
}

// The property a mock could not prove: a query cannot reach another tenant's
// customers, and one that exists elsewhere is reported as absent rather than as
// forbidden (ADR-008).
func TestAnotherBusinessesCustomerIsNotFound(t *testing.T) {
	f := newCustomerFixture(t)
	other := newCustomerFixture(t)

	theirs := other.stored(t)

	if _, err := f.repo.Get(f.ctx, f.scope, theirs.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}

	mine, err := f.repo.List(f.ctx, f.scope, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, customer := range mine {
		if customer.ID() == theirs.ID() {
			t.Fatal("another business's customer appeared in the listing")
		}
	}
}

// A scope cannot be talked out of: a customer belonging to someone else is
// refused even when the caller hands it over directly.
func TestWritingAnotherBusinessesCustomerIsRefused(t *testing.T) {
	f := newCustomerFixture(t)
	other := newCustomerFixture(t)

	theirs := other.customer(t)
	if err := f.repo.Create(f.ctx, f.scope, theirs); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("Create: got %v, want ErrCrossTenant", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, theirs); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("Update: got %v, want ErrCrossTenant", err)
	}
}

func TestListingCustomersCanExcludeClosedAccounts(t *testing.T) {
	f := newCustomerFixture(t)

	active := f.stored(t, func(s *customers.Snapshot) { s.Name = "Alice Ngo" })
	closed := f.stored(t, func(s *customers.Snapshot) { s.Name = "Bertrand Fouda" })

	closedSnapshot := closed.Snapshot()
	closedSnapshot.Active = false
	closedSnapshot.UpdatedAt = closedSnapshot.CreatedAt.Add(time.Hour)
	restored, err := customers.Restore(closedSnapshot)
	if err != nil {
		t.Fatalf("customers.Restore: %v", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, restored); err != nil {
		t.Fatalf("Update: %v", err)
	}

	all, err := f.repo.List(f.ctx, f.scope, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("listing everyone gave %d customers, want 2", len(all))
	}
	// Ordered by name, which is how a till's customer list reads.
	if all[0].ID() != active.ID() || all[1].ID() != closed.ID() {
		t.Errorf("listing was not ordered by name: %s then %s",
			all[0].Name(), all[1].Name())
	}

	open, err := f.repo.List(f.ctx, f.scope, true)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(open) != 1 || open[0].ID() != active.ID() {
		t.Errorf("listing the open accounts gave %d, want only %s", len(open), active.Name())
	}
}

// A number is a way of finding someone, not an identity: a household shares one
// phone, and both people must remain findable.
func TestFindingCustomersByPhoneReturnsEveryoneOnThatNumber(t *testing.T) {
	f := newCustomerFixture(t)

	shared := phone.MustParse("+237699123456")
	first := f.stored(t, func(s *customers.Snapshot) {
		s.Name = "Alice Ngo"
		s.Phone = shared
	})
	second := f.stored(t, func(s *customers.Snapshot) {
		s.Name = "Bertrand Fouda"
		s.Phone = shared
	})
	f.stored(t, func(s *customers.Snapshot) {
		s.Name = "Chantal Etoa"
		s.Phone = phone.MustParse("+237677000000")
	})

	found, err := f.repo.FindByPhone(f.ctx, f.scope, shared)
	if err != nil {
		t.Fatalf("FindByPhone: %v", err)
	}
	if len(found) != 2 {
		t.Fatalf("found %d customers on the shared number, want 2", len(found))
	}
	if found[0].ID() != first.ID() || found[1].ID() != second.ID() {
		t.Errorf("found %s and %s, want %s and %s",
			found[0].Name(), found[1].Name(), first.Name(), second.Name())
	}
}

// The stored form is E.164, so what a cashier types locally has to match what
// was stored from another format (ADR-012).
func TestFindingACustomerByALocallyTypedNumber(t *testing.T) {
	f := newCustomerFixture(t)

	created := f.stored(t, func(s *customers.Snapshot) {
		s.Phone = phone.MustParse("+237699123456")
	})

	typed, err := phone.Parse("6 99 12 34 56")
	if err != nil {
		t.Fatalf("phone.Parse: %v", err)
	}
	found, err := f.repo.FindByPhone(f.ctx, f.scope, typed)
	if err != nil {
		t.Fatalf("FindByPhone: %v", err)
	}
	if len(found) != 1 || found[0].ID() != created.ID() {
		t.Fatalf("found %d customers, want the one stored", len(found))
	}
}

func TestFindingACustomerByPhoneStaysWithinTheBusiness(t *testing.T) {
	f := newCustomerFixture(t)
	other := newCustomerFixture(t)

	number := phone.MustParse("+237699123456")
	other.stored(t, func(s *customers.Snapshot) { s.Phone = number })

	found, err := f.repo.FindByPhone(f.ctx, f.scope, number)
	if err != nil {
		t.Fatalf("FindByPhone: %v", err)
	}
	if len(found) != 0 {
		t.Errorf("found %d of another business's customers", len(found))
	}
}

// A customer record is descriptive, so it is edited in place — including having
// a limit taken away again, which must clear the column rather than leave the
// old number behind.
func TestUpdatingACustomerCanRemoveTheirCreditLimit(t *testing.T) {
	f := newCustomerFixture(t)

	created := f.stored(t, func(s *customers.Snapshot) { s.CreditLimit = money.FromXAF(50_000) })

	snapshot := created.Snapshot()
	snapshot.CreditLimit = money.Money{}
	snapshot.Notes = "limite retirée"
	snapshot.UpdatedAt = snapshot.CreatedAt.Add(24 * time.Hour)
	updated, err := customers.Restore(snapshot)
	if err != nil {
		t.Fatalf("customers.Restore: %v", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, updated); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := f.repo.Get(f.ctx, f.scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if limit, set := loaded.CreditLimit(); set {
		t.Errorf("the limit came back as %s after being removed", limit)
	}
	if loaded.Notes() != "limite retirée" {
		t.Errorf("notes = %q, want the updated text", loaded.Notes())
	}
}

func TestUpdatingACustomerWhoIsNotThereFails(t *testing.T) {
	f := newCustomerFixture(t)

	unsaved := f.customer(t)
	if err := f.repo.Update(f.ctx, f.scope, unsaved); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestCreatingTheSameCustomerTwiceConflicts(t *testing.T) {
	f := newCustomerFixture(t)

	created := f.stored(t)
	if err := f.repo.Create(f.ctx, f.scope, created); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// Every operation refuses a scope nobody set, rather than quietly matching
// nothing and reading as "this business has no customers".
func TestCustomerOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newCustomerFixture(t)
	customer := f.customer(t)
	var none business.Scope

	operations := map[string]func() error{
		"Create":      func() error { return f.repo.Create(f.ctx, none, customer) },
		"Get":         func() error { _, err := f.repo.Get(f.ctx, none, customer.ID()); return err },
		"List":        func() error { _, err := f.repo.List(f.ctx, none, false); return err },
		"FindByPhone": func() error { _, err := f.repo.FindByPhone(f.ctx, none, phone.MustParse("+237699123456")); return err },
		"Update":      func() error { return f.repo.Update(f.ctx, none, customer) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

// A missing identifier is a caller's mistake, not a lookup that happens to find
// nothing, and the zero value must not become a query that matches a row.
func TestLookingUpACustomerWithoutAnIdentifierFails(t *testing.T) {
	f := newCustomerFixture(t)

	if _, err := f.repo.Get(f.ctx, f.scope, customers.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("Get: got %v, want ErrNotFound", err)
	}
	if _, err := f.repo.FindByPhone(f.ctx, f.scope, phone.Number{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("FindByPhone: got %v, want ErrNotFound", err)
	}
}

func TestCustomerWritesWithoutACustomerFail(t *testing.T) {
	f := newCustomerFixture(t)

	if err := f.repo.Create(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Create: got %v, want ErrQuery", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Update: got %v, want ErrQuery", err)
	}
}

// ADR-013: a row the schema allows but the domain does not is refused on the
// way in rather than becoming a customer nothing else can make sense of.
func TestReadingACustomerThatFailsDomainValidationFails(t *testing.T) {
	f := newCustomerFixture(t)

	// The constraint checks the name is neither blank nor overlong, but not
	// that it is free of invisible characters, which only the domain applies.
	customerID := customers.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO customers (id, business_id, name, active, created_at, updated_at)
		VALUES ($1, $2, $3, true, now(), now())`,
		customerID.ID(), f.tenant.ID(), "Jean​Mbarga")
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, customerID); !errors.Is(err, business.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
}

func TestReadingACustomerWithAnUnknownCurrencyFails(t *testing.T) {
	f := newCustomerFixture(t)

	// The schema only requires an upper-case three-letter code, so a currency
	// the system does not know passes the constraint.
	customerID := customers.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO customers (id, business_id, name, credit_limit_minor,
		                       credit_limit_currency, active, created_at, updated_at)
		VALUES ($1, $2, 'Jean Mbarga', 1000, 'ZZZ', true, now(), now())`,
		customerID.ID(), f.tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, customerID); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

func TestReadingACustomerWithAnUnusableNumberFails(t *testing.T) {
	f := newCustomerFixture(t)

	// The constraint checks the shape of an E.164 number, not that the country
	// code and length are a number anyone could dial.
	customerID := customers.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO customers (id, business_id, name, phone, active, created_at, updated_at)
		VALUES ($1, $2, 'Jean Mbarga', '+23', true, now(), now())`,
		customerID.ID(), f.tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, customerID); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// A listing stops at a row it cannot read rather than quietly returning the rest.
// Skipping the bad one would give a customer list that is missing somebody, with
// nothing to say so.
func TestListingCustomersFailsOnARowThatCannotBeRead(t *testing.T) {
	f := newCustomerFixture(t)

	f.stored(t)
	customerID := customers.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO customers (id, business_id, name, phone, active, created_at, updated_at)
		VALUES ($1, $2, 'Alice Ngo', '+23', true, now(), now())`,
		customerID.ID(), f.tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	found, err := f.repo.List(f.ctx, f.scope, false)
	if !errors.Is(err, postgres.ErrQuery) {
		t.Fatalf("got %v (%d customers), want ErrQuery", err, len(found))
	}
	if found != nil {
		t.Errorf("a failed listing returned %d customers", len(found))
	}
}

// A listing that returned nothing and no error would read as "this business has
// no customers", which is a different and much worse answer than "the database
// is unreachable".
func TestCustomerOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewCustomerRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	customer, err := customers.New(customers.Snapshot{
		ID: customers.NewID(), BusinessID: tenant, Name: "Jean Mbarga", CreatedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("customers.New: %v", err)
	}

	operations := map[string]func() error{
		"Create":      func() error { return repo.Create(ctx, scope, customer) },
		"Get":         func() error { _, err := repo.Get(ctx, scope, customer.ID()); return err },
		"List":        func() error { _, err := repo.List(ctx, scope, false); return err },
		"FindByPhone": func() error { _, err := repo.FindByPhone(ctx, scope, phone.MustParse("+237699123456")); return err },
		"Update":      func() error { return repo.Update(ctx, scope, customer) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}
