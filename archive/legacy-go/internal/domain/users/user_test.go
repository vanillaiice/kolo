package users_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

var createdAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

func newTestUser(t *testing.T, role authz.Role) (*users.User, business.ID) {
	t.Helper()
	tenant := business.NewID()
	user, err := users.New(users.NewID(), tenant, "Jean Mbarga", role, createdAt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return user, tenant
}

func TestNew(t *testing.T) {
	userID, tenant := users.NewID(), business.NewID()

	user, err := users.New(userID, tenant, "  Jean Mbarga  ", authz.RoleCashier, createdAt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if got := user.ID(); got != userID {
		t.Errorf("ID() = %s, want %s", got, userID)
	}
	if got := user.BusinessID(); got != tenant {
		t.Errorf("BusinessID() = %s, want %s", got, tenant)
	}
	if got := user.Name(); got != "Jean Mbarga" {
		t.Errorf("Name() = %q, want it trimmed", got)
	}
	if got := user.Role(); got != authz.RoleCashier {
		t.Errorf("Role() = %s, want CASHIER", got)
	}
	if !user.IsActive() {
		t.Error("a new user is not active")
	}
	if _, assigned := user.BranchID(); assigned {
		t.Error("a new user is assigned to a branch")
	}
	if !user.CreatedAt().Equal(createdAt) || !user.UpdatedAt().Equal(createdAt) {
		t.Errorf("timestamps are %s and %s, want both %s", user.CreatedAt(), user.UpdatedAt(), createdAt)
	}
}

func TestNewStartsWithTheRoleDefaults(t *testing.T) {
	for _, role := range authz.Roles() {
		t.Run(string(role), func(t *testing.T) {
			user, _ := newTestUser(t, role)

			defaults, ok := authz.DefaultPermissions(role)
			if !ok {
				t.Fatalf("%s has no defaults", role)
			}
			if !user.Permissions().Equal(defaults) {
				t.Errorf("permissions = %v, want the role defaults %v",
					user.Permissions().All(), defaults.All())
			}

			granted, revoked := user.Overrides()
			if !granted.IsEmpty() || !revoked.IsEmpty() {
				t.Errorf("a new user has overrides: granted %v, revoked %v", granted.All(), revoked.All())
			}
		})
	}
}

func TestNewRejectsInvalidInput(t *testing.T) {
	userID, tenant := users.NewID(), business.NewID()

	tests := []struct {
		name     string
		userID   users.ID
		tenant   business.ID
		userName string
		role     authz.Role
		now      time.Time
		want     error
	}{
		{"zero user identifier", users.ID{}, tenant, "Jean", authz.RoleCashier, createdAt, users.ErrInvalidID},
		{"zero business identifier", userID, business.ID{}, "Jean", authz.RoleCashier, createdAt, users.ErrInvalidID},
		{"empty name", userID, tenant, "", authz.RoleCashier, createdAt, users.ErrInvalidName},
		{"whitespace name", userID, tenant, "   ", authz.RoleCashier, createdAt, users.ErrInvalidName},
		{"control character in name", userID, tenant, "Je\x00an", authz.RoleCashier, createdAt, users.ErrInvalidName},
		{"overlong name", userID, tenant, strings.Repeat("a", 121), authz.RoleCashier, createdAt, users.ErrInvalidName},
		{"undefined role", userID, tenant, "Jean", "SUPERUSER", createdAt, users.ErrInvalidRole},
		{"empty role", userID, tenant, "Jean", "", createdAt, users.ErrInvalidRole},
		{"lower-case role", userID, tenant, "Jean", "cashier", createdAt, users.ErrInvalidRole},
		{"zero timestamp", userID, tenant, "Jean", authz.RoleCashier, time.Time{}, users.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			user, err := users.New(tc.userID, tc.tenant, tc.userName, tc.role, tc.now)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if user != nil {
				t.Error("returned a user alongside an error")
			}
		})
	}
}

// TestScopeConfinesTheUserToTheirTenant is the boundary from ADR-008 seen from
// the user's side: whatever identifier a client presents, the user's own scope
// bounds what they can reach.
func TestScopeConfinesTheUserToTheirTenant(t *testing.T) {
	user, tenant := newTestUser(t, authz.RoleManager)
	other := business.NewID()

	scope := user.Scope()
	if got := scope.Business(); got != tenant {
		t.Errorf("Business() = %s, want %s", got, tenant)
	}
	if scope.IsBranchScoped() {
		t.Error("a user with no branch produced a branch-scoped scope")
	}
	if !scope.Permits(tenant, business.BranchID{}) {
		t.Error("a user cannot reach their own business's records")
	}
	if scope.Permits(other, business.BranchID{}) {
		t.Error("a user reached another tenant's records")
	}
	if err := scope.Guard(other, business.BranchID{}); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("Guard across tenants: got %v, want ErrCrossTenant", err)
	}
}

