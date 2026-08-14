package authz_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
)

func TestNewSet(t *testing.T) {
	set, err := authz.NewSet(authz.SalesCreate, authz.SalesRefund)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}

	if got := set.Len(); got != 2 {
		t.Errorf("Len() = %d, want 2", got)
	}
	if !set.Has(authz.SalesCreate) || !set.Has(authz.SalesRefund) {
		t.Error("set is missing a permission it was given")
	}
	if set.Has(authz.ReportsFinancial) {
		t.Error("set holds a permission it was never given")
	}
}

func TestNewSetCollapsesDuplicates(t *testing.T) {
	set, err := authz.NewSet(authz.SalesCreate, authz.SalesCreate, authz.SalesCreate)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	if got := set.Len(); got != 1 {
		t.Errorf("Len() = %d, want 1", got)
	}
}

func TestNewSetRejectsUndefinedPermissions(t *testing.T) {
	if _, err := authz.NewSet(authz.SalesCreate, "nonsense"); !errors.Is(err, authz.ErrUnknownPermission) {
		t.Errorf("got %v, want ErrUnknownPermission", err)
	}
}

func TestEmptySet(t *testing.T) {
	// The zero value must behave as an empty set, so a struct field that was
	// never assigned denies everything rather than panicking.
	var zero authz.Set

	if !zero.IsEmpty() || zero.Len() != 0 {
		t.Error("the zero Set is not empty")
	}
	if zero.Has(authz.SalesCreate) {
		t.Error("the zero Set granted a permission")
	}
	if got := zero.All(); len(got) != 0 {
		t.Errorf("All() = %v, want nothing", got)
	}
	if got := zero.String(); got != "authz.Set{}" {
		t.Errorf("String() = %q", got)
	}

	constructed, err := authz.NewSet()
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	if !constructed.Equal(zero) {
		t.Error("an explicitly empty set differs from the zero value")
	}
}

func TestMustNewSet(t *testing.T) {
	if got := authz.MustNewSet(authz.SalesCreate).Len(); got != 1 {
		t.Errorf("Len() = %d, want 1", got)
	}

	defer func() {
		if recover() == nil {
			t.Error("MustNewSet did not panic on an undefined permission")
		}
	}()
	authz.MustNewSet("nonsense")
}

func TestHasAllAndHasAny(t *testing.T) {
	set := authz.MustNewSet(authz.SalesCreate, authz.SalesRefund)

	tests := []struct {
		name        string
		permissions []authz.Permission
		wantAll     bool
		wantAny     bool
	}{
		{"none given", nil, true, false},
		{"one held", []authz.Permission{authz.SalesCreate}, true, true},
		{"all held", []authz.Permission{authz.SalesCreate, authz.SalesRefund}, true, true},
		{"one missing", []authz.Permission{authz.SalesCreate, authz.ReportsFinancial}, false, true},
		{"all missing", []authz.Permission{authz.ReportsFinancial, authz.UsersManage}, false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := set.HasAll(tc.permissions...); got != tc.wantAll {
				t.Errorf("HasAll(%v) = %v, want %v", tc.permissions, got, tc.wantAll)
			}
			if got := set.HasAny(tc.permissions...); got != tc.wantAny {
				t.Errorf("HasAny(%v) = %v, want %v", tc.permissions, got, tc.wantAny)
			}
		})
	}
}

// TestSetOperationsDoNotMutateTheReceiver is the property that keeps one user's
// permission override from leaking into another's.
func TestSetOperationsDoNotMutateTheReceiver(t *testing.T) {
	original := authz.MustNewSet(authz.SalesCreate, authz.SalesRefund)
	snapshot := original.All()

	extended, err := original.With(authz.ReportsFinancial)
	if err != nil {
		t.Fatalf("With: %v", err)
	}
	reduced := original.Without(authz.SalesCreate)
	union := original.Union(authz.MustNewSet(authz.UsersManage))
	intersection := original.Intersect(authz.MustNewSet(authz.SalesCreate))

	if !slices.Equal(original.All(), snapshot) {
		t.Errorf("the receiver changed to %v, want %v", original.All(), snapshot)
	}

	// The derived sets must genuinely differ, or the test above proves nothing.
	for name, derived := range map[string]authz.Set{
		"With":      extended,
		"Without":   reduced,
		"Union":     union,
		"Intersect": intersection,
	} {
		if derived.Equal(original) {
			t.Errorf("%s returned a set equal to the original", name)
		}
	}
}

