package authz_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
)

func TestRolesAreWellFormed(t *testing.T) {
	roles := authz.Roles()
	if len(roles) != 5 {
		t.Fatalf("got %d roles, want the 5 named in §38: %v", len(roles), roles)
	}

	want := []authz.Role{
		authz.RoleOwner, authz.RoleManager, authz.RoleCashier,
		authz.RoleInventory, authz.RoleAccountant,
	}
	if !slices.Equal(roles, want) {
		t.Errorf("Roles() = %v, want %v", roles, want)
	}

	for _, role := range roles {
		if !role.Defined() {
			t.Errorf("%s is listed by Roles but not Defined", role)
		}
		if got := role.String(); got != string(role) {
			t.Errorf("String() = %q, want %q", got, role)
		}
	}
}

func TestRolesReturnsACopy(t *testing.T) {
	original := authz.Roles()

	mutated := authz.Roles()
	slices.Reverse(mutated)
	mutated[0] = "tampered"

	if !slices.Equal(authz.Roles(), original) {
		t.Error("mutating the result of Roles changed the registry")
	}
}

func TestParseRole(t *testing.T) {
	parsed, err := authz.ParseRole("CASHIER")
	if err != nil {
		t.Fatalf("ParseRole: %v", err)
	}
	if parsed != authz.RoleCashier {
		t.Errorf("ParseRole = %s, want %s", parsed, authz.RoleCashier)
	}

	for _, input := range []string{"", "cashier", "Cashier", "OWNER ", "SUPERUSER"} {
		t.Run(input, func(t *testing.T) {
			parsed, err := authz.ParseRole(input)
			if !errors.Is(err, authz.ErrUnknownRole) {
				t.Errorf("got %v, want ErrUnknownRole", err)
			}
			if parsed != "" {
				t.Errorf("returned %q alongside an error", parsed)
			}
		})
	}
}

func TestEveryRoleRoundTripsThroughParse(t *testing.T) {
	for _, role := range authz.Roles() {
		parsed, err := authz.ParseRole(string(role))
		if err != nil {
			t.Errorf("ParseRole(%q): %v", role, err)
			continue
		}
		if parsed != role {
			t.Errorf("round trip of %s gave %s", role, parsed)
		}
	}
}

func TestEveryRoleHasDefaultPermissions(t *testing.T) {
	for _, role := range authz.Roles() {
		permissions, ok := authz.DefaultPermissions(role)
		if !ok {
			t.Errorf("%s has no default permissions", role)
			continue
		}
		if permissions.IsEmpty() {
			t.Errorf("%s defaults to no permissions at all", role)
		}
		// Every default must be a permission the system actually defines.
		for _, permission := range permissions.All() {
			if !permission.Defined() {
				t.Errorf("%s defaults include the undefined permission %q", role, permission)
			}
		}
	}
}

// TestUnknownRoleGrantsNothing is the safe-by-default property: a role value
// that storage or an old client produced must deny, not grant.
func TestUnknownRoleGrantsNothing(t *testing.T) {
	permissions, ok := authz.DefaultPermissions("SUPERUSER")
	if ok {
		t.Error("an undefined role reported as known")
	}
	if !permissions.IsEmpty() {
		t.Errorf("an undefined role granted %v", permissions.All())
	}
	if permissions.Has(authz.SalesCreate) {
		t.Error("an undefined role granted sales.create")
	}
}

// TestOwnerHasEveryPermission must hold as new permissions are added: the owner
// needs visibility into the entire business (§3).
func TestOwnerHasEveryPermission(t *testing.T) {
	permissions, ok := authz.DefaultPermissions(authz.RoleOwner)
	if !ok {
		t.Fatal("OWNER has no default permissions")
	}

	for _, permission := range authz.All() {
		if !permissions.Has(permission) {
			t.Errorf("OWNER is missing %s", permission)
		}
	}
	if got, want := permissions.Len(), len(authz.All()); got != want {
		t.Errorf("OWNER holds %d permissions, want all %d", got, want)
	}
}

