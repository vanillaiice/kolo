package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

type accountFixture struct {
	repo   *postgres.AccountRepository
	pool   *pgxpool.Pool
	ctx    context.Context
	scope  business.Scope
	tenant business.ID
}

func newAccountFixture(t *testing.T) *accountFixture {
	t.Helper()

	pool := pgtest.Pool(t)
	ctx := context.Background()
	tenant, scope := newTenant(t, postgres.NewBusinessRepository(pool), ctx)

	return &accountFixture{
		repo:   postgres.NewAccountRepository(pool),
		pool:   pool,
		ctx:    ctx,
		scope:  scope,
		tenant: tenant.ID(),
	}
}

func (f *accountFixture) account(
	t *testing.T, name string, mutate ...func(*finance.AccountSnapshot),
) *finance.Account {
	t.Helper()

	snapshot := finance.AccountSnapshot{
		ID:         finance.NewAccountID(),
		BusinessID: f.tenant,
		Name:       name,
		Kind:       finance.Cash,
		Currency:   money.XAF,
		CreatedAt:  createdAt,
	}
	for _, change := range mutate {
		change(&snapshot)
	}

	account, err := finance.NewAccount(snapshot)
	if err != nil {
		t.Fatalf("finance.NewAccount: %v", err)
	}
	return account
}

func (f *accountFixture) stored(
	t *testing.T, name string, mutate ...func(*finance.AccountSnapshot),
) *finance.Account {
	t.Helper()

	account := f.account(t, name, mutate...)
	if err := f.repo.Create(f.ctx, f.scope, account); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return account
}

func TestCreateAndGetAccount(t *testing.T) {
	f := newAccountFixture(t)

	created := f.stored(t, "Caisse")
	loaded, err := f.repo.Get(f.ctx, f.scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
}

// §10's whole point: two Mobile Money wallets are two rows differing by name,
// not two kinds this build has to know about.
func TestTwoWalletsAreTwoRows(t *testing.T) {
	f := newAccountFixture(t)

	mtn := f.stored(t, "MTN Mobile Money", func(s *finance.AccountSnapshot) {
		s.Kind = finance.MobileMoney
		s.Number = "+237699123456"
	})
	orange := f.stored(t, "Orange Money", func(s *finance.AccountSnapshot) {
		s.Kind = finance.MobileMoney
		s.Number = "+237699000000"
	})

	accounts, err := f.repo.List(f.ctx, f.scope, true)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(accounts) != 2 {
		t.Fatalf("got %d accounts, want both wallets", len(accounts))
	}
	// Ordered by name, which is how a till's payment picker reads.
	if accounts[0].ID() != mtn.ID() || accounts[1].ID() != orange.ID() {
		t.Errorf("listing was not ordered by name: %s then %s",
			accounts[0].Name(), accounts[1].Name())
	}
}

// A cashier choosing between two accounts called the same thing is choosing at
// random, and the money goes wherever they happened to tap.
func TestTwoAccountsCannotShareAName(t *testing.T) {
	f := newAccountFixture(t)

	f.stored(t, "Caisse")
	if err := f.repo.Create(f.ctx, f.scope, f.account(t, "  caisse  ")); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict: names differing only in case and space", err)
	}

	// Another business may of course call theirs the same.
	other := newAccountFixture(t)
	if err := other.repo.Create(other.ctx, other.scope, other.account(t, "Caisse")); err != nil {
		t.Errorf("another business could not use the same name: %v", err)
	}
}

