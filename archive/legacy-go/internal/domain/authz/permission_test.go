package authz_test

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
)

func TestAllPermissionsAreWellFormed(t *testing.T) {
	permissions := authz.All()
	if len(permissions) == 0 {
		t.Fatal("no permissions are defined")
	}

	for _, permission := range permissions {
		name := string(permission)

		t.Run(name, func(t *testing.T) {
			if !permission.Defined() {
				t.Error("listed by All but not Defined")
			}
			if name != strings.ToLower(name) {
				t.Errorf("name %q is not lower case", name)
			}
			if strings.TrimSpace(name) != name {
				t.Errorf("name %q has surrounding whitespace", name)
			}
			domain, action, found := strings.Cut(name, ".")
			if !found {
				t.Fatalf("name %q is not in <domain>.<action> form", name)
			}
			if domain == "" || action == "" {
				t.Errorf("name %q has an empty domain or action", name)
			}
			if got := permission.Domain(); got != domain {
				t.Errorf("Domain() = %q, want %q", got, domain)
			}
			if got := permission.String(); got != name {
				t.Errorf("String() = %q, want %q", got, name)
			}
		})
	}
}

func TestAllPermissionsAreUnique(t *testing.T) {
	seen := make(map[authz.Permission]struct{})
	for _, permission := range authz.All() {
		if _, duplicate := seen[permission]; duplicate {
			t.Errorf("permission %s is listed twice", permission)
		}
		seen[permission] = struct{}{}
	}
}

// TestAllReturnsACopy guards the registry: a caller that sorts or truncates the
// result must not corrupt the canonical order every other caller relies on.
func TestAllReturnsACopy(t *testing.T) {
	original := authz.All()

	mutated := authz.All()
	slices.Reverse(mutated)
	mutated[0] = "tampered"

	if !slices.Equal(authz.All(), original) {
		t.Error("mutating the result of All changed the registry")
	}
}

func TestAllIsStablyOrdered(t *testing.T) {
	if !slices.Equal(authz.All(), authz.All()) {
		t.Error("All returned different orders on successive calls")
	}
}

func TestUndefinedPermission(t *testing.T) {
	for _, name := range []string{"", "nonsense", "sales", "sales.", ".create", "SALES.CREATE", "sales.create "} {
		if authz.Permission(name).Defined() {
			t.Errorf("%q reported as defined", name)
		}
	}
}

func TestParsePermission(t *testing.T) {
	parsed, err := authz.ParsePermission("sales.create")
	if err != nil {
		t.Fatalf("ParsePermission: %v", err)
	}
	if parsed != authz.SalesCreate {
		t.Errorf("ParsePermission = %s, want %s", parsed, authz.SalesCreate)
	}
}

func TestParsePermissionRejectsUnknown(t *testing.T) {
	tests := []string{"", "  ", "nonsense", "sales.destroy", "SALES.CREATE", " sales.create"}
	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			parsed, err := authz.ParsePermission(input)
			if !errors.Is(err, authz.ErrUnknownPermission) {
				t.Errorf("got %v, want ErrUnknownPermission", err)
			}
			if parsed != "" {
				t.Errorf("returned %q alongside an error", parsed)
			}
		})
	}
}

// TestEveryPermissionRoundTripsThroughParse checks the registry and the parser
// cannot drift apart.
func TestEveryPermissionRoundTripsThroughParse(t *testing.T) {
	for _, permission := range authz.All() {
		parsed, err := authz.ParsePermission(string(permission))
		if err != nil {
			t.Errorf("ParsePermission(%q): %v", permission, err)
			continue
		}
		if parsed != permission {
			t.Errorf("round trip of %s gave %s", permission, parsed)
		}
	}
}

// TestSensitivePermissionsMatchTheSpecification pins SPECIFICATION.md §39: each
// listed operation must be recognised as requiring an audit record.
func TestSensitivePermissionsMatchTheSpecification(t *testing.T) {
	sensitive := []authz.Permission{
		authz.ProductsPrice,         // product price changed
		authz.InventoryAdjust,       // stock manually adjusted
		authz.SalesRefund,           // sale refunded
		authz.ExpensesCreate,        // expense created
		authz.CustomersCredit,       // customer debt modified
		authz.UsersManage,           // user permission changed
		authz.CashReconcile,         // cash reconciliation performed
		authz.FinanceAccountsManage, // financial accounts altered
	}
	for _, permission := range sensitive {
		if !permission.IsSensitive() {
			t.Errorf("%s is not marked sensitive, but §39 requires an audit record", permission)
		}
	}

	// Plain reads must not be audited, or the audit trail becomes noise.
	for _, permission := range []authz.Permission{
		authz.ProductsView, authz.SalesView, authz.InventoryView,
		authz.ReportsSales, authz.CustomersView, authz.CashView,
	} {
		if permission.IsSensitive() {
			t.Errorf("%s is marked sensitive, but reading is not an audited operation", permission)
		}
	}
}

func TestIsSensitiveIsFalseForUndefinedPermissions(t *testing.T) {
	if authz.Permission("nonsense").IsSensitive() {
		t.Error("an undefined permission reported as sensitive")
	}
}
