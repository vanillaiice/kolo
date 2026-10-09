package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

var createdAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

func newBusinessRepository(t *testing.T) (*postgres.BusinessRepository, context.Context) {
	t.Helper()
	return postgres.NewBusinessRepository(pgtest.Pool(t)), context.Background()
}

// newTenant stores a fresh business and returns it with a scope over it. Every
// test works under its own tenant, so tests cannot see each other's rows.
func newTenant(t *testing.T, repo *postgres.BusinessRepository, ctx context.Context) (*business.Business, business.Scope) {
	t.Helper()

	record, err := business.New(business.NewID(), "Boutique Chez Jean", money.XAF, createdAt)
	if err != nil {
		t.Fatalf("business.New: %v", err)
	}
	if err := repo.Create(ctx, record); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return record, record.Scope()
}

func newBranch(t *testing.T, tenant business.ID, name string) *business.Branch {
	t.Helper()

	branch, err := business.NewBranch(business.NewBranchID(), tenant, name, createdAt)
	if err != nil {
		t.Fatalf("business.NewBranch: %v", err)
	}
	return branch
}

func TestCreateAndGetBusiness(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	created, _ := newTenant(t, repo, ctx)

	loaded, err := repo.Get(ctx, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
}

// TestTimestampsSurviveARoundTrip matters because §40 requires historical
// records to keep their original timestamps, and a database that silently
// rounded or shifted them would break that quietly.
func TestTimestampsSurviveARoundTrip(t *testing.T) {
	repo, ctx := newBusinessRepository(t)

	// A time with sub-second precision, in a non-UTC zone, to catch both
	// truncation and a zone being applied on the way through.
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	precise := time.Date(2026, 8, 14, 10, 30, 45, 123_456_000, wat)

	record, err := business.New(business.NewID(), "Boutique", money.XAF, precise)
	if err != nil {
		t.Fatalf("business.New: %v", err)
	}
	if err := repo.Create(ctx, record); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, record.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !loaded.CreatedAt().Equal(precise) {
		t.Errorf("CreatedAt() = %s, want the same instant as %s", loaded.CreatedAt(), precise)
	}
	if got := loaded.CreatedAt().Location(); got != time.UTC {
		t.Errorf("CreatedAt() location = %s, want UTC", got)
	}
}

func TestGetMissingBusiness(t *testing.T) {
	repo, ctx := newBusinessRepository(t)

	if _, err := repo.Get(ctx, business.NewID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := repo.Get(ctx, business.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero identifier: got %v, want ErrNotFound", err)
	}
}

func TestCreateBusinessTwiceConflicts(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	created, _ := newTenant(t, repo, ctx)

	if err := repo.Create(ctx, created); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

func TestUpdateBusiness(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	created, _ := newTenant(t, repo, ctx)

	updatedAt := createdAt.Add(time.Hour)
	if err := created.Rename("Supermarché Chez Jean", updatedAt); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := created.Deactivate(updatedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if err := repo.Update(ctx, created); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := repo.Get(ctx, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := loaded.Name(); got != "Supermarché Chez Jean" {
		t.Errorf("Name() = %q", got)
	}
	if loaded.IsActive() {
		t.Error("the business is still active after being deactivated")
	}
	if !loaded.CreatedAt().Equal(createdAt) {
		t.Errorf("the update moved CreatedAt to %s", loaded.CreatedAt())
	}
}

func TestUpdateMissingBusiness(t *testing.T) {
	repo, ctx := newBusinessRepository(t)

	absent, err := business.New(business.NewID(), "Nowhere", money.XAF, createdAt)
	if err != nil {
		t.Fatalf("business.New: %v", err)
	}
	if err := repo.Update(ctx, absent); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestCreateAndGetBranch(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	tenant, scope := newTenant(t, repo, ctx)

	branch := newBranch(t, tenant.ID(), "Marché Central")
	if err := repo.CreateBranch(ctx, scope, branch); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	loaded, err := repo.GetBranch(ctx, scope, branch.ID())
	if err != nil {
		t.Fatalf("GetBranch: %v", err)
	}
	if loaded.Snapshot() != branch.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), branch.Snapshot())
	}
}

func TestListBranches(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	tenant, scope := newTenant(t, repo, ctx)

	// Inserted out of order, to prove the ordering comes from the query.
	for _, name := range []string{"Mokolo", "Akwa", "Bonabéri"} {
		if err := repo.CreateBranch(ctx, scope, newBranch(t, tenant.ID(), name)); err != nil {
			t.Fatalf("CreateBranch: %v", err)
		}
	}

	branches, err := repo.ListBranches(ctx, scope)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 3 {
		t.Fatalf("got %d branches, want 3", len(branches))
	}
	for i, want := range []string{"Akwa", "Bonabéri", "Mokolo"} {
		if got := branches[i].Name(); got != want {
			t.Errorf("branch %d = %q, want %q", i, got, want)
		}
	}
}

// TestListBranchesOfAnEmptyBusinessReturnsNothing pins that "no branches" is an
// empty slice rather than nil or an error, so callers need no special case.
func TestListBranchesOfAnEmptyBusinessReturnsNothing(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	_, scope := newTenant(t, repo, ctx)

	branches, err := repo.ListBranches(ctx, scope)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if branches == nil {
		t.Error("ListBranches returned nil, want an empty slice")
	}
	if len(branches) != 0 {
		t.Errorf("got %d branches, want none", len(branches))
	}
}

func TestUpdateBranch(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	tenant, scope := newTenant(t, repo, ctx)

	branch := newBranch(t, tenant.ID(), "Marché Central")
	if err := repo.CreateBranch(ctx, scope, branch); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	if err := branch.Rename("Marché Mokolo", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := repo.UpdateBranch(ctx, scope, branch); err != nil {
		t.Fatalf("UpdateBranch: %v", err)
	}

	loaded, err := repo.GetBranch(ctx, scope, branch.ID())
	if err != nil {
		t.Fatalf("GetBranch: %v", err)
	}
	if got := loaded.Name(); got != "Marché Mokolo" {
		t.Errorf("Name() = %q", got)
	}
}

// TestOneTenantCannotReachAnothersBranches is the property the whole scope
// mechanism exists for, and the reason these tests run against a real database:
// a mock would pass just as happily against a repository that forgot its WHERE
// clause.
func TestOneTenantCannotReachAnothersBranches(t *testing.T) {
	repo, ctx := newBusinessRepository(t)

	tenantA, scopeA := newTenant(t, repo, ctx)
	_, scopeB := newTenant(t, repo, ctx)

	branchOfA := newBranch(t, tenantA.ID(), "Marché Central")
	if err := repo.CreateBranch(ctx, scopeA, branchOfA); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	t.Run("reading it under another tenant finds nothing", func(t *testing.T) {
		// Not found, rather than forbidden: saying "you may not see this"
		// confirms the record exists to someone who may not know of it.
		if _, err := repo.GetBranch(ctx, scopeB, branchOfA.ID()); !errors.Is(err, postgres.ErrNotFound) {
			t.Errorf("got %v, want ErrNotFound", err)
		}
	})

	t.Run("listing under another tenant excludes it", func(t *testing.T) {
		branches, err := repo.ListBranches(ctx, scopeB)
		if err != nil {
			t.Fatalf("ListBranches: %v", err)
		}
		for _, branch := range branches {
			if branch.ID() == branchOfA.ID() {
				t.Error("another tenant's branch appeared in the listing")
			}
		}
	})

	t.Run("updating it under another tenant is refused", func(t *testing.T) {
		if err := branchOfA.Rename("Renamed By B", createdAt.Add(time.Hour)); err != nil {
			t.Fatalf("Rename: %v", err)
		}
		err := repo.UpdateBranch(ctx, scopeB, branchOfA)
		if !errors.Is(err, business.ErrCrossTenant) {
			t.Errorf("got %v, want ErrCrossTenant", err)
		}

		// And the record is untouched.
		loaded, err := repo.GetBranch(ctx, scopeA, branchOfA.ID())
		if err != nil {
			t.Fatalf("GetBranch: %v", err)
		}
		if got := loaded.Name(); got != "Marché Central" {
			t.Errorf("the branch was renamed to %q by another tenant", got)
		}
	})

	t.Run("creating one under another tenant is refused", func(t *testing.T) {
		intruder := newBranch(t, tenantA.ID(), "Planted")
		if err := repo.CreateBranch(ctx, scopeB, intruder); !errors.Is(err, business.ErrCrossTenant) {
			t.Errorf("got %v, want ErrCrossTenant", err)
		}
	})
}

// TestEveryScopedOperationRefusesAnUnsetScope turns a forgotten scope into an
// error rather than an empty result someone has to explain.
func TestEveryScopedOperationRefusesAnUnsetScope(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	tenant, _ := newTenant(t, repo, ctx)
	branch := newBranch(t, tenant.ID(), "Marché Central")

	var unset business.Scope

	operations := map[string]func() error{
		"CreateBranch": func() error { return repo.CreateBranch(ctx, unset, branch) },
		"GetBranch":    func() error { _, err := repo.GetBranch(ctx, unset, branch.ID()); return err },
		"ListBranches": func() error { _, err := repo.ListBranches(ctx, unset); return err },
		"UpdateBranch": func() error { return repo.UpdateBranch(ctx, unset, branch) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

// TestABranchScopedCallerSeesOnlyItsOwnBranch covers the narrower scope a user
// assigned to a branch carries.
func TestABranchScopedCallerSeesOnlyItsOwnBranch(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	tenant, scope := newTenant(t, repo, ctx)

	mine := newBranch(t, tenant.ID(), "Mine")
	theirs := newBranch(t, tenant.ID(), "Theirs")
	for _, branch := range []*business.Branch{mine, theirs} {
		if err := repo.CreateBranch(ctx, scope, branch); err != nil {
			t.Fatalf("CreateBranch: %v", err)
		}
	}

	narrowed, err := scope.WithBranch(mine.ID())
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}

	if _, err := repo.GetBranch(ctx, narrowed, mine.ID()); err != nil {
		t.Errorf("a branch-scoped caller cannot read its own branch: %v", err)
	}

	// Reading a sibling branch is still permitted at the query level, because
	// the branch table is business-wide data; what the narrowed scope governs is
	// the branch's contents. This test records that boundary deliberately, so a
	// later change to it is a decision rather than an accident.
	if _, err := repo.GetBranch(ctx, narrowed, theirs.ID()); err != nil {
		t.Errorf("reading a sibling branch failed unexpectedly: %v", err)
	}
}

func TestCreateBranchRejectsAnUnknownBusiness(t *testing.T) {
	repo, ctx := newBusinessRepository(t)

	absent := business.NewID()
	scope := business.MustNewScope(absent)
	branch := newBranch(t, absent, "Orphan")

	if err := repo.CreateBranch(ctx, scope, branch); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

func TestGetMissingBranch(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	_, scope := newTenant(t, repo, ctx)

	if _, err := repo.GetBranch(ctx, scope, business.NewBranchID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := repo.GetBranch(ctx, scope, business.BranchID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero identifier: got %v, want ErrNotFound", err)
	}
}

func TestUpdateMissingBranch(t *testing.T) {
	repo, ctx := newBusinessRepository(t)
	tenant, scope := newTenant(t, repo, ctx)

	absent := newBranch(t, tenant.ID(), "Never Stored")
	if err := repo.UpdateBranch(ctx, scope, absent); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}