func TestEverythingAnAccountCarriesSurvivesStorage(t *testing.T) {
	f := newAccountFixture(t)

	branch := newBranch(t, f.tenant, "Marché Central")
	if err := postgres.NewBusinessRepository(f.pool).CreateBranch(f.ctx, f.scope, branch); err != nil {
		t.Fatalf("creating the branch: %v", err)
	}

	created := f.stored(t, "MTN Mobile Money", func(s *finance.AccountSnapshot) {
		s.BranchID = branch.ID()
		s.Kind = finance.MobileMoney
		s.Number = "+237699123456"
		s.Notes = "compte du patron"
	})

	loaded, err := f.repo.Get(f.ctx, f.scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
}

func TestAnotherBusinessesAccountIsNotFound(t *testing.T) {
	f, other := newAccountFixture(t), newAccountFixture(t)

	theirs := other.stored(t, "Caisse")

	if _, err := f.repo.Get(f.ctx, f.scope, theirs.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	mine, err := f.repo.List(f.ctx, f.scope, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(mine) != 0 {
		t.Errorf("read %d of another business's accounts", len(mine))
	}
}

func TestWritingAnotherBusinessesAccountIsRefused(t *testing.T) {
	f, other := newAccountFixture(t), newAccountFixture(t)

	theirs := other.account(t, "Caisse")
	if err := f.repo.Create(f.ctx, f.scope, theirs); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("Create: got %v, want ErrCrossTenant", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, theirs); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("Update: got %v, want ErrCrossTenant", err)
	}
}

func TestClosingAnAccountKeepsItOutOfTheTillsList(t *testing.T) {
	f := newAccountFixture(t)

	open := f.stored(t, "Caisse")
	closing := f.stored(t, "Ancien portefeuille")

	snapshot := closing.Snapshot()
	snapshot.Active = false
	snapshot.UpdatedAt = snapshot.CreatedAt.Add(time.Hour)
	updated, err := finance.RestoreAccount(snapshot)
	if err != nil {
		t.Fatalf("RestoreAccount: %v", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, updated); err != nil {
		t.Fatalf("Update: %v", err)
	}

	active, err := f.repo.List(f.ctx, f.scope, true)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(active) != 1 || active[0].ID() != open.ID() {
		t.Errorf("the till's list has %d accounts, want only %s", len(active), open.Name())
	}

	// A closed account is still there, because the payments it took still name
	// it and history is not deleted (§40).
	all, err := f.repo.List(f.ctx, f.scope, false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("got %d accounts, want the closed one still on the books", len(all))
	}
}

// A payment naming an account nobody opened is money no report can place.
func TestAPaymentCannotNameAnAccountThatDoesNotExist(t *testing.T) {
	f := newSaleFixture(t)

	sale := f.sale(t)
	stray := f.paymentInto(t, sale, 13_000, finance.NewAccountID())
	if err := f.repo.Record(f.ctx, f.scope, sale, []*sales.Payment{stray}, nil, nil); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// Nor another business's account, which plain foreign keys would allow because
// the identifier is individually valid.
func TestAPaymentCannotNameAnotherBusinessesAccount(t *testing.T) {
	f, other := newSaleFixture(t), newSaleFixture(t)

	sale := f.sale(t)
	stray := f.paymentInto(t, sale, 13_000, other.account)
	if err := f.repo.Record(f.ctx, f.scope, sale, []*sales.Payment{stray}, nil, nil); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// An account that has taken money cannot be deleted out from under it (§40).
func TestAnAccountThatTookMoneyCannotBeDeleted(t *testing.T) {
	f := newSaleFixture(t)

	sale := f.sale(t)
	if err := f.repo.Record(f.ctx, f.scope, sale,
		[]*sales.Payment{f.payment(t, sale, 13_000)}, nil, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	_, err := f.pool.Exec(f.ctx, `DELETE FROM financial_accounts WHERE id = $1`, f.account.ID())
	if err == nil {
		t.Error("an account with payments against it was deleted")
	}
}

func TestAccountOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newAccountFixture(t)
	account := f.account(t, "Caisse")
	var none business.Scope

	operations := map[string]func() error{
		"Create": func() error { return f.repo.Create(f.ctx, none, account) },
		"Get":    func() error { _, err := f.repo.Get(f.ctx, none, account.ID()); return err },
		"List":   func() error { _, err := f.repo.List(f.ctx, none, false); return err },
		"Update": func() error { return f.repo.Update(f.ctx, none, account) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestAccountWritesWithoutAnAccountFail(t *testing.T) {
	f := newAccountFixture(t)

	if err := f.repo.Create(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Create: got %v, want ErrQuery", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, nil); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("Update: got %v, want ErrQuery", err)
	}
	if _, err := f.repo.Get(f.ctx, f.scope, finance.AccountID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("Get: got %v, want ErrNotFound", err)
	}
	if err := f.repo.Update(f.ctx, f.scope, f.account(t, "Caisse")); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("Update of an absent account: got %v, want ErrNotFound", err)
	}
}

// ADR-013: a row the schema allows but the domain does not is refused on the
// way in rather than becoming an account nothing can reason about.
func TestReadingAnAccountWithAnUnknownCurrencyFails(t *testing.T) {
	f := newAccountFixture(t)

	accountID := finance.NewAccountID()
	_, err := f.pool.Exec(f.ctx, `
		INSERT INTO financial_accounts (id, business_id, name, kind, currency, active, created_at, updated_at)
		VALUES ($1, $2, 'Caisse', 'CASH', 'ZZZ', true, now(), now())`,
		accountID.ID(), f.tenant.ID())
	if err != nil {
		t.Fatalf("inserting the row: %v", err)
	}

	if _, err := f.repo.Get(f.ctx, f.scope, accountID); !errors.Is(err, postgres.ErrQuery) {
		t.Errorf("got %v, want ErrQuery", err)
	}
}

func TestAccountOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewAccountRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	account, err := finance.NewAccount(finance.AccountSnapshot{
		ID: finance.NewAccountID(), BusinessID: tenant, Name: "Caisse",
		Kind: finance.Cash, Currency: money.XAF, CreatedAt: createdAt,
	})
	if err != nil {
		t.Fatalf("finance.NewAccount: %v", err)
	}

	operations := map[string]func() error{
		"Create": func() error { return repo.Create(ctx, scope, account) },
		"Get":    func() error { _, err := repo.Get(ctx, scope, account.ID()); return err },
		"List":   func() error { _, err := repo.List(ctx, scope, false); return err },
		"Update": func() error { return repo.Update(ctx, scope, account) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}
