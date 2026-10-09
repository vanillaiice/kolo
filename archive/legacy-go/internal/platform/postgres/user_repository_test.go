package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

func newUserRepository(t *testing.T) (*postgres.UserRepository, *postgres.BusinessRepository, context.Context) {
	t.Helper()
	pool := pgtest.Pool(t)
	return postgres.NewUserRepository(pool), postgres.NewBusinessRepository(pool), context.Background()
}

func newUser(t *testing.T, tenant business.ID, name string, role authz.Role) *users.User {
	t.Helper()
	record, err := users.New(users.NewID(), tenant, name, role, createdAt)
	if err != nil {
		t.Fatalf("users.New: %v", err)
	}
	return record
}

func TestCreateAndGetUser(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleCashier)
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	assertSameStoredUser(t, loaded, created)
}

// TestPermissionOverridesSurviveARoundTrip is the interesting part of this
// mapping: the two override lists become a PostgreSQL text[] and must come back
// as the same sets.
func TestPermissionOverridesSurviveARoundTrip(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleCashier)
	if err := created.Grant(createdAt.Add(time.Hour), authz.SalesRefund, authz.ReportsSales); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := created.Revoke(createdAt.Add(2*time.Hour), authz.CustomersView); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if !loaded.Can(authz.SalesRefund) {
		t.Error("a granted permission was lost in storage")
	}
	if loaded.Can(authz.CustomersView) {
		t.Error("a revoked permission came back granted")
	}
	if !loaded.Permissions().Equal(created.Permissions()) {
		t.Errorf("permissions = %v, want %v", loaded.Permissions().All(), created.Permissions().All())
	}
}

// TestAUserWithNoOverridesStoresEmptyLists guards the difference between an
// empty array and NULL, which would fail to scan.
func TestAUserWithNoOverridesStoresEmptyLists(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleManager)
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	granted, revoked := loaded.Overrides()
	if !granted.IsEmpty() || !revoked.IsEmpty() {
		t.Errorf("overrides came back as granted %v, revoked %v; want both empty",
			granted.All(), revoked.All())
	}
	defaults, _ := authz.DefaultPermissions(authz.RoleManager)
	if !loaded.Permissions().Equal(defaults) {
		t.Error("a user with no overrides did not come back with the role defaults")
	}
}

func TestUserBranchAssignmentSurvivesARoundTrip(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	branch := newBranch(t, tenant.ID(), "Marché Central")
	if err := businesses.CreateBranch(ctx, scope, branch); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	created := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleCashier)
	if err := created.AssignToBranch(branch.ID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	got, assigned := loaded.BranchID()
	if !assigned || got != branch.ID() {
		t.Errorf("BranchID() = %s, %v; want %s, true", got, assigned, branch.ID())
	}

	// And unassigning stores NULL rather than a zero UUID.
	if err := created.UnassignBranch(createdAt.Add(2 * time.Hour)); err != nil {
		t.Fatalf("UnassignBranch: %v", err)
	}
	if err := repo.Update(ctx, scope, created); err != nil {
		t.Fatalf("Update: %v", err)
	}
	reloaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, assigned := reloaded.BranchID(); assigned {
		t.Error("the user is still assigned to a branch after being unassigned")
	}
}