func TestWith(t *testing.T) {
	base := authz.MustNewSet(authz.SalesCreate)

	extended, err := base.With(authz.SalesRefund, authz.SalesCreate)
	if err != nil {
		t.Fatalf("With: %v", err)
	}
	if !extended.HasAll(authz.SalesCreate, authz.SalesRefund) {
		t.Error("With did not add the permissions")
	}
	if got := extended.Len(); got != 2 {
		t.Errorf("Len() = %d, want 2: adding a held permission is a no-op", got)
	}

	if _, err := base.With("nonsense"); !errors.Is(err, authz.ErrUnknownPermission) {
		t.Errorf("got %v, want ErrUnknownPermission", err)
	}
}

// TestWithoutTolerantOfAbsentPermissions matters because revocations are stored
// per user and may name something the user's role never granted.
func TestWithoutTolerantOfAbsentPermissions(t *testing.T) {
	base := authz.MustNewSet(authz.SalesCreate)

	reduced := base.Without(authz.ReportsFinancial, "nonsense")
	if !reduced.Equal(base) {
		t.Errorf("Without changed the set to %v", reduced.All())
	}

	emptied := base.Without(authz.SalesCreate)
	if !emptied.IsEmpty() {
		t.Errorf("Without left %v, want nothing", emptied.All())
	}
}

func TestUnionAndIntersect(t *testing.T) {
	left := authz.MustNewSet(authz.SalesCreate, authz.SalesRefund)
	right := authz.MustNewSet(authz.SalesRefund, authz.ReportsFinancial)

	union := left.Union(right)
	if !union.HasAll(authz.SalesCreate, authz.SalesRefund, authz.ReportsFinancial) || union.Len() != 3 {
		t.Errorf("Union = %v", union.All())
	}

	intersection := left.Intersect(right)
	if !intersection.Equal(authz.MustNewSet(authz.SalesRefund)) {
		t.Errorf("Intersect = %v, want [sales.refund]", intersection.All())
	}

	// Both operations are commutative.
	if !union.Equal(right.Union(left)) {
		t.Error("Union is not commutative")
	}
	if !intersection.Equal(right.Intersect(left)) {
		t.Error("Intersect is not commutative")
	}

	// And well behaved against the empty set.
	var empty authz.Set
	if !left.Union(empty).Equal(left) {
		t.Error("Union with the empty set changed the set")
	}
	if !left.Intersect(empty).IsEmpty() {
		t.Error("Intersect with the empty set is not empty")
	}
}

func TestEqual(t *testing.T) {
	set := authz.MustNewSet(authz.SalesCreate, authz.SalesRefund)

	// Order of construction must not matter.
	if !set.Equal(authz.MustNewSet(authz.SalesRefund, authz.SalesCreate)) {
		t.Error("sets built in different orders reported unequal")
	}
	if set.Equal(authz.MustNewSet(authz.SalesCreate)) {
		t.Error("a subset reported equal")
	}
	if set.Equal(authz.MustNewSet(authz.SalesCreate, authz.SalesRefund, authz.UsersManage)) {
		t.Error("a superset reported equal")
	}
	// Same size, different members.
	if set.Equal(authz.MustNewSet(authz.SalesCreate, authz.UsersManage)) {
		t.Error("a same-sized set with different members reported equal")
	}
}

// TestAllIsOrderedCanonically keeps stored and synced representations from
// churning: the same set must always serialise identically.
func TestAllIsOrderedCanonically(t *testing.T) {
	forward := authz.MustNewSet(authz.ProductsView, authz.SalesCreate, authz.UsersManage)
	backward := authz.MustNewSet(authz.UsersManage, authz.SalesCreate, authz.ProductsView)

	if !slices.Equal(forward.All(), backward.All()) {
		t.Errorf("order depends on construction: %v vs %v", forward.All(), backward.All())
	}

	// The order must match the registry's.
	registry := authz.All()
	previous := -1
	for _, permission := range forward.All() {
		position := slices.Index(registry, permission)
		if position <= previous {
			t.Errorf("permission %s is out of registry order", permission)
		}
		previous = position
	}
}