func TestScopeNarrowsWithABranchAssignment(t *testing.T) {
	user, tenant := newTestUser(t, authz.RoleCashier)
	branch, otherBranch := business.NewBranchID(), business.NewBranchID()

	if err := user.AssignToBranch(branch, createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}

	got, assigned := user.BranchID()
	if !assigned || got != branch {
		t.Errorf("BranchID() = %s, %v, want %s, true", got, assigned, branch)
	}

	scope := user.Scope()
	if !scope.IsBranchScoped() {
		t.Fatal("an assigned user produced a business-wide scope")
	}
	if !scope.Permits(tenant, branch) {
		t.Error("the user cannot reach their own branch")
	}
	if scope.Permits(tenant, otherBranch) {
		t.Error("the user reached another branch")
	}
	if !scope.Permits(tenant, business.BranchID{}) {
		t.Error("the user cannot reach business-wide records")
	}
}

func TestBranchAssignment(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	branch := business.NewBranchID()
	assignedAt := createdAt.Add(time.Hour)

	if err := user.AssignToBranch(branch, assignedAt); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}
	if !user.UpdatedAt().Equal(assignedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), assignedAt)
	}

	// Reassigning to the same branch is not a change.
	if err := user.AssignToBranch(branch, assignedAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}
	if !user.UpdatedAt().Equal(assignedAt) {
		t.Errorf("a repeated assignment moved UpdatedAt to %s", user.UpdatedAt())
	}

	unassignedAt := assignedAt.Add(2 * time.Hour)
	if err := user.UnassignBranch(unassignedAt); err != nil {
		t.Fatalf("UnassignBranch: %v", err)
	}
	if _, assigned := user.BranchID(); assigned {
		t.Error("still assigned after UnassignBranch")
	}
	if !user.UpdatedAt().Equal(unassignedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), unassignedAt)
	}

	// Unassigning again is a no-op.
	if err := user.UnassignBranch(unassignedAt.Add(time.Hour)); err != nil {
		t.Fatalf("UnassignBranch: %v", err)
	}
	if !user.UpdatedAt().Equal(unassignedAt) {
		t.Errorf("a repeated unassignment moved UpdatedAt to %s", user.UpdatedAt())
	}
}

func TestBranchAssignmentRejectsInvalidInput(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if err := user.AssignToBranch(business.BranchID{}, createdAt); !errors.Is(err, users.ErrInvalidID) {
		t.Errorf("got %v, want ErrInvalidID", err)
	}
	if err := user.AssignToBranch(business.NewBranchID(), time.Time{}); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := user.UnassignBranch(time.Time{}); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if _, assigned := user.BranchID(); assigned {
		t.Error("a rejected assignment took effect")
	}
}