func TestUpdateUser(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleCashier)
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := created.Rename("Marie Ngo", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := created.ChangeRole(authz.RoleManager, createdAt.Add(2*time.Hour)); err != nil {
		t.Fatalf("ChangeRole: %v", err)
	}
	if err := created.Deactivate(createdAt.Add(3 * time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if err := repo.Update(ctx, scope, created); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := loaded.Name(); got != "Marie Ngo" {
		t.Errorf("Name() = %q", got)
	}
	if got := loaded.Role(); got != authz.RoleManager {
		t.Errorf("Role() = %s, want MANAGER", got)
	}
	if loaded.IsActive() {
		t.Error("the user is still active after being deactivated")
	}
	// A suspended user holds nothing, straight out of storage.
	if !loaded.Permissions().IsEmpty() {
		t.Errorf("a suspended user came back holding %v", loaded.Permissions().All())
	}
}

func TestListUsers(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	for _, name := range []string{"Yves", "Alice", "Marie"} {
		if err := repo.Create(ctx, scope, newUser(t, tenant.ID(), name, authz.RoleCashier)); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	found, err := repo.List(ctx, scope)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(found) != 3 {
		t.Fatalf("got %d users, want 3", len(found))
	}
	for i, want := range []string{"Alice", "Marie", "Yves"} {
		if got := found[i].Name(); got != want {
			t.Errorf("user %d = %q, want %q", i, got, want)
		}
	}
}

// TestListingUnderABranchScopeExcludesOtherBranches records the rule stated on
// the method: a branch-scoped caller sees their own branch's staff plus those
// who work across the whole business, and no one else's roster.
func TestListingUnderABranchScopeExcludesOtherBranches(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	mine := newBranch(t, tenant.ID(), "Mine")
	theirs := newBranch(t, tenant.ID(), "Theirs")
	for _, branch := range []*business.Branch{mine, theirs} {
		if err := businesses.CreateBranch(ctx, scope, branch); err != nil {
			t.Fatalf("CreateBranch: %v", err)
		}
	}

	businessWide := newUser(t, tenant.ID(), "Owner", authz.RoleOwner)
	atMine := newUser(t, tenant.ID(), "Mine Cashier", authz.RoleCashier)
	atTheirs := newUser(t, tenant.ID(), "Theirs Cashier", authz.RoleCashier)
	if err := atMine.AssignToBranch(mine.ID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}
	if err := atTheirs.AssignToBranch(theirs.ID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}
	for _, record := range []*users.User{businessWide, atMine, atTheirs} {
		if err := repo.Create(ctx, scope, record); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	narrowed, err := scope.WithBranch(mine.ID())
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}
	found, err := repo.List(ctx, narrowed)
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	seen := make(map[users.ID]bool, len(found))
	for _, record := range found {
		seen[record.ID()] = true
	}
	if !seen[atMine.ID()] {
		t.Error("the branch's own staff are missing")
	}
	if !seen[businessWide.ID()] {
		t.Error("business-wide staff are missing")
	}
	if seen[atTheirs.ID()] {
		t.Error("another branch's staff appeared")
	}
}

// TestOneTenantCannotReachAnothersUsers is the isolation boundary again, this
// time over the table that decides who may do what.
func TestOneTenantCannotReachAnothersUsers(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)

	tenantA, scopeA := newTenant(t, businesses, ctx)
	_, scopeB := newTenant(t, businesses, ctx)

	userOfA := newUser(t, tenantA.ID(), "Jean Mbarga", authz.RoleOwner)
	if err := repo.Create(ctx, scopeA, userOfA); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := repo.Get(ctx, scopeB, userOfA.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("reading across tenants: got %v, want ErrNotFound", err)
	}

	found, err := repo.List(ctx, scopeB)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, record := range found {
		if record.ID() == userOfA.ID() {
			t.Error("another tenant's user appeared in the listing")
		}
	}

	// Escalating another tenant's user must be refused outright.
	if err := userOfA.Rename("Compromised", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := repo.Update(ctx, scopeB, userOfA); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("updating across tenants: got %v, want ErrCrossTenant", err)
	}
	planted := newUser(t, tenantA.ID(), "Planted", authz.RoleOwner)
	if err := repo.Create(ctx, scopeB, planted); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("creating across tenants: got %v, want ErrCrossTenant", err)
	}

	// And the original is untouched.
	loaded, err := repo.Get(ctx, scopeA, userOfA.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := loaded.Name(); got != "Jean Mbarga" {
		t.Errorf("the user was renamed to %q by another tenant", got)
	}
}

func TestEveryUserOperationRefusesAnUnsetScope(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, _ := newTenant(t, businesses, ctx)
	record := newUser(t, tenant.ID(), "Jean", authz.RoleCashier)

	var unset business.Scope

	operations := map[string]func() error{
		"Create": func() error { return repo.Create(ctx, unset, record) },
		"Get":    func() error { _, err := repo.Get(ctx, unset, record.ID()); return err },
		"List":   func() error { _, err := repo.List(ctx, unset); return err },
		"Update": func() error { return repo.Update(ctx, unset, record) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestGetMissingUser(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	_, scope := newTenant(t, businesses, ctx)

	if _, err := repo.Get(ctx, scope, users.NewID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := repo.Get(ctx, scope, users.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero identifier: got %v, want ErrNotFound", err)
	}
}

func TestUpdateMissingUser(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	absent := newUser(t, tenant.ID(), "Never Stored", authz.RoleCashier)
	if err := repo.Update(ctx, scope, absent); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestCreateUserTwiceConflicts(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	record := newUser(t, tenant.ID(), "Jean", authz.RoleCashier)
	if err := repo.Create(ctx, scope, record); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.Create(ctx, scope, record); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// TestAUserCannotBeStoredAgainstAnotherTenantsBranch checks the composite key
// from migration 2 through real code. The scope guard cannot catch this — as
// far as it can see, the user belongs to the right business — so the database
// is the only thing standing in the way.
func TestAUserCannotBeStoredAgainstAnotherTenantsBranch(t *testing.T) {
	repo, businesses, ctx := newUserRepository(t)

	tenantA, scopeA := newTenant(t, businesses, ctx)
	tenantB, scopeB := newTenant(t, businesses, ctx)

	branchOfB := newBranch(t, tenantB.ID(), "Theirs")
	if err := businesses.CreateBranch(ctx, scopeB, branchOfB); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	intruder := newUser(t, tenantA.ID(), "Jean", authz.RoleCashier)
	if err := intruder.AssignToBranch(branchOfB.ID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}

	if err := repo.Create(ctx, scopeA, intruder); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict from the composite foreign key", err)
	}
}

// TestReadingAUserWithAnUnknownPermissionFails covers a permission removed in a
// later version leaving rows behind. Refusing to load is deliberate: silently
// dropping it would change what someone may do without anyone deciding to.
func TestReadingAUserWithAnUnknownPermissionFails(t *testing.T) {
	pool := pgtest.Pool(t)
	repo := postgres.NewUserRepository(pool)
	businesses := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	tenant, scope := newTenant(t, businesses, ctx)

	record := newUser(t, tenant.ID(), "Jean", authz.RoleCashier)
	if err := repo.Create(ctx, scope, record); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// The schema stores permission names as free text, so a name the system no
	// longer defines is storable.
	_, err := pool.Exec(ctx, `UPDATE users SET granted = ARRAY['sales.teleport'] WHERE id = $1`,
		record.ID().ID())
	if err != nil {
		t.Fatalf("planting the unknown permission: %v", err)
	}

	if _, err := repo.Get(ctx, scope, record.ID()); !errors.Is(err, authz.ErrUnknownPermission) {
		t.Errorf("got %v, want ErrUnknownPermission", err)
	}

	// The same must hold for the revoked list.
	if _, err := pool.Exec(ctx, `
		UPDATE users SET granted = '{}', revoked = ARRAY['sales.teleport'] WHERE id = $1`,
		record.ID().ID()); err != nil {
		t.Fatalf("planting the unknown permission: %v", err)
	}
	if _, err := repo.Get(ctx, scope, record.ID()); !errors.Is(err, authz.ErrUnknownPermission) {
		t.Errorf("revoked list: got %v, want ErrUnknownPermission", err)
	}
}

func assertSameStoredUser(t *testing.T, got, want *users.User) {
	t.Helper()

	gotSnapshot, wantSnapshot := got.Snapshot(), want.Snapshot()
	if gotSnapshot.ID != wantSnapshot.ID ||
		gotSnapshot.BusinessID != wantSnapshot.BusinessID ||
		gotSnapshot.BranchID != wantSnapshot.BranchID ||
		gotSnapshot.Name != wantSnapshot.Name ||
		gotSnapshot.Role != wantSnapshot.Role ||
		gotSnapshot.Active != wantSnapshot.Active ||
		!gotSnapshot.CreatedAt.Equal(wantSnapshot.CreatedAt) ||
		!gotSnapshot.UpdatedAt.Equal(wantSnapshot.UpdatedAt) {
		t.Errorf("scalar fields differ:\n got %+v\nwant %+v", gotSnapshot, wantSnapshot)
	}
	if !gotSnapshot.Granted.Equal(wantSnapshot.Granted) {
		t.Errorf("granted = %v, want %v", gotSnapshot.Granted.All(), wantSnapshot.Granted.All())
	}
	if !gotSnapshot.Revoked.Equal(wantSnapshot.Revoked) {
		t.Errorf("revoked = %v, want %v", gotSnapshot.Revoked.All(), wantSnapshot.Revoked.All())
	}
}