// TestCashierDoesNotGetFinancialReports pins the one exclusion §3 and §38 state
// outright.
func TestCashierDoesNotGetFinancialReports(t *testing.T) {
	permissions, ok := authz.DefaultPermissions(authz.RoleCashier)
	if !ok {
		t.Fatal("CASHIER has no default permissions")
	}

	if permissions.Has(authz.ReportsFinancial) {
		t.Error("CASHIER defaults include reports.financial, which §3 forbids")
	}
}

// TestRoleDefaultsMatchTheirDescriptions checks each role against what §3 and
// §38 say it is for, in both directions.
func TestRoleDefaultsMatchTheirDescriptions(t *testing.T) {
	tests := []struct {
		role        authz.Role
		mustHave    []authz.Permission
		mustNotHave []authz.Permission
	}{
		{
			// "Operations + selected reports", but not user administration.
			role: authz.RoleManager,
			mustHave: []authz.Permission{
				authz.ProductsEdit, authz.InventoryAdjust, authz.SalesCreate,
				authz.SalesRefund, authz.CustomersCredit, authz.PurchasesCreate,
				authz.ReportsSales, authz.ReportsFinancial, authz.CashReconcile,
			},
			mustNotHave: []authz.Permission{
				authz.UsersManage, authz.BusinessSettings, authz.FinanceAccountsManage,
			},
		},
		{
			// "POS + assigned operations." Refunds are "if authorized", so they
			// are granted per user rather than by default.
			role: authz.RoleCashier,
			mustHave: []authz.Permission{
				authz.SalesCreate, authz.SalesViewOwn, authz.ProductsView, authz.CustomersView,
			},
			mustNotHave: []authz.Permission{
				authz.SalesRefund, authz.ReportsFinancial, authz.InventoryAdjust,
				authz.ProductsPrice, authz.UsersManage, authz.ExpensesCreate,
				authz.CashReconcile, authz.SalesView,
			},
		},
		{
			// "Inventory + products", without sales or financial information.
			role: authz.RoleInventory,
			mustHave: []authz.Permission{
				authz.ProductsCreate, authz.ProductsEdit, authz.InventoryReceive,
				authz.InventoryAdjust, authz.InventoryCount, authz.ReportsInventory,
			},
			mustNotHave: []authz.Permission{
				authz.SalesCreate, authz.SalesRefund, authz.ReportsFinancial,
				authz.ReportsSales, authz.CashReconcile, authz.ExpensesCreate,
				authz.ProductsPrice, authz.UsersManage,
			},
		},
		{
			// "Financial information": reads operations, records expenses, but
			// does not sell or move stock.
			role: authz.RoleAccountant,
			mustHave: []authz.Permission{
				authz.ReportsFinancial, authz.FinanceAccountsView, authz.ExpensesCreate,
				authz.CashView, authz.SalesView, authz.AuditView,
			},
			mustNotHave: []authz.Permission{
				authz.SalesCreate, authz.SalesRefund, authz.InventoryAdjust,
				authz.ProductsCreate, authz.UsersManage, authz.CashReconcile,
			},
		},
	}
	for _, tc := range tests {
		t.Run(string(tc.role), func(t *testing.T) {
			permissions, ok := authz.DefaultPermissions(tc.role)
			if !ok {
				t.Fatalf("%s has no default permissions", tc.role)
			}
			for _, permission := range tc.mustHave {
				if !permissions.Has(permission) {
					t.Errorf("%s is missing %s", tc.role, permission)
				}
			}
			for _, permission := range tc.mustNotHave {
				if permissions.Has(permission) {
					t.Errorf("%s unexpectedly has %s", tc.role, permission)
				}
			}
		})
	}
}

// TestOnlyTheOwnerAdministersUsersByDefault checks the boundary that keeps a
// business from losing control of its own account.
func TestOnlyTheOwnerAdministersUsersByDefault(t *testing.T) {
	for _, role := range authz.Roles() {
		permissions, ok := authz.DefaultPermissions(role)
		if !ok {
			t.Fatalf("%s has no default permissions", role)
		}
		if got := permissions.Has(authz.UsersManage); got != (role == authz.RoleOwner) {
			t.Errorf("%s has users.manage = %v, want %v", role, got, role == authz.RoleOwner)
		}
		if got := permissions.Has(authz.BusinessSettings); got != (role == authz.RoleOwner) {
			t.Errorf("%s has business.settings = %v, want %v", role, got, role == authz.RoleOwner)
		}
	}
}