// TestInactiveUserHoldsNothing is the safety property behind Permissions
// returning an empty set: a caller cannot bypass the account status by reaching
// for the set directly.
func TestInactiveUserHoldsNothing(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleOwner)

	if !user.Can(authz.SalesCreate) {
		t.Fatal("an active owner cannot create sales")
	}

	if err := user.Deactivate(createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	if !user.Permissions().IsEmpty() {
		t.Errorf("a suspended user holds %v", user.Permissions().All())
	}
	for _, permission := range authz.All() {
		if user.Can(permission) {
			t.Errorf("a suspended user can still %s", permission)
		}
	}

	// The configured set still shows what they would regain, for an
	// administration screen.
	if user.ConfiguredPermissions().IsEmpty() {
		t.Error("ConfiguredPermissions is empty for a suspended owner")
	}
	if !user.ConfiguredPermissions().Has(authz.SalesCreate) {
		t.Error("ConfiguredPermissions lost a permission on suspension")
	}

	// Reactivating restores them.
	if err := user.Activate(createdAt.Add(2 * time.Hour)); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if !user.Can(authz.SalesCreate) {
		t.Error("a reactivated owner cannot create sales")
	}
}

func TestAuthorizeDistinguishesSuspensionFromDenial(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if err := user.Authorize(authz.SalesCreate); err != nil {
		t.Errorf("a cashier cannot create sales: %v", err)
	}

	err := user.Authorize(authz.ReportsFinancial)
	if !errors.Is(err, users.ErrForbidden) {
		t.Errorf("got %v, want ErrForbidden", err)
	}
	if !strings.Contains(err.Error(), string(authz.ReportsFinancial)) {
		t.Errorf("error %q does not name the missing permission", err)
	}

	if err := user.Deactivate(createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	// A suspended account reports suspension, not a missing permission, even
	// for something the role would otherwise allow.
	err = user.Authorize(authz.SalesCreate)
	if !errors.Is(err, users.ErrInactive) {
		t.Errorf("got %v, want ErrInactive", err)
	}
	if errors.Is(err, users.ErrForbidden) {
		t.Error("suspension was reported as a missing permission")
	}
}

func TestCashierCannotReadFinancialReports(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if user.Can(authz.ReportsFinancial) {
		t.Error("a cashier can read financial reports, which §3 forbids by default")
	}
}

func TestChangeRole(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	promotedAt := createdAt.Add(time.Hour)

	if err := user.ChangeRole(authz.RoleManager, promotedAt); err != nil {
		t.Fatalf("ChangeRole: %v", err)
	}
	if got := user.Role(); got != authz.RoleManager {
		t.Errorf("Role() = %s, want MANAGER", got)
	}
	if !user.Can(authz.ReportsFinancial) {
		t.Error("a manager cannot read financial reports")
	}
	if !user.UpdatedAt().Equal(promotedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), promotedAt)
	}

	// Setting the same role again is not a change.
	if err := user.ChangeRole(authz.RoleManager, promotedAt.Add(time.Hour)); err != nil {
		t.Fatalf("ChangeRole: %v", err)
	}
	if !user.UpdatedAt().Equal(promotedAt) {
		t.Errorf("a redundant ChangeRole moved UpdatedAt to %s", user.UpdatedAt())
	}
}

func TestChangeRoleRejectsInvalidInput(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if err := user.ChangeRole("SUPERUSER", createdAt); !errors.Is(err, users.ErrInvalidRole) {
		t.Errorf("got %v, want ErrInvalidRole", err)
	}
	if err := user.ChangeRole(authz.RoleOwner, time.Time{}); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if got := user.Role(); got != authz.RoleCashier {
		t.Errorf("a rejected role change took effect, leaving %s", got)
	}
}

