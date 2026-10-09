package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// A database that goes away mid-operation is a real condition, not a
// hypothetical: servers restart and networks partition. What matters is that
// every operation reports it rather than panicking or, worse, returning a zero
// value that reads as "no records".
//
// Closing the pool produces that condition deterministically.

func closedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := pgtest.FreshPool(t)
	pool.Close()
	return pool
}

func TestRepositoryOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	tenant, err := business.New(business.NewID(), "Boutique", money.XAF, createdAt)
	if err != nil {
		t.Fatalf("business.New: %v", err)
	}
	scope := tenant.Scope()

	branch, err := business.NewBranch(business.NewBranchID(), tenant.ID(), "Marché", createdAt)
	if err != nil {
		t.Fatalf("business.NewBranch: %v", err)
	}

	operations := map[string]func() error{
		"Create":       func() error { return repo.Create(ctx, tenant) },
		"Get":          func() error { _, err := repo.Get(ctx, tenant.ID()); return err },
		"Update":       func() error { return repo.Update(ctx, tenant) },
		"CreateBranch": func() error { return repo.CreateBranch(ctx, scope, branch) },
		"GetBranch":    func() error { _, err := repo.GetBranch(ctx, scope, branch.ID()); return err },
		"ListBranches": func() error { _, err := repo.ListBranches(ctx, scope); return err },
		"UpdateBranch": func() error { return repo.UpdateBranch(ctx, scope, branch) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}

// TestListingAnUnavailableDatabaseDoesNotLookEmpty is the specific failure
// worth naming: a listing that returned no rows and no error would be read as
// "this business has no branches", which is a different and much worse answer
// than "the database is unreachable".
func TestListingAnUnavailableDatabaseDoesNotLookEmpty(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewBusinessRepository(pool)

	branches, err := repo.ListBranches(context.Background(), business.MustNewScope(business.NewID()))
	if err == nil {
		t.Fatalf("ListBranches succeeded against a closed pool, returning %d branches", len(branches))
	}
	if branches != nil {
		t.Errorf("returned %d branches alongside an error, want none", len(branches))
	}
}

func TestMigrationOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	operations := map[string]func() error{
		"Migrate":       func() error { _, err := postgres.Migrate(ctx, pool); return err },
		"MigrateDown":   func() error { return postgres.MigrateDown(ctx, pool) },
		"SchemaVersion": func() error { _, err := postgres.SchemaVersion(ctx, pool); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}

func TestUserAndCredentialOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	userRepo := postgres.NewUserRepository(pool)
	credentialRepo := postgres.NewCredentialRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)

	user, err := users.New(users.NewID(), tenant, "Jean", authz.RoleCashier, createdAt)
	if err != nil {
		t.Fatalf("users.New: %v", err)
	}
	credential, err := auth.NewCredential(
		user.ID(), tenant, phone.MustParse("677123456"), "1357", createdAt,
	)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}

	operations := map[string]func() error{
		"users.Create":            func() error { return userRepo.Create(ctx, scope, user) },
		"users.Get":               func() error { _, err := userRepo.Get(ctx, scope, user.ID()); return err },
		"users.List":              func() error { _, err := userRepo.List(ctx, scope); return err },
		"users.Update":            func() error { return userRepo.Update(ctx, scope, user) },
		"credentials.Create":      func() error { return credentialRepo.Create(ctx, scope, credential) },
		"credentials.Get":         func() error { _, err := credentialRepo.Get(ctx, scope, user.ID()); return err },
		"credentials.FindByPhone": func() error { _, err := credentialRepo.FindByPhone(ctx, scope, credential.Phone()); return err },
		"credentials.Update":      func() error { return credentialRepo.Update(ctx, scope, credential) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}

// TestListingUsersOnAnUnavailableDatabaseDoesNotLookEmpty is the same trap as
// for branches: "this business has no staff" is a very different answer from
// "the database is unreachable".
func TestListingUsersOnAnUnavailableDatabaseDoesNotLookEmpty(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewUserRepository(pool)

	found, err := repo.List(context.Background(), business.MustNewScope(business.NewID()))
	if err == nil {
		t.Fatalf("List succeeded against a closed pool, returning %d users", len(found))
	}
	if found != nil {
		t.Errorf("returned %d users alongside an error, want none", len(found))
	}
}
