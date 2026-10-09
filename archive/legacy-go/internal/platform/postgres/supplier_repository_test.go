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
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// supplierFixture is a business with a wholesaler to owe money to, and the till
// and user every ledger entry has to name.
type supplierFixture struct {
	repo   *postgres.SupplierRepository
	ledger *postgres.SupplierLedgerRepository
	pool   *pgxpool.Pool
	ctx    context.Context

	scope    business.Scope
	tenant   business.ID
	user     users.ID
	till     devices.ID
	supplier suppliers.ID
	// account is where a payment's money comes from.
	account finance.AccountID
}

func newSupplierFixture(t *testing.T) *supplierFixture {
	t.Helper()
	return newSupplierFixtureOn(t, pgtest.Pool(t))
}

// newSupplierFixtureOn builds the same fixture against a given pool, for the one
// test that needs a database of its own because it changes the schema.
func newSupplierFixtureOn(t *testing.T, pool *pgxpool.Pool) *supplierFixture {
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

	f := &supplierFixture{
		repo:   postgres.NewSupplierRepository(pool),
		ledger: postgres.NewSupplierLedgerRepository(pool),
		pool:   pool,
		ctx:    ctx,
		scope:  scope,
		tenant: tenant.ID(),
		user:   user.ID(),
		till:   device.ID(),
	}
	f.account = openAccount(t, pool, ctx, scope, tenant.ID(), "Caisse")
	f.supplier = f.stored(t, "Grossiste Nkoabang").ID()
	return f
}