func TestString(t *testing.T) {
	set := authz.MustNewSet(authz.SalesCreate, authz.ProductsView)

	got := set.String()
	if !strings.Contains(got, "products.view") || !strings.Contains(got, "sales.create") {
		t.Errorf("String() = %q, want it to name both permissions", got)
	}
	if !strings.HasPrefix(got, "authz.Set{") || !strings.HasSuffix(got, "}") {
		t.Errorf("String() = %q, want it wrapped in authz.Set{...}", got)
	}
}

func TestJSONRoundTrip(t *testing.T) {
	original := authz.MustNewSet(authz.SalesCreate, authz.ProductsView, authz.ReportsFinancial)

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if want := `["products.view","sales.create","reports.financial"]`; string(encoded) != want {
		t.Errorf("Marshal = %s, want %s", encoded, want)
	}

	var decoded authz.Set
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !decoded.Equal(original) {
		t.Errorf("round trip gave %v, want %v", decoded.All(), original.All())
	}
}

func TestMarshalJSONEmitsAnArrayForAnEmptySet(t *testing.T) {
	var empty authz.Set

	encoded, err := json.Marshal(empty)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	// A null here would decode into an unchanged destination, silently keeping
	// whatever permissions were already there.
	if string(encoded) != `[]` {
		t.Errorf("Marshal = %s, want []", encoded)
	}
}

func TestUnmarshalJSONRejectsMalformedInput(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"unknown permission", `["sales.destroy"]`},
		{"empty permission", `[""]`},
		{"one bad among good", `["sales.create","nonsense"]`},
		{"object", `{"sales.create":true}`},
		{"bare string", `"sales.create"`},
		{"numbers", `[1,2]`},
		{"truncated", `["sales.create"`},
		{"not json", `nonsense`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var decoded authz.Set
			if err := json.Unmarshal([]byte(tc.input), &decoded); err == nil {
				t.Errorf("Unmarshal(%s) succeeded, giving %v", tc.input, decoded.All())
			}
		})
	}
}

func TestUnmarshalJSONAcceptsAnEmptyArray(t *testing.T) {
	decoded := authz.MustNewSet(authz.SalesCreate)

	if err := json.Unmarshal([]byte(`[]`), &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !decoded.IsEmpty() {
		t.Errorf("an empty array left %v, want nothing", decoded.All())
	}
}

// TestUnmarshalJSONLeavesTheTargetUntouchedOnFailure keeps a partially decoded
// set from being treated as a real grant.
func TestUnmarshalJSONLeavesTheTargetUntouchedOnFailure(t *testing.T) {
	decoded := authz.MustNewSet(authz.SalesCreate)

	if err := json.Unmarshal([]byte(`["products.view","nonsense"]`), &decoded); err == nil {
		t.Fatal("Unmarshal succeeded, want an error")
	}
	if !decoded.Equal(authz.MustNewSet(authz.SalesCreate)) {
		t.Errorf("a failed decode changed the set to %v", decoded.All())
	}
}

func TestSensitive(t *testing.T) {
	set := authz.MustNewSet(
		authz.ProductsView,    // not sensitive
		authz.SalesCreate,     // not sensitive
		authz.SalesRefund,     // sensitive
		authz.InventoryAdjust, // sensitive
	)

	got := set.Sensitive()
	want := []authz.Permission{authz.InventoryAdjust, authz.SalesRefund}
	if !slices.Equal(got, want) {
		t.Errorf("Sensitive() = %v, want %v", got, want)
	}

	if got := authz.MustNewSet(authz.ProductsView).Sensitive(); len(got) != 0 {
		t.Errorf("Sensitive() = %v, want nothing", got)
	}
}

// TestSensitiveDoesNotDisturbAll guards against the slice-filtering helper
// writing through into a shared backing array.
func TestSensitiveDoesNotDisturbAll(t *testing.T) {
	set := authz.MustNewSet(authz.ProductsView, authz.SalesRefund, authz.UsersManage)
	before := set.All()

	_ = set.Sensitive()

	if !slices.Equal(set.All(), before) {
		t.Errorf("All() changed to %v after Sensitive(), want %v", set.All(), before)
	}
}