// TestChangeRoleKeepsOverrides pins a deliberate choice: a cashier authorised
// to refund who is promoted should not quietly lose that authorisation.
func TestChangeRoleKeepsOverrides(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if err := user.Grant(createdAt.Add(time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := user.Revoke(createdAt.Add(2*time.Hour), authz.CustomersView); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := user.ChangeRole(authz.RoleInventory, createdAt.Add(3*time.Hour)); err != nil {
		t.Fatalf("ChangeRole: %v", err)
	}

	if !user.Can(authz.SalesRefund) {
		t.Error("the grant was lost on a role change")
	}
	if user.Can(authz.CustomersView) {
		t.Error("the revocation was lost on a role change")
	}
	// And the new role's own permissions apply.
	if !user.Can(authz.InventoryReceive) {
		t.Error("the new role's permissions were not applied")
	}
}

func TestGrant(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	grantedAt := createdAt.Add(time.Hour)

	if user.Can(authz.SalesRefund) {
		t.Fatal("a cashier can refund by default")
	}

	if err := user.Grant(grantedAt, authz.SalesRefund, authz.SalesDiscount); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if !user.Can(authz.SalesRefund) || !user.Can(authz.SalesDiscount) {
		t.Error("granted permissions did not take effect")
	}
	if !user.UpdatedAt().Equal(grantedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), grantedAt)
	}

	granted, _ := user.Overrides()
	if !granted.HasAll(authz.SalesRefund, authz.SalesDiscount) {
		t.Errorf("Overrides() granted = %v", granted.All())
	}

	// Granting the same thing again is not a change.
	if err := user.Grant(grantedAt.Add(time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if !user.UpdatedAt().Equal(grantedAt) {
		t.Errorf("a redundant Grant moved UpdatedAt to %s", user.UpdatedAt())
	}
}

func TestRevoke(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleManager)
	revokedAt := createdAt.Add(time.Hour)

	if !user.Can(authz.SalesRefund) {
		t.Fatal("a manager cannot refund by default")
	}

	if err := user.Revoke(revokedAt, authz.SalesRefund); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if user.Can(authz.SalesRefund) {
		t.Error("the revocation did not take effect")
	}
	if !user.UpdatedAt().Equal(revokedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), revokedAt)
	}

	// Revoking again is not a change.
	if err := user.Revoke(revokedAt.Add(time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if !user.UpdatedAt().Equal(revokedAt) {
		t.Errorf("a redundant Revoke moved UpdatedAt to %s", user.UpdatedAt())
	}
}

// TestGrantAndRevokeAreMutuallyExclusive keeps the resulting state
// unambiguous: the last instruction given is the one that holds.
func TestGrantAndRevokeAreMutuallyExclusive(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	at := createdAt.Add(time.Hour)

	if err := user.Revoke(at, authz.SalesRefund); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := user.Grant(at.Add(time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	granted, revoked := user.Overrides()
	if !granted.Has(authz.SalesRefund) {
		t.Error("granting did not record the permission")
	}
	if revoked.Has(authz.SalesRefund) {
		t.Error("granting did not lift the earlier revocation")
	}
	if !user.Can(authz.SalesRefund) {
		t.Error("a grant after a revocation did not take effect")
	}

	// And the other way round.
	if err := user.Revoke(at.Add(2*time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	granted, revoked = user.Overrides()
	if granted.Has(authz.SalesRefund) {
		t.Error("revoking did not withdraw the earlier grant")
	}
	if !revoked.Has(authz.SalesRefund) {
		t.Error("revoking did not record the permission")
	}
	if user.Can(authz.SalesRefund) {
		t.Error("a revocation after a grant did not take effect")
	}
}

func TestGrantAndRevokeRejectInvalidInput(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if err := user.Grant(createdAt, "nonsense"); !errors.Is(err, authz.ErrUnknownPermission) {
		t.Errorf("got %v, want ErrUnknownPermission", err)
	}
	if err := user.Revoke(createdAt, "nonsense"); !errors.Is(err, authz.ErrUnknownPermission) {
		t.Errorf("got %v, want ErrUnknownPermission", err)
	}
	if err := user.Grant(time.Time{}, authz.SalesRefund); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := user.Revoke(time.Time{}, authz.SalesRefund); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}

	granted, revoked := user.Overrides()
	if !granted.IsEmpty() || !revoked.IsEmpty() {
		t.Errorf("a rejected override took effect: granted %v, revoked %v", granted.All(), revoked.All())
	}
}

func TestGrantAndRevokeWithNoPermissionsAreNoOps(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if err := user.Grant(createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := user.Revoke(createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if !user.UpdatedAt().Equal(createdAt) {
		t.Errorf("an empty override moved UpdatedAt to %s", user.UpdatedAt())
	}
}

func TestResetPermissions(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)

	if err := user.Grant(createdAt.Add(time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := user.Revoke(createdAt.Add(2*time.Hour), authz.ProductsView); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	resetAt := createdAt.Add(3 * time.Hour)
	if err := user.ResetPermissions(resetAt); err != nil {
		t.Fatalf("ResetPermissions: %v", err)
	}

	defaults, _ := authz.DefaultPermissions(authz.RoleCashier)
	if !user.Permissions().Equal(defaults) {
		t.Errorf("permissions = %v, want the role defaults %v", user.Permissions().All(), defaults.All())
	}
	granted, revoked := user.Overrides()
	if !granted.IsEmpty() || !revoked.IsEmpty() {
		t.Errorf("overrides survived the reset: granted %v, revoked %v", granted.All(), revoked.All())
	}
	if !user.UpdatedAt().Equal(resetAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), resetAt)
	}

	// Resetting again is a no-op.
	if err := user.ResetPermissions(resetAt.Add(time.Hour)); err != nil {
		t.Fatalf("ResetPermissions: %v", err)
	}
	if !user.UpdatedAt().Equal(resetAt) {
		t.Errorf("a redundant reset moved UpdatedAt to %s", user.UpdatedAt())
	}

	if err := user.ResetPermissions(time.Time{}); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

// TestEvenAnOwnerCanBeBarred confirms the override mechanism reaches every
// role, as §38's configurable matrix requires.
func TestEvenAnOwnerCanBeBarred(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleOwner)

	if err := user.Revoke(createdAt.Add(time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	if user.Can(authz.SalesRefund) {
		t.Error("an owner kept a revoked permission")
	}
	if !user.Can(authz.UsersManage) {
		t.Error("revoking one permission removed an unrelated one")
	}
}

func TestRename(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	renamedAt := createdAt.Add(time.Hour)

	if err := user.Rename("  Marie Ngo  ", renamedAt); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if got := user.Name(); got != "Marie Ngo" {
		t.Errorf("Name() = %q", got)
	}
	if !user.UpdatedAt().Equal(renamedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), renamedAt)
	}

	before := user.Name()
	if err := user.Rename("", renamedAt); !errors.Is(err, users.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
	if err := user.Rename("Valid", time.Time{}); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if got := user.Name(); got != before {
		t.Errorf("a failed rename changed the name to %q", got)
	}
}

func TestDeactivateAndActivate(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	suspendedAt := createdAt.Add(time.Hour)

	if err := user.Deactivate(suspendedAt); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if user.IsActive() {
		t.Error("still active after Deactivate")
	}

	// Repeating it must not look like a fresh change.
	if err := user.Deactivate(suspendedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if !user.UpdatedAt().Equal(suspendedAt) {
		t.Errorf("a repeated Deactivate moved UpdatedAt to %s", user.UpdatedAt())
	}

	restoredAt := suspendedAt.Add(48 * time.Hour)
	if err := user.Activate(restoredAt); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if !user.IsActive() {
		t.Error("not active after Activate")
	}
	if !user.UpdatedAt().Equal(restoredAt) {
		t.Errorf("UpdatedAt() = %s, want %s", user.UpdatedAt(), restoredAt)
	}

	if err := user.Deactivate(time.Time{}); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := user.Activate(time.Time{}); !errors.Is(err, users.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestNewNormalisesTheTimestampToUTC(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	local := time.Date(2026, 8, 14, 10, 30, 0, 0, wat)

	user, err := users.New(users.NewID(), business.NewID(), "Jean", authz.RoleCashier, local)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if got := user.CreatedAt().Location(); got != time.UTC {
		t.Errorf("CreatedAt() location = %s, want UTC", got)
	}
	if !user.CreatedAt().Equal(local) {
		t.Errorf("CreatedAt() = %s, want the same instant as %s", user.CreatedAt(), local)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	if err := user.AssignToBranch(business.NewBranchID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}
	if err := user.Grant(createdAt.Add(2*time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := user.Revoke(createdAt.Add(3*time.Hour), authz.CustomersView); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := user.Deactivate(createdAt.Add(4 * time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	restored, err := users.Restore(user.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	assertSameUser(t, restored, user)
}

func TestRestoreValidatesStoredData(t *testing.T) {
	valid := users.Snapshot{
		ID:         users.NewID(),
		BusinessID: business.NewID(),
		Name:       "Jean Mbarga",
		Role:       authz.RoleCashier,
		Active:     true,
		CreatedAt:  createdAt,
		UpdatedAt:  createdAt,
	}

	if _, err := users.Restore(valid); err != nil {
		t.Fatalf("Restore rejected a valid snapshot: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*users.Snapshot)
		want   error
	}{
		{"zero user identifier", func(s *users.Snapshot) { s.ID = users.ID{} }, users.ErrInvalidID},
		{"zero business identifier", func(s *users.Snapshot) { s.BusinessID = business.ID{} }, users.ErrInvalidID},
		{"empty name", func(s *users.Snapshot) { s.Name = "  " }, users.ErrInvalidName},
		{"invisible character in name", func(s *users.Snapshot) { s.Name = "Je​an" }, users.ErrInvalidName},
		{"undefined role", func(s *users.Snapshot) { s.Role = "SUPERUSER" }, users.ErrInvalidRole},
		{"empty role", func(s *users.Snapshot) { s.Role = "" }, users.ErrInvalidRole},
		{"zero creation time", func(s *users.Snapshot) { s.CreatedAt = time.Time{} }, users.ErrInvalidTime},
		{"zero update time", func(s *users.Snapshot) { s.UpdatedAt = time.Time{} }, users.ErrInvalidTime},
		{
			"update before creation",
			func(s *users.Snapshot) { s.UpdatedAt = s.CreatedAt.Add(-time.Second) },
			users.ErrInvalidTime,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := valid
			tc.mutate(&snapshot)

			restored, err := users.Restore(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if restored != nil {
				t.Error("returned a user alongside an error")
			}
		})
	}
}

// TestRestoreRejectsAnUnknownRoleRatherThanGrantingNothing is a deliberate
// choice: a user who mysteriously cannot do their job is harder to diagnose
// than a record that refuses to load.
func TestRestoreRejectsAnUnknownRoleRatherThanGrantingNothing(t *testing.T) {
	restored, err := users.Restore(users.Snapshot{
		ID:         users.NewID(),
		BusinessID: business.NewID(),
		Name:       "Jean",
		Role:       "SUPERUSER",
		Active:     true,
		CreatedAt:  createdAt,
		UpdatedAt:  createdAt,
	})
	if !errors.Is(err, users.ErrInvalidRole) {
		t.Errorf("got %v, want ErrInvalidRole", err)
	}
	if restored != nil {
		t.Error("returned a user with an unrecognised role")
	}
}

func TestRestoreCarriesOverrides(t *testing.T) {
	restored, err := users.Restore(users.Snapshot{
		ID:         users.NewID(),
		BusinessID: business.NewID(),
		Name:       "Jean",
		Role:       authz.RoleCashier,
		Granted:    authz.MustNewSet(authz.SalesRefund),
		Revoked:    authz.MustNewSet(authz.ProductsView),
		Active:     true,
		CreatedAt:  createdAt,
		UpdatedAt:  createdAt,
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if !restored.Can(authz.SalesRefund) {
		t.Error("a stored grant was lost")
	}
	if restored.Can(authz.ProductsView) {
		t.Error("a stored revocation was lost")
	}
}

// TestSnapshotDoesNotShareStateWithTheEntity keeps a snapshot usable as a
// persistence record: it must not change under the caller's feet.
func TestSnapshotDoesNotShareStateWithTheEntity(t *testing.T) {
	user, _ := newTestUser(t, authz.RoleCashier)
	before := user.Snapshot()

	if err := user.Rename("Marie Ngo", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := user.Grant(createdAt.Add(2*time.Hour), authz.SalesRefund); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	if before.Name != "Jean Mbarga" {
		t.Errorf("the snapshot's name changed to %q", before.Name)
	}
	if before.Granted.Has(authz.SalesRefund) {
		t.Error("the snapshot's overrides changed when the entity was granted a permission")
	}
}

func assertSameUser(t *testing.T, got, want *users.User) {
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
