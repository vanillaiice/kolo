package business_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
)

func TestNewScope(t *testing.T) {
	tenant := business.NewID()

	scope, err := business.NewScope(tenant)
	if err != nil {
		t.Fatalf("NewScope: %v", err)
	}

	if !scope.Valid() {
		t.Error("scope reported invalid")
	}
	if got := scope.Business(); got != tenant {
		t.Errorf("Business() = %s, want %s", got, tenant)
	}
	if _, narrowed := scope.Branch(); narrowed {
		t.Error("a business scope reported itself branch-scoped")
	}
	if scope.IsBranchScoped() {
		t.Error("IsBranchScoped() = true for a business scope")
	}
}

func TestNewScopeRejectsAZeroBusiness(t *testing.T) {
	var unset business.ID

	scope, err := business.NewScope(unset)
	if !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("got %v, want ErrNoTenant", err)
	}
	if scope.Valid() {
		t.Error("returned a valid scope alongside an error")
	}
}

// TestZeroScopePermitsNothing is the safety property that matters most: a
// struct field nobody assigned must deny access, not grant it.
func TestZeroScopePermitsNothing(t *testing.T) {
	var unset business.Scope
	tenant, branch := business.NewID(), business.NewBranchID()

	if unset.Valid() {
		t.Error("the zero Scope reported valid")
	}
	if unset.Permits(tenant, branch) {
		t.Error("the zero Scope permitted a record")
	}
	if unset.Permits(tenant, business.BranchID{}) {
		t.Error("the zero Scope permitted a business-wide record")
	}
	// Notably, it must not permit records that are themselves unset.
	if unset.Permits(business.ID{}, business.BranchID{}) {
		t.Error("the zero Scope permitted an unowned record")
	}
	if err := unset.Guard(tenant, branch); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("Guard on the zero Scope: got %v, want ErrNoTenant", err)
	}
	if got := unset.String(); got != "business.Scope{invalid}" {
		t.Errorf("String() = %q", got)
	}
}

func TestMustNewScope(t *testing.T) {
	if !business.MustNewScope(business.NewID()).Valid() {
		t.Error("MustNewScope produced an invalid scope")
	}

	defer func() {
		if recover() == nil {
			t.Error("MustNewScope did not panic on a zero business")
		}
	}()
	business.MustNewScope(business.ID{})
}

func TestWithBranch(t *testing.T) {
	tenant := business.NewID()
	branch := business.NewBranchID()
	scope := business.MustNewScope(tenant)

	narrowed, err := scope.WithBranch(branch)
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}

	if got, ok := narrowed.Branch(); !ok || got != branch {
		t.Errorf("Branch() = %s, %v, want %s, true", got, ok, branch)
	}
	if got := narrowed.Business(); got != tenant {
		t.Errorf("narrowing changed the business to %s", got)
	}

	// The original must be unchanged: scopes are values, and one caller
	// narrowing must not affect another holding the same scope.
	if scope.IsBranchScoped() {
		t.Error("WithBranch mutated the receiver")
	}
}

func TestWithBranchReplacesRatherThanIntersects(t *testing.T) {
	scope := business.MustNewScope(business.NewID())
	first, second := business.NewBranchID(), business.NewBranchID()

	narrowed, err := scope.WithBranch(first)
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}
	renarrowed, err := narrowed.WithBranch(second)
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}

	if got, _ := renarrowed.Branch(); got != second {
		t.Errorf("Branch() = %s, want %s", got, second)
	}
}

func TestWithBranchRejectsInvalidInput(t *testing.T) {
	var unset business.Scope
	if _, err := unset.WithBranch(business.NewBranchID()); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("narrowing the zero Scope: got %v, want ErrNoTenant", err)
	}

	scope := business.MustNewScope(business.NewID())
	if _, err := scope.WithBranch(business.BranchID{}); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("narrowing to a zero branch: got %v, want ErrNoTenant", err)
	}
}

func TestWithoutBranch(t *testing.T) {
	tenant := business.NewID()
	scope := business.MustNewScope(tenant)

	narrowed, err := scope.WithBranch(business.NewBranchID())
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}
	widened := narrowed.WithoutBranch()

	if widened.IsBranchScoped() {
		t.Error("WithoutBranch left the scope branch-scoped")
	}
	if !widened.Equal(scope) {
		t.Errorf("widened to %s, want %s", widened, scope)
	}
	if !narrowed.IsBranchScoped() {
		t.Error("WithoutBranch mutated the receiver")
	}
}

// TestPermitsAcrossTenants is the isolation boundary itself, checked
// exhaustively over the combinations a request can present.
func TestPermitsAcrossTenants(t *testing.T) {
	tenantA, tenantB := business.NewID(), business.NewID()
	branchOne, branchTwo := business.NewBranchID(), business.NewBranchID()
	var noBranch business.BranchID

	businessScope := business.MustNewScope(tenantA)
	branchScope, err := businessScope.WithBranch(branchOne)
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}

	tests := []struct {
		name           string
		scope          business.Scope
		recordBusiness business.ID
		recordBranch   business.BranchID
		want           bool
	}{
		{"own business, own branch", businessScope, tenantA, branchOne, true},
		{"own business, other branch", businessScope, tenantA, branchTwo, true},
		{"own business, no branch", businessScope, tenantA, noBranch, true},
		{"other business", businessScope, tenantB, branchOne, false},
		{"other business, no branch", businessScope, tenantB, noBranch, false},
		{"unowned record", businessScope, business.ID{}, noBranch, false},

		{"branch scope, matching branch", branchScope, tenantA, branchOne, true},
		{"branch scope, other branch", branchScope, tenantA, branchTwo, false},
		{"branch scope, business-wide record", branchScope, tenantA, noBranch, true},
		{"branch scope, other business", branchScope, tenantB, branchOne, false},
		{"branch scope, other business same branch id", branchScope, tenantB, branchOne, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.scope.Permits(tc.recordBusiness, tc.recordBranch); got != tc.want {
				t.Errorf("Permits = %v, want %v", got, tc.want)
			}

			err := tc.scope.Guard(tc.recordBusiness, tc.recordBranch)
			if tc.want && err != nil {
				t.Errorf("Guard = %v, want nil", err)
			}
			if !tc.want && !errors.Is(err, business.ErrCrossTenant) {
				t.Errorf("Guard = %v, want ErrCrossTenant", err)
			}
		})
	}
}