// TestDefaultPermissionsCannotBeMutatedByCallers guards the shared matrix: a
// caller deriving a user's permissions must not alter the defaults every other
// user of that role inherits.
func TestDefaultPermissionsCannotBeMutatedByCallers(t *testing.T) {
	before, ok := authz.DefaultPermissions(authz.RoleCashier)
	if !ok {
		t.Fatal("CASHIER has no default permissions")
	}
	snapshot := before.All()

	extended, err := before.With(authz.ReportsFinancial)
	if err != nil {
		t.Fatalf("With: %v", err)
	}
	_ = extended.Without(authz.SalesCreate)

	after, _ := authz.DefaultPermissions(authz.RoleCashier)
	if !slices.Equal(after.All(), snapshot) {
		t.Errorf("CASHIER defaults changed to %v, want %v", after.All(), snapshot)
	}
	if after.Has(authz.ReportsFinancial) {
		t.Error("deriving a set leaked reports.financial into the CASHIER defaults")
	}
}

func TestResolve(t *testing.T) {
	tests := []struct {
		name        string
		role        authz.Role
		granted     authz.Set
		revoked     authz.Set
		mustHave    []authz.Permission
		mustNotHave []authz.Permission
	}{
		{
			name:     "role defaults with no overrides",
			role:     authz.RoleCashier,
			mustHave: []authz.Permission{authz.SalesCreate},
			// Refunds are not a cashier default.
			mustNotHave: []authz.Permission{authz.SalesRefund},
		},
		{
			name:     "a cashier authorised to refund",
			role:     authz.RoleCashier,
			granted:  authz.MustNewSet(authz.SalesRefund),
			mustHave: []authz.Permission{authz.SalesCreate, authz.SalesRefund},
		},
		{
			name:        "a manager barred from refunds",
			role:        authz.RoleManager,
			revoked:     authz.MustNewSet(authz.SalesRefund),
			mustHave:    []authz.Permission{authz.SalesCreate},
			mustNotHave: []authz.Permission{authz.SalesRefund},
		},
		{
			name:        "revocation beats a grant of the same permission",
			role:        authz.RoleCashier,
			granted:     authz.MustNewSet(authz.SalesRefund),
			revoked:     authz.MustNewSet(authz.SalesRefund),
			mustNotHave: []authz.Permission{authz.SalesRefund},
		},
		{
			name:        "even the owner can be barred from an operation",
			role:        authz.RoleOwner,
			revoked:     authz.MustNewSet(authz.SalesRefund),
			mustHave:    []authz.Permission{authz.UsersManage},
			mustNotHave: []authz.Permission{authz.SalesRefund},
		},
		{
			name:        "revoking something the role never had is harmless",
			role:        authz.RoleCashier,
			revoked:     authz.MustNewSet(authz.ReportsFinancial),
			mustHave:    []authz.Permission{authz.SalesCreate},
			mustNotHave: []authz.Permission{authz.ReportsFinancial},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resolved, err := authz.Resolve(tc.role, tc.granted, tc.revoked)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			for _, permission := range tc.mustHave {
				if !resolved.Has(permission) {
					t.Errorf("resolved set is missing %s", permission)
				}
			}
			for _, permission := range tc.mustNotHave {
				if resolved.Has(permission) {
					t.Errorf("resolved set unexpectedly has %s", permission)
				}
			}
		})
	}
}

func TestResolveRejectsAnUnknownRole(t *testing.T) {
	var none authz.Set

	resolved, err := authz.Resolve("SUPERUSER", none, none)
	if !errors.Is(err, authz.ErrUnknownRole) {
		t.Errorf("got %v, want ErrUnknownRole", err)
	}
	if !resolved.IsEmpty() {
		t.Errorf("returned %v alongside an error", resolved.All())
	}
}