// supplier builds a wholesaler without storing it.
func (f *supplierFixture) supplierNamed(
	t *testing.T, name string, mutate ...func(*suppliers.Snapshot),
) *suppliers.Supplier {
	t.Helper()

	snapshot := suppliers.Snapshot{
		ID:         suppliers.NewID(),
		BusinessID: f.tenant,
		Name:       name,
		CreatedAt:  createdAt,
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	supplier, err := suppliers.New(snapshot)
	if err != nil {
		t.Fatalf("suppliers.New: %v", err)
	}
	return supplier
}

// stored builds a wholesaler and writes it.
func (f *supplierFixture) stored(
	t *testing.T, name string, mutate ...func(*suppliers.Snapshot),
) *suppliers.Supplier {
	t.Helper()

	supplier := f.supplierNamed(t, name, mutate...)
	if err := f.repo.Create(f.ctx, f.scope, supplier); err != nil {
		t.Fatalf("creating a supplier: %v", err)
	}
	return supplier
}

// entry builds one ledger entry against the fixture's supplier.
func (f *supplierFixture) entry(
	t *testing.T, transactionType suppliers.TransactionType, minor int64,
	mutate ...func(*suppliers.TransactionSnapshot),
) *suppliers.Transaction {
	t.Helper()

	snapshot := suppliers.TransactionSnapshot{
		ID:         suppliers.NewTransactionID(),
		SupplierID: f.supplier,
		BusinessID: f.tenant,
		Type:       transactionType,
		Amount:     money.FromXAF(minor),
		UserID:     f.user,
		DeviceID:   f.till,
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	}
	if transactionType.MovesMoney() {
		// A payment names where the money came from, and only a payment does.
		snapshot.AccountID = f.account
	}
	if transactionType.RequiresReason() {
		snapshot.Reason = "erreur de facture"
	}
	if transactionType.RequiresReference() {
		snapshot.Reference = suppliers.Reference{Kind: "PURCHASE", ID: "BL-42"}
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	transaction, err := suppliers.RecordTransaction(snapshot)
	if err != nil {
		t.Fatalf("RecordTransaction(%s): %v", transactionType, err)
	}
	return transaction
}

// record appends an entry, failing the test if the ledger refuses it.
func (f *supplierFixture) record(
	t *testing.T, transactionType suppliers.TransactionType, minor int64,
	mutate ...func(*suppliers.TransactionSnapshot),
) *suppliers.Transaction {
	t.Helper()

	transaction := f.entry(t, transactionType, minor, mutate...)
	if err := f.ledger.Record(f.ctx, f.scope, transaction); err != nil {
		t.Fatalf("Record(%s): %v", transactionType, err)
	}
	return transaction
}

func (f *supplierFixture) balance(t *testing.T, supplierID suppliers.ID) suppliers.Balance {
	t.Helper()

	balance, err := f.ledger.BalanceOf(f.ctx, f.scope, supplierID)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	return balance
}

// insertRaw writes a ledger row the repository could not produce, for the rows
// that only a bad migration or an older build could leave behind (ADR-013).
func (f *supplierFixture) insertRaw(t *testing.T, tail string) suppliers.TransactionID {
	t.Helper()

	transactionID := suppliers.NewTransactionID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO supplier_transactions
			(id, supplier_id, business_id, type, amount_minor, currency,
			 account_id, reference_kind, reference_id, reason,
			 user_id, device_id, occurred_at, recorded_at)
		VALUES ($1, $2, $3, `+tail+`, $4, $5, now(), now())`,
		transactionID.ID(), f.supplier.ID(), f.tenant.ID(), f.user.ID(), f.till.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}
	return transactionID
}

// § 14: a wholesaler needs only a name, because that is all a shopkeeper knows
// on the day they first buy from one.
func TestASupplierWithOnlyANameRoundTrips(t *testing.T) {
	f := newSupplierFixture(t)

	supplier := f.stored(t, "Grossiste Mvog-Ada")

	found, err := f.repo.Get(f.ctx, f.scope, supplier.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if found.Name() != "Grossiste Mvog-Ada" {
		t.Errorf("name = %q, want the one it was created with", found.Name())
	}
	if number, ok := found.Phone(); ok {
		t.Errorf("a supplier created without a number came back with %s", number)
	}
	if !found.Active() {
		t.Error("a supplier is active from the moment they are created")
	}
	if !found.UpdatedByDevice().IsZero() {
		t.Error("a supplier nobody has edited names an editing device")
	}
	if !found.CreatedAt().Equal(createdAt) || !found.UpdatedAt().Equal(createdAt) {
		t.Errorf("timestamps = %s/%s, want %s", found.CreatedAt(), found.UpdatedAt(), createdAt)
	}
}

// Everything else is filled in as the business learns it, and has to survive
// storage: the contact is the person a shopkeeper actually asks for (§14).
func TestEverythingASupplierCarriesRoundTrips(t *testing.T) {
	f := newSupplierFixture(t)

	number, err := phone.Parse("+237677889900")
	if err != nil {
		t.Fatalf("phone.Parse: %v", err)
	}
	supplier := f.stored(t, "Grossiste Mokolo", func(s *suppliers.Snapshot) {
		s.Phone = number
		s.Address = "Marché Mokolo, Yaoundé"
		s.Contact = "Mama Ngo"
		s.Notes = "livre le mardi"
		s.UpdatedByDevice = f.till
	})

	found, err := f.repo.Get(f.ctx, f.scope, supplier.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	stored, ok := found.Phone()
	if !ok || stored != number {
		t.Errorf("phone = %v (%t), want %s", stored, ok, number)
	}
	if found.Address() != "Marché Mokolo, Yaoundé" {
		t.Errorf("address = %q", found.Address())
	}
	if found.Contact() != "Mama Ngo" {
		t.Errorf("contact = %q", found.Contact())
	}
	if found.Notes() != "livre le mardi" {
		t.Errorf("notes = %q", found.Notes())
	}
	if found.UpdatedByDevice() != f.till {
		t.Errorf("updated by %s, want the till that edited it", found.UpdatedByDevice())
	}
}

func TestAnotherBusinessesSupplierIsNotFound(t *testing.T) {
	f := newSupplierFixture(t)
	supplier := f.stored(t, "Grossiste Mokolo")

	other, otherScope := newTenant(t, postgres.NewBusinessRepository(f.pool), f.ctx)
	if other.ID() == f.tenant {
		t.Fatal("the second business is the first")
	}

	// Reported as missing rather than forbidden: saying "you may not see this"
	// confirms it exists to someone who may not know of it.
	if _, err := f.repo.Get(f.ctx, otherScope, supplier.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("Get: got %v, want ErrNotFound", err)
	}
	found, err := f.repo.List(f.ctx, otherScope, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(found) != 0 {
		t.Errorf("another business sees %d suppliers", len(found))
	}
}

func TestWritingAnotherBusinessesSupplierIsRefused(t *testing.T) {
	f := newSupplierFixture(t)
	supplier := f.supplierNamed(t, "Grossiste Mokolo")

	_, otherScope := newTenant(t, postgres.NewBusinessRepository(f.pool), f.ctx)

	if err := f.repo.Create(f.ctx, otherScope, supplier); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("Create: got %v, want ErrCrossTenant", err)
	}
	if err := f.repo.Update(f.ctx, otherScope, supplier); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("Update: got %v, want ErrCrossTenant", err)
	}
}

// A shop stops buying from a wholesaler without losing the history of what it
// bought, so a listing can leave them out while the ledger keeps them.
func TestListingSuppliersCanExcludeTheOnesNoLongerUsed(t *testing.T) {
	f := newSupplierFixture(t)

	f.stored(t, "Alpha Distribution")
	retired := f.stored(t, "Zeta Commerce")

	snapshot := retired.Snapshot()
	snapshot.Active = false
	snapshot.UpdatedAt = createdAt.Add(time.Hour)
	closed, err := suppliers.Restore(snapshot)
	if err != nil {
		t.Fatalf("suppliers.Restore: %v", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, closed); err != nil {
		t.Fatalf("Update: %v", err)
	}

	all, err := f.repo.List(f.ctx, f.scope, false)
	if err != nil {
		t.Fatalf("List(all): %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("listing everyone found %d, want 3", len(all))
	}
	// Ordered by name, so the list reads the way a shopkeeper scans it.
	if all[0].Name() != "Alpha Distribution" || all[2].Name() != "Zeta Commerce" {
		t.Errorf("order = %q…%q, want alphabetical", all[0].Name(), all[2].Name())
	}

	active, err := f.repo.List(f.ctx, f.scope, true)
	if err != nil {
		t.Fatalf("List(active): %v", err)
	}
	if len(active) != 2 {
		t.Fatalf("listing the ones still used found %d, want 2", len(active))
	}
	for _, supplier := range active {
		if supplier.ID() == retired.ID() {
			t.Error("a supplier no longer used is still in the active list")
		}
	}
}

// An edit is a whole-record write, so a detail the shop learned was wrong can be
// taken away again as well as replaced.
func TestUpdatingASupplierCanTakeADetailAwayAgain(t *testing.T) {
	f := newSupplierFixture(t)

	number, err := phone.Parse("+237677889900")
	if err != nil {
		t.Fatalf("phone.Parse: %v", err)
	}
	supplier := f.stored(t, "Grossiste Mokolo", func(s *suppliers.Snapshot) {
		s.Phone = number
		s.Contact = "Mama Ngo"
	})

	snapshot := supplier.Snapshot()
	snapshot.Phone = phone.Number{}
	snapshot.Contact = ""
	snapshot.Name = "Grossiste Mokolo SARL"
	snapshot.UpdatedAt = createdAt.Add(time.Hour)
	snapshot.UpdatedByDevice = f.till
	edited, err := suppliers.Restore(snapshot)
	if err != nil {
		t.Fatalf("suppliers.Restore: %v", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, edited); err != nil {
		t.Fatalf("Update: %v", err)
	}

	found, err := f.repo.Get(f.ctx, f.scope, supplier.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if stored, ok := found.Phone(); ok {
		t.Errorf("a number that was removed came back as %s", stored)
	}
	if found.Contact() != "" {
		t.Errorf("a contact that was removed came back as %q", found.Contact())
	}
	if found.Name() != "Grossiste Mokolo SARL" {
		t.Errorf("name = %q, want the edited one", found.Name())
	}
	if !found.UpdatedAt().Equal(createdAt.Add(time.Hour)) {
		t.Errorf("updated at %s, want the moment of the edit", found.UpdatedAt())
	}
}

func TestUpdatingASupplierWhoIsNotThereFails(t *testing.T) {
	f := newSupplierFixture(t)

	absent := f.supplierNamed(t, "Grossiste Fantôme")
	if err := f.repo.Update(f.ctx, f.scope, absent); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestCreatingTheSameSupplierTwiceConflicts(t *testing.T) {
	f := newSupplierFixture(t)

	supplier := f.stored(t, "Grossiste Mokolo")
	if err := f.repo.Create(f.ctx, f.scope, supplier); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

func TestSupplierOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newSupplierFixture(t)
	supplier := f.supplierNamed(t, "Grossiste Mokolo")
	var none business.Scope

	operations := map[string]func() error{
		"Create": func() error { return f.repo.Create(f.ctx, none, supplier) },
		"Get":    func() error { _, err := f.repo.Get(f.ctx, none, supplier.ID()); return err },
		"List":   func() error { _, err := f.repo.List(f.ctx, none, false); return err },
		"Update": func() error { return f.repo.Update(f.ctx, none, supplier) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestSupplierLookupsWithoutAnIdentifierFail(t *testing.T) {
	f := newSupplierFixture(t)

	if _, err := f.repo.Get(f.ctx, f.scope, suppliers.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("Get: got %v, want ErrNotFound", err)
	}
}

func TestSupplierWritesWithoutASupplierFail(t *testing.T) {
	f := newSupplierFixture(t)

	if err := f.repo.Create(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Create: got %v, want ErrQuery", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Update: got %v, want ErrQuery", err)
	}
}

// ADR-013: a row the schema allows but the domain does not is refused on the
// way in rather than becoming a supplier nothing else can make sense of.
func TestReadingASupplierThatFailsDomainValidationFails(t *testing.T) {
	f := newSupplierFixture(t)

	// The constraint checks the name is neither blank nor overlong, but not
	// that it is free of invisible characters, which only the domain applies.
	supplierID := suppliers.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO suppliers (id, business_id, name, active, created_at, updated_at)
		VALUES ($1, $2, $3, true, now(), now())`,
		supplierID.ID(), f.tenant.ID(), "Grossiste​Mokolo")
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, supplierID); !errors.Is(err, business.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
}

func TestReadingASupplierWithAnUnusableNumberFails(t *testing.T) {
	f := newSupplierFixture(t)

	// The constraint checks the shape of an E.164 number, not that the country
	// code and length are a number anyone could dial.
	supplierID := suppliers.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO suppliers (id, business_id, name, phone, active, created_at, updated_at)
		VALUES ($1, $2, 'Grossiste Mokolo', '+23', true, now(), now())`,
		supplierID.ID(), f.tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, supplierID); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

// A listing stops at a row it cannot read rather than quietly returning the
// rest: skipping the bad one would give a list missing a wholesaler the shop
// owes money to, with nothing to say so.
func TestListingSuppliersFailsOnARowThatCannotBeRead(t *testing.T) {
	f := newSupplierFixture(t)

	supplierID := suppliers.NewID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO suppliers (id, business_id, name, phone, active, created_at, updated_at)
		VALUES ($1, $2, 'Alpha Distribution', '+23', true, now(), now())`,
		supplierID.ID(), f.tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	found, err := f.repo.List(f.ctx, f.scope, false)
	if !errors.Is(err, postgres.ErrQuery) {
		t.Fatalf("got %v (%d suppliers), want ErrQuery", err, len(found))
	}
	if found != nil {
		t.Errorf("a failed listing returned %d suppliers", len(found))
	}
}

// A listing that returned nothing and no error would read as "this business
// buys from nobody", which is a different and much worse answer than "the
// database is unreachable".
func TestSupplierOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewSupplierRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	supplier, err := suppliers.New(suppliers.Snapshot{
		ID:         suppliers.NewID(),
		BusinessID: tenant,
		Name:       "Grossiste Mokolo",
		CreatedAt:  createdAt,
	})
	if err != nil {
		t.Fatalf("suppliers.New: %v", err)
	}

	operations := map[string]func() error{
		"Create": func() error { return repo.Create(ctx, scope, supplier) },
		"Get":    func() error { _, err := repo.Get(ctx, scope, supplier.ID()); return err },
		"List":   func() error { _, err := repo.List(ctx, scope, false); return err },
		"Update": func() error { return repo.Update(ctx, scope, supplier) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}

// §16's shape, end to end: goods taken on credit raise what is owed, and paying
// some of it back lowers it by exactly that much.
func TestWhatIsOwedIsTheSumOfTheLedger(t *testing.T) {
	f := newSupplierFixture(t)

	f.record(t, suppliers.Purchase, 150_000)
	f.record(t, suppliers.Payment, -50_000)

	balance := f.balance(t, f.supplier)
	if !balance.Outstanding.Equal(money.FromXAF(100_000)) {
		t.Errorf("outstanding = %s, want 100000", balance.Outstanding)
	}
	if balance.Entries != 2 {
		t.Errorf("entries = %d, want 2", balance.Entries)
	}
	if !balance.Owes() {
		t.Error("a business 100000 behind does not owe anything")
	}
}

// A balance is derived, so the same entries summed two structurally different
// ways — by PostgreSQL and by the domain — must agree. If they ever disagree,
// the shopkeeper and the wholesaler are reading different numbers.
func TestTheDerivedSupplierBalanceAgreesWithTheDomainsSum(t *testing.T) {
	f := newSupplierFixture(t)

	random := rand.New(rand.NewSource(20260814))
	kinds := []suppliers.TransactionType{
		suppliers.Purchase, suppliers.Payment, suppliers.Return,
		suppliers.Adjustment, suppliers.OpeningBalance,
	}
	for i := range 60 {
		kind := kinds[random.Intn(len(kinds))]
		minor := int64(random.Intn(200_000) + 1)
		if kind.Decreases() || (kind == suppliers.Adjustment && i%2 == 0) {
			minor = -minor
		}
		at := createdAt.Add(time.Duration(random.Intn(1_000)) * time.Minute)
		f.record(t, kind, minor, func(s *suppliers.TransactionSnapshot) {
			s.OccurredAt, s.RecordedAt = at, at
		})
	}

	entries, err := f.ledger.ListForSupplier(f.ctx, f.scope, f.supplier)
	if err != nil {
		t.Fatalf("ListForSupplier: %v", err)
	}
	derived, err := suppliers.DeriveBalance(f.supplier, entries)
	if err != nil {
		t.Fatalf("DeriveBalance: %v", err)
	}

	summed := f.balance(t, f.supplier)
	if !summed.Outstanding.Equal(derived.Outstanding) {
		t.Errorf("the database says %s and the domain says %s",
			summed.Outstanding, derived.Outstanding)
	}
	if summed.Entries != derived.Entries {
		t.Errorf("entries: database %d, domain %d", summed.Entries, derived.Entries)
	}
	if !summed.LastMovedAt.Equal(derived.LastMovedAt) {
		t.Errorf("last moved: database %s, domain %s", summed.LastMovedAt, derived.LastMovedAt)
	}
}

// Ordered by when things happened, not by when they arrived: a till offline for
// a week inserts its entries among ones already recorded.
func TestASupplierLedgerReadsInTheOrderThingsHappened(t *testing.T) {
	f := newSupplierFixture(t)

	late := f.record(t, suppliers.Purchase, 40_000, func(s *suppliers.TransactionSnapshot) {
		s.OccurredAt = createdAt.Add(-48 * time.Hour)
		s.RecordedAt = createdAt.Add(time.Hour)
	})
	first := f.record(t, suppliers.OpeningBalance, 10_000, func(s *suppliers.TransactionSnapshot) {
		s.OccurredAt = createdAt.Add(-72 * time.Hour)
		s.RecordedAt = createdAt.Add(-72 * time.Hour)
	})

	entries, err := f.ledger.ListForSupplier(f.ctx, f.scope, f.supplier)
	if err != nil {
		t.Fatalf("ListForSupplier: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("found %d entries, want 2", len(entries))
	}
	if entries[0].ID() != first.ID() || entries[1].ID() != late.ID() {
		t.Error("a late entry landed where it arrived rather than where it happened")
	}
	if got := f.balance(t, f.supplier).Outstanding; !got.Equal(money.FromXAF(50_000)) {
		t.Errorf("outstanding = %s, want 50000", got)
	}
}

// Nobody has bought from them yet, which is not the same as owing zero francs.
func TestASupplierWithNoHistoryHasNoBalance(t *testing.T) {
	f := newSupplierFixture(t)

	balance := f.balance(t, f.supplier)
	if balance.HasHistory() {
		t.Error("a supplier nothing was ever bought from has history")
	}
	if balance.Outstanding.Valid() {
		t.Errorf("outstanding = %s, want no amount at all", balance.Outstanding)
	}
	if !balance.LastMovedAt.IsZero() {
		t.Errorf("last moved at %s, want never", balance.LastMovedAt)
	}

	entries, err := f.ledger.ListForSupplier(f.ctx, f.scope, f.supplier)
	if err != nil {
		t.Fatalf("ListForSupplier: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("found %d entries against a supplier nothing was bought from", len(entries))
	}
}

// Paying ahead leaves the business in credit. Clamping at zero would quietly
// lose money the shop has already handed over.
func TestPayingMoreThanIsOwedLeavesTheBusinessInCredit(t *testing.T) {
	f := newSupplierFixture(t)

	f.record(t, suppliers.Purchase, 40_000)
	f.record(t, suppliers.Payment, -60_000)

	balance := f.balance(t, f.supplier)
	if !balance.InCredit() {
		t.Error("paying 60000 against a 40000 bill left the business owing")
	}
	if !balance.Outstanding.Equal(money.FromXAF(-20_000)) {
		t.Errorf("outstanding = %s, want -20000", balance.Outstanding)
	}
}

// Everything an entry carries has to survive storage, because a statement is
// read months later and the reference is how a line is traced back to the
// delivery note it came from.
func TestASupplierTransactionRoundTripsThroughStorage(t *testing.T) {
	f := newSupplierFixture(t)

	recorded := f.record(t, suppliers.Payment, -25_000, func(s *suppliers.TransactionSnapshot) {
		s.Reference = suppliers.Reference{Kind: "PURCHASE", ID: "BL-2026-118"}
		s.RecordedAt = createdAt.Add(time.Hour)
	})

	entries, err := f.ledger.ListForSupplier(f.ctx, f.scope, f.supplier)
	if err != nil {
		t.Fatalf("ListForSupplier: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("found %d entries, want 1", len(entries))
	}

	got, want := entries[0].Snapshot(), recorded.Snapshot()
	if got.ID != want.ID || got.SupplierID != want.SupplierID || got.Type != want.Type {
		t.Errorf("identity: got %+v, want %+v", got, want)
	}
	if !got.Amount.Equal(want.Amount) {
		t.Errorf("amount = %s, want %s", got.Amount, want.Amount)
	}
	if got.AccountID != f.account {
		t.Errorf("account = %s, want the till the money came from", got.AccountID)
	}
	if got.Reference != want.Reference {
		t.Errorf("reference = %s, want %s", got.Reference, want.Reference)
	}
	if got.UserID != want.UserID || got.DeviceID != want.DeviceID {
		t.Error("the entry came back naming a different user or device")
	}
	if !got.OccurredAt.Equal(want.OccurredAt) || !got.RecordedAt.Equal(want.RecordedAt) {
		t.Errorf("timestamps: got %s/%s, want %s/%s",
			got.OccurredAt, got.RecordedAt, want.OccurredAt, want.RecordedAt)
	}
}

// The ledger is append-only in the database and not merely in the domain, so a
// support script or a migration has to record a compensating entry too.
func TestTheSupplierLedgerRefusesAnEditEvenInRawSQL(t *testing.T) {
	f := newSupplierFixture(t)
	transaction := f.record(t, suppliers.Purchase, 40_000)

	_, err := f.pool.Exec(f.ctx,
		`UPDATE supplier_transactions SET amount_minor = 1 WHERE id = $1`, transaction.ID().ID())
	if err == nil {
		t.Error("a supplier ledger entry was edited in raw SQL")
	}
	_, err = f.pool.Exec(f.ctx,
		`DELETE FROM supplier_transactions WHERE id = $1`, transaction.ID().ID())
	if err == nil {
		t.Error("a supplier ledger entry was deleted in raw SQL")
	}

	if got := f.balance(t, f.supplier).Outstanding; !got.Equal(money.FromXAF(40_000)) {
		t.Errorf("outstanding = %s, want the 40000 that was recorded", got)
	}
}

// Sync resends a backlog, and the business must not owe twice because a till
// retried what the server already had.
func TestRecordingTheSameSupplierEntryTwiceConflicts(t *testing.T) {
	f := newSupplierFixture(t)
	transaction := f.record(t, suppliers.Purchase, 40_000)

	if err := f.ledger.Record(f.ctx, f.scope, transaction); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
	if got := f.balance(t, f.supplier).Outstanding; !got.Equal(money.FromXAF(40_000)) {
		t.Errorf("outstanding = %s, want 40000: a resend doubled the debt", got)
	}
}

// One entry cannot span two tenants, which plain foreign keys would allow
// because each identifier is individually valid.
func TestAnEntryForAnotherBusinessesSupplierIsRefused(t *testing.T) {
	f := newSupplierFixture(t)

	other, otherScope := newTenant(t, postgres.NewBusinessRepository(f.pool), f.ctx)
	stranger, err := suppliers.New(suppliers.Snapshot{
		ID:         suppliers.NewID(),
		BusinessID: other.ID(),
		Name:       "Grossiste Douala",
		CreatedAt:  createdAt,
	})
	if err != nil {
		t.Fatalf("suppliers.New: %v", err)
	}
	if err := f.repo.Create(f.ctx, otherScope, stranger); err != nil {
		t.Fatalf("creating the other business's supplier: %v", err)
	}

	// This business's user and till, the other business's supplier.
	entry := f.entry(t, suppliers.Purchase, 40_000, func(s *suppliers.TransactionSnapshot) {
		s.SupplierID = stranger.ID()
	})
	if err := f.ledger.Record(f.ctx, f.scope, entry); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want the composite key to refuse it", err)
	}
}

func TestAnotherBusinessesSupplierLedgerIsInvisible(t *testing.T) {
	f := newSupplierFixture(t)
	f.record(t, suppliers.Purchase, 40_000)

	_, otherScope := newTenant(t, postgres.NewBusinessRepository(f.pool), f.ctx)

	entries, err := f.ledger.ListForSupplier(f.ctx, otherScope, f.supplier)
	if err != nil {
		t.Fatalf("ListForSupplier: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("another business read %d entries", len(entries))
	}

	balance, err := f.ledger.BalanceOf(f.ctx, otherScope, f.supplier)
	if err != nil {
		t.Fatalf("BalanceOf: %v", err)
	}
	if balance.HasHistory() {
		t.Errorf("another business sees %s owed", balance.Outstanding)
	}
}

func TestRecordingAnotherBusinessesSupplierEntryIsRefused(t *testing.T) {
	f := newSupplierFixture(t)
	entry := f.entry(t, suppliers.Purchase, 40_000)

	_, otherScope := newTenant(t, postgres.NewBusinessRepository(f.pool), f.ctx)
	if err := f.ledger.Record(f.ctx, otherScope, entry); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

// "Who do I owe" is the question §21 asks on the other side of the debtors
// list, and the answer is a list of debts — not of every wholesaler with a
// ledger.
func TestOutstandingListsWhoTheBusinessOwesLargestFirst(t *testing.T) {
	f := newSupplierFixture(t)

	small := f.stored(t, "Petit Fournisseur")
	settled := f.stored(t, "Grossiste Réglé")

	f.record(t, suppliers.Purchase, 150_000)
	f.record(t, suppliers.Purchase, 20_000, func(s *suppliers.TransactionSnapshot) {
		s.SupplierID = small.ID()
	})
	// Billed and paid in full: no longer a creditor, though the history stands.
	f.record(t, suppliers.Purchase, 30_000, func(s *suppliers.TransactionSnapshot) {
		s.SupplierID = settled.ID()
	})
	f.record(t, suppliers.Payment, -30_000, func(s *suppliers.TransactionSnapshot) {
		s.SupplierID = settled.ID()
	})

	creditors, err := f.ledger.Outstanding(f.ctx, f.scope)
	if err != nil {
		t.Fatalf("Outstanding: %v", err)
	}
	if len(creditors) != 2 {
		t.Fatalf("found %d creditors, want 2", len(creditors))
	}
	if creditors[0].SupplierID != f.supplier || !creditors[0].Outstanding.Equal(money.FromXAF(150_000)) {
		t.Errorf("first = %s owed %s, want the largest debt first",
			creditors[0].Name, creditors[0].Outstanding)
	}
	if creditors[1].SupplierID != small.ID() {
		t.Errorf("second = %s, want the smaller debt", creditors[1].Name)
	}
	if creditors[0].Name != "Grossiste Nkoabang" {
		t.Errorf("name = %q, want the supplier's own", creditors[0].Name)
	}
	if creditors[0].Entries != 1 || creditors[0].LastMovedAt.IsZero() {
		t.Errorf("entries = %d, last moved %s", creditors[0].Entries, creditors[0].LastMovedAt)
	}
	for _, creditor := range creditors {
		if creditor.SupplierID == settled.ID() {
			t.Error("a wholesaler paid in full is still listed as owed money")
		}
	}
}

func TestOutstandingSuppliersStaysWithinTheBusiness(t *testing.T) {
	f := newSupplierFixture(t)
	f.record(t, suppliers.Purchase, 150_000)

	_, otherScope := newTenant(t, postgres.NewBusinessRepository(f.pool), f.ctx)
	creditors, err := f.ledger.Outstanding(f.ctx, otherScope)
	if err != nil {
		t.Fatalf("Outstanding: %v", err)
	}
	if len(creditors) != 0 {
		t.Errorf("another business sees %d creditors", len(creditors))
	}
}

// A total that added francs to euros would mean nothing, so a ledger the
// database could sum but the domain would refuse is refused here too (ADR-010).
func TestASupplierBalanceRefusesALedgerThatMixesCurrencies(t *testing.T) {
	f := newSupplierFixture(t)

	f.record(t, suppliers.Purchase, 40_000)
	f.insertRaw(t, `'PURCHASE', 15000, 'EUR', NULL, 'PURCHASE', 'BL-9', NULL`)

	if _, err := f.ledger.BalanceOf(f.ctx, f.scope, f.supplier); !errors.Is(err, suppliers.ErrCurrencyMismatch) {
		t.Errorf("got %v, want ErrCurrencyMismatch", err)
	}
}

// The same ledger in the creditors list appears once per currency, rather than
// having unlike amounts added into one meaningless number.
func TestOutstandingSuppliersSeparatesUnlikeCurrencies(t *testing.T) {
	f := newSupplierFixture(t)

	f.record(t, suppliers.Purchase, 40_000)
	f.insertRaw(t, `'PURCHASE', 15000, 'EUR', NULL, 'PURCHASE', 'BL-9', NULL`)

	creditors, err := f.ledger.Outstanding(f.ctx, f.scope)
	if err != nil {
		t.Fatalf("Outstanding: %v", err)
	}
	if len(creditors) != 2 {
		t.Fatalf("found %d rows, want one per currency", len(creditors))
	}
	for _, creditor := range creditors {
		if creditor.SupplierID != f.supplier {
			t.Errorf("row names %s, want the one supplier", creditor.SupplierID)
		}
	}
}

// A currency this build does not know cannot become a balance. Neither a total
// nor a creditors list may quietly drop the entry it could not read.
func TestDerivingASupplierBalanceInAnUnknownCurrencyFails(t *testing.T) {
	f := newSupplierFixture(t)

	f.insertRaw(t, `'PURCHASE', 25000, 'ZZZ', NULL, 'PURCHASE', 'BL-42', NULL`)

	if _, err := f.ledger.BalanceOf(f.ctx, f.scope, f.supplier); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("BalanceOf: got %v, want ErrQuery", err)
	}
	if _, err := f.ledger.Outstanding(f.ctx, f.scope); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Outstanding: got %v, want ErrQuery", err)
	}
}

func TestReadingASupplierTransactionWithAnUnknownCurrencyFails(t *testing.T) {
	f := newSupplierFixture(t)

	f.insertRaw(t, `'PURCHASE', 25000, 'ZZZ', NULL, 'PURCHASE', 'BL-42', NULL`)

	if _, err := f.ledger.ListForSupplier(f.ctx, f.scope, f.supplier); !errors.Is(err, postgres.ErrQuery) {
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
func TestReadingASupplierTransactionOfATypeThisBuildDoesNotKnowFails(t *testing.T) {
	pool := pgtest.FreshPool(t)
	f := newSupplierFixtureOn(t, pool)

	for _, constraint := range []string{
		"supplier_transactions_type_known",
		"supplier_transactions_direction",
		"supplier_transactions_account_only_when_money_moved",
		"supplier_transactions_reference_when_required",
	} {
		if _, err := pool.Exec(f.ctx,
			`ALTER TABLE supplier_transactions DROP CONSTRAINT `+constraint); err != nil {
			t.Fatalf("dropping %s: %v", constraint, err)
		}
	}

	f.insertRaw(t, `'CONSIGNMENT', 25000, 'XAF', NULL, NULL, NULL, NULL`)

	_, err := f.ledger.ListForSupplier(f.ctx, f.scope, f.supplier)
	if !errors.Is(err, suppliers.ErrInvalidTransactionType) {
		t.Errorf("got %v, want ErrInvalidTransactionType", err)
	}
}

func TestSupplierLedgerOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newSupplierFixture(t)
	transaction := f.entry(t, suppliers.Purchase, 40_000)
	var none business.Scope

	operations := map[string]func() error{
		"Record":          func() error { return f.ledger.Record(f.ctx, none, transaction) },
		"ListForSupplier": func() error { _, err := f.ledger.ListForSupplier(f.ctx, none, f.supplier); return err },
		"BalanceOf":       func() error { _, err := f.ledger.BalanceOf(f.ctx, none, f.supplier); return err },
		"Outstanding":     func() error { _, err := f.ledger.Outstanding(f.ctx, none); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestSupplierLedgerLookupsWithoutASupplierFail(t *testing.T) {
	f := newSupplierFixture(t)

	if _, err := f.ledger.ListForSupplier(f.ctx, f.scope, suppliers.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("ListForSupplier: got %v, want ErrNotFound", err)
	}
	if _, err := f.ledger.BalanceOf(f.ctx, f.scope, suppliers.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("BalanceOf: got %v, want ErrNotFound", err)
	}
	if err := f.ledger.Record(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Record: got %v, want ErrQuery", err)
	}
}

// A ledger that came back empty with no error would read as "this business owes
// nothing", which is a different and much worse answer than "the database is
// unreachable".
func TestSupplierLedgerOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	ledger := postgres.NewSupplierLedgerRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	supplierID := suppliers.NewID()
	transaction, err := suppliers.RecordTransaction(suppliers.TransactionSnapshot{
		ID:         suppliers.NewTransactionID(),
		SupplierID: supplierID,
		BusinessID: tenant,
		Type:       suppliers.OpeningBalance,
		Amount:     money.FromXAF(40_000),
		UserID:     users.NewID(),
		DeviceID:   devices.NewID(),
		OccurredAt: createdAt,
		RecordedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("RecordTransaction: %v", err)
	}

	operations := map[string]func() error{
		"Record":          func() error { return ledger.Record(ctx, scope, transaction) },
		"ListForSupplier": func() error { _, err := ledger.ListForSupplier(ctx, scope, supplierID); return err },
		"BalanceOf":       func() error { _, err := ledger.BalanceOf(ctx, scope, supplierID); return err },
		"Outstanding":     func() error { _, err := ledger.Outstanding(ctx, scope); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}