// TestGuardNamesBothTenants matters for diagnosis: a cross-tenant error must
// say what was asked for and what was found.
func TestGuardNamesBothTenants(t *testing.T) {
	tenantA, tenantB := business.NewID(), business.NewID()
	scope := business.MustNewScope(tenantA)

	err := scope.Guard(tenantB, business.BranchID{})
	if err == nil {
		t.Fatal("Guard succeeded across tenants")
	}
	message := err.Error()
	if !strings.Contains(message, tenantA.String()) {
		t.Errorf("error %q does not name the scope's business", message)
	}
	if !strings.Contains(message, tenantB.String()) {
		t.Errorf("error %q does not name the record's business", message)
	}
}

// TestTwoBusinessesNeverSeeEachOther restates §43's requirement directly, over
// many generated tenants rather than a single pair.
func TestTwoBusinessesNeverSeeEachOther(t *testing.T) {
	const count = 50

	scopes := make([]business.Scope, count)
	tenants := make([]business.ID, count)
	for i := range count {
		tenants[i] = business.NewID()
		scopes[i] = business.MustNewScope(tenants[i])
	}

	for i, scope := range scopes {
		for j, tenant := range tenants {
			permitted := scope.Permits(tenant, business.BranchID{})
			if want := i == j; permitted != want {
				t.Fatalf("scope %d permits tenant %d = %v, want %v", i, j, permitted, want)
			}
		}
	}
}

func TestScopeEquality(t *testing.T) {
	tenant := business.NewID()
	branch := business.NewBranchID()

	first := business.MustNewScope(tenant)
	second := business.MustNewScope(tenant)
	if !first.Equal(second) {
		t.Error("scopes over the same business reported unequal")
	}

	narrowed, err := first.WithBranch(branch)
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}
	if first.Equal(narrowed) {
		t.Error("a business scope compared equal to a branch scope")
	}
	if first.Equal(business.MustNewScope(business.NewID())) {
		t.Error("scopes over different businesses compared equal")
	}

	var unset business.Scope
	if first.Equal(unset) {
		t.Error("a valid scope compared equal to the zero Scope")
	}
	if !unset.Equal(business.Scope{}) {
		t.Error("two zero Scopes compared unequal")
	}
}

func TestScopeString(t *testing.T) {
	tenant := business.NewID()
	branch := business.NewBranchID()
	scope := business.MustNewScope(tenant)

	if got := scope.String(); !strings.Contains(got, tenant.String()) {
		t.Errorf("String() = %q, want it to name the business", got)
	}

	narrowed, err := scope.WithBranch(branch)
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}
	got := narrowed.String()
	if !strings.Contains(got, tenant.String()) || !strings.Contains(got, branch.String()) {
		t.Errorf("String() = %q, want it to name both business and branch", got)
	}
}

// TestScopeIsUsableAsAMapKey covers a shape services will reach for when
// grouping work per tenant.
func TestScopeIsUsableAsAMapKey(t *testing.T) {
	first := business.MustNewScope(business.NewID())
	second := business.MustNewScope(business.NewID())

	counts := map[business.Scope]int{first: 1, second: 2}
	counts[first]++

	if got := counts[first]; got != 2 {
		t.Errorf("counts[first] = %d, want 2", got)
	}
	if len(counts) != 2 {
		t.Errorf("map holds %d entries, want 2", len(counts))
	}
}

// TestScopeOfIsTotalAndFailsClosed covers the form entities use to expose their
// own scope: it cannot report an error, so a missing business must yield a
// scope that permits nothing rather than one that permits everything.
func TestScopeOfIsTotalAndFailsClosed(t *testing.T) {
	tenant, branch := business.NewID(), business.NewBranchID()

	wide := business.ScopeOf(tenant, business.BranchID{})
	if !wide.Valid() || wide.IsBranchScoped() {
		t.Errorf("ScopeOf with no branch gave %s, want a business-wide scope", wide)
	}
	if !wide.Equal(business.MustNewScope(tenant)) {
		t.Errorf("ScopeOf gave %s, want the same as NewScope", wide)
	}

	narrow := business.ScopeOf(tenant, branch)
	if got, ok := narrow.Branch(); !ok || got != branch {
		t.Errorf("Branch() = %s, %v, want %s, true", got, ok, branch)
	}

	// A missing business denies everything, including when a branch is given.
	for _, scope := range []business.Scope{
		business.ScopeOf(business.ID{}, business.BranchID{}),
		business.ScopeOf(business.ID{}, branch),
	} {
		if scope.Valid() {
			t.Errorf("ScopeOf with no business gave the valid scope %s", scope)
		}
		if scope.Permits(tenant, branch) || scope.Permits(business.ID{}, business.BranchID{}) {
			t.Errorf("a scope with no business permitted a record")
		}
	}
}