// TestResolveIsPure checks that resolving one user's permissions cannot affect
// the inputs, which are shared across users.
func TestResolveIsPure(t *testing.T) {
	granted := authz.MustNewSet(authz.SalesRefund)
	revoked := authz.MustNewSet(authz.SalesDiscount)
	grantedBefore, revokedBefore := granted.All(), revoked.All()

	first, err := authz.Resolve(authz.RoleCashier, granted, revoked)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	second, err := authz.Resolve(authz.RoleCashier, granted, revoked)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if !first.Equal(second) {
		t.Error("Resolve is not deterministic")
	}
	if !slices.Equal(granted.All(), grantedBefore) {
		t.Errorf("Resolve mutated the granted set to %v", granted.All())
	}
	if !slices.Equal(revoked.All(), revokedBefore) {
		t.Errorf("Resolve mutated the revoked set to %v", revoked.All())
	}
}

// TestResolveWithZeroValueOverrides covers the common path: most users have no
// overrides at all, and the zero Set must work there without ceremony.
func TestResolveWithZeroValueOverrides(t *testing.T) {
	var granted, revoked authz.Set

	resolved, err := authz.Resolve(authz.RoleManager, granted, revoked)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	defaults, _ := authz.DefaultPermissions(authz.RoleManager)
	if !resolved.Equal(defaults) {
		t.Errorf("resolved to %v, want the role defaults %v", resolved.All(), defaults.All())
	}
}

// TestResolveCanGrantEveryPermission checks there is no permission the override
// mechanism cannot reach, since §38 requires the matrix to be configurable.
func TestResolveCanGrantEveryPermission(t *testing.T) {
	everything := authz.MustNewSet(authz.All()...)
	var none authz.Set

	for _, role := range authz.Roles() {
		resolved, err := authz.Resolve(role, everything, none)
		if err != nil {
			t.Fatalf("Resolve(%s): %v", role, err)
		}
		if got, want := resolved.Len(), len(authz.All()); got != want {
			t.Errorf("%s granted everything holds %d permissions, want %d", role, got, want)
		}
	}
}

// TestResolveCanRevokeEveryPermission is the mirror: a user can be reduced to
// nothing, which is what suspending an account amounts to.
func TestResolveCanRevokeEveryPermission(t *testing.T) {
	everything := authz.MustNewSet(authz.All()...)
	var none authz.Set

	for _, role := range authz.Roles() {
		resolved, err := authz.Resolve(role, none, everything)
		if err != nil {
			t.Fatalf("Resolve(%s): %v", role, err)
		}
		if !resolved.IsEmpty() {
			t.Errorf("%s revoked everything still holds %v", role, resolved.All())
		}
	}
}

// TestEffectiveIsTotalAndFailsClosed covers the form entities use once their
// role is already validated: it cannot report an error, so an unrecognised role
// must contribute nothing rather than everything.
func TestEffectiveIsTotalAndFailsClosed(t *testing.T) {
	var none authz.Set

	unknown := authz.Effective("SUPERUSER", none, none)
	if !unknown.IsEmpty() {
		t.Errorf("an unrecognised role resolved to %v, want nothing", unknown.All())
	}

	// Explicit grants still apply, because they were configured deliberately;
	// only the role's own contribution is missing.
	granted := authz.Effective("SUPERUSER", authz.MustNewSet(authz.SalesCreate), none)
	if !granted.Equal(authz.MustNewSet(authz.SalesCreate)) {
		t.Errorf("resolved to %v, want just the granted permission", granted.All())
	}
}

// TestEffectiveAgreesWithResolve keeps the two entry points from drifting: they
// must apply overrides in the same order.
func TestEffectiveAgreesWithResolve(t *testing.T) {
	granted := authz.MustNewSet(authz.SalesRefund, authz.ReportsFinancial)
	revoked := authz.MustNewSet(authz.SalesRefund, authz.ProductsView)

	for _, role := range authz.Roles() {
		resolved, err := authz.Resolve(role, granted, revoked)
		if err != nil {
			t.Fatalf("Resolve(%s): %v", role, err)
		}
		if effective := authz.Effective(role, granted, revoked); !effective.Equal(resolved) {
			t.Errorf("%s: Effective = %v, Resolve = %v", role, effective.All(), resolved.All())
		}
	}
}
