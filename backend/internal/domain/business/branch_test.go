package business_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
)

func newTestBranch(t *testing.T, tenant business.ID) *business.Branch {
	t.Helper()
	branch, err := business.NewBranch(business.NewBranchID(), tenant, "Marché Central", createdAt)
	if err != nil {
		t.Fatalf("NewBranch: %v", err)
	}
	return branch
}

func TestNewBranch(t *testing.T) {
	tenant := business.NewID()
	branchID := business.NewBranchID()

	branch, err := business.NewBranch(branchID, tenant, "Marché Central", createdAt)
	if err != nil {
		t.Fatalf("NewBranch: %v", err)
	}

	if got := branch.ID(); got != branchID {
		t.Errorf("ID() = %s, want %s", got, branchID)
	}
	if got := branch.BusinessID(); got != tenant {
		t.Errorf("BusinessID() = %s, want %s", got, tenant)
	}
	if got := branch.Name(); got != "Marché Central" {
		t.Errorf("Name() = %q", got)
	}
	if !branch.IsActive() {
		t.Error("a new branch is not active")
	}
	if !branch.CreatedAt().Equal(createdAt) || !branch.UpdatedAt().Equal(createdAt) {
		t.Errorf("timestamps are %s and %s, want both %s", branch.CreatedAt(), branch.UpdatedAt(), createdAt)
	}
}

func TestNewBranchRejectsInvalidInput(t *testing.T) {
	tenant := business.NewID()
	branchID := business.NewBranchID()

	tests := []struct {
		name     string
		branchID business.BranchID
		tenant   business.ID
		label    string
		now      time.Time
		want     error
	}{
		{"zero branch identifier", business.BranchID{}, tenant, "Marché", createdAt, business.ErrInvalidID},
		{"zero business identifier", branchID, business.ID{}, "Marché", createdAt, business.ErrInvalidID},
		{"empty name", branchID, tenant, "", createdAt, business.ErrInvalidName},
		{"control character in name", branchID, tenant, "Mar\nché", createdAt, business.ErrInvalidName},
		{"overlong name", branchID, tenant, strings.Repeat("a", 121), createdAt, business.ErrInvalidName},
		{"zero timestamp", branchID, tenant, "Marché", time.Time{}, business.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			branch, err := business.NewBranch(tc.branchID, tc.tenant, tc.label, tc.now)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if branch != nil {
				t.Error("returned a branch alongside an error")
			}
		})
	}
}

// TestBranchScopeIsNarrowedToItself is what makes stock and devices per-branch
// once multi-branch ships.
func TestBranchScopeIsNarrowedToItself(t *testing.T) {
	tenant := business.NewID()
	branch := newTestBranch(t, tenant)
	other := newTestBranch(t, tenant)

	scope := branch.Scope()
	if !scope.Valid() {
		t.Fatal("a branch produced an invalid scope")
	}
	if got := scope.Business(); got != tenant {
		t.Errorf("Business() = %s, want %s", got, tenant)
	}
	if got, ok := scope.Branch(); !ok || got != branch.ID() {
		t.Errorf("Branch() = %s, %v, want %s, true", got, ok, branch.ID())
	}

	if !scope.Permits(tenant, branch.ID()) {
		t.Error("a branch cannot see its own records")
	}
	if scope.Permits(tenant, other.ID()) {
		t.Error("a branch scope permitted another branch's records")
	}
	if !scope.Permits(tenant, business.BranchID{}) {
		t.Error("a branch scope cannot see business-wide records")
	}
	if scope.Permits(business.NewID(), branch.ID()) {
		t.Error("a branch scope permitted another tenant's records")
	}
}

func TestBranchRename(t *testing.T) {
	branch := newTestBranch(t, business.NewID())
	renamedAt := createdAt.Add(time.Hour)

	if err := branch.Rename("  Marché Mokolo  ", renamedAt); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if got := branch.Name(); got != "Marché Mokolo" {
		t.Errorf("Name() = %q", got)
	}
	if !branch.UpdatedAt().Equal(renamedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", branch.UpdatedAt(), renamedAt)
	}

	before := branch.Name()
	if err := branch.Rename("", renamedAt); !errors.Is(err, business.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
	if err := branch.Rename("Valid", time.Time{}); !errors.Is(err, business.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if got := branch.Name(); got != before {
		t.Errorf("a failed rename changed the name to %q", got)
	}
}

func TestBranchDeactivateAndActivate(t *testing.T) {
	branch := newTestBranch(t, business.NewID())
	closedAt := createdAt.Add(24 * time.Hour)

	if err := branch.Deactivate(closedAt); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if branch.IsActive() {
		t.Error("still active after Deactivate")
	}

	// Repeating it must not look like a fresh change.
	if err := branch.Deactivate(closedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if !branch.UpdatedAt().Equal(closedAt) {
		t.Errorf("a repeated Deactivate moved UpdatedAt to %s", branch.UpdatedAt())
	}

	reopenedAt := closedAt.Add(48 * time.Hour)
	if err := branch.Activate(reopenedAt); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if !branch.IsActive() {
		t.Error("not active after Activate")
	}
	if !branch.UpdatedAt().Equal(reopenedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", branch.UpdatedAt(), reopenedAt)
	}

	if err := branch.Deactivate(time.Time{}); !errors.Is(err, business.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestBranchSnapshotRoundTrip(t *testing.T) {
	branch := newTestBranch(t, business.NewID())
	if err := branch.Rename("Marché Mokolo", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := branch.Deactivate(createdAt.Add(2 * time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	restored, err := business.RestoreBranch(branch.Snapshot())
	if err != nil {
		t.Fatalf("RestoreBranch: %v", err)
	}
	if restored.Snapshot() != branch.Snapshot() {
		t.Errorf("round trip gave %+v, want %+v", restored.Snapshot(), branch.Snapshot())
	}
}

func TestRestoreBranchValidatesStoredData(t *testing.T) {
	valid := business.BranchSnapshot{
		ID:         business.NewBranchID(),
		BusinessID: business.NewID(),
		Name:       "Marché Central",
		Active:     true,
		CreatedAt:  createdAt,
		UpdatedAt:  createdAt,
	}

	if _, err := business.RestoreBranch(valid); err != nil {
		t.Fatalf("RestoreBranch rejected a valid snapshot: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*business.BranchSnapshot)
		want   error
	}{
		{"zero branch identifier", func(s *business.BranchSnapshot) { s.ID = business.BranchID{} }, business.ErrInvalidID},
		{"zero business identifier", func(s *business.BranchSnapshot) { s.BusinessID = business.ID{} }, business.ErrInvalidID},
		{"empty name", func(s *business.BranchSnapshot) { s.Name = "  " }, business.ErrInvalidName},
		{"control character in name", func(s *business.BranchSnapshot) { s.Name = "Mar\tché" }, business.ErrInvalidName},
		{"zero creation time", func(s *business.BranchSnapshot) { s.CreatedAt = time.Time{} }, business.ErrInvalidTime},
		{"zero update time", func(s *business.BranchSnapshot) { s.UpdatedAt = time.Time{} }, business.ErrInvalidTime},
		{
			"update before creation",
			func(s *business.BranchSnapshot) { s.UpdatedAt = s.CreatedAt.Add(-time.Second) },
			business.ErrInvalidTime,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := valid
			tc.mutate(&snapshot)

			restored, err := business.RestoreBranch(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if restored != nil {
				t.Error("returned a branch alongside an error")
			}
		})
	}
}

// TestABranchBelongsToExactlyOneBusiness guards the hierarchy §42 describes:
// two businesses may each have a branch, and neither may reach the other's.
func TestABranchBelongsToExactlyOneBusiness(t *testing.T) {
	tenantA, tenantB := business.NewID(), business.NewID()
	branchA := newTestBranch(t, tenantA)
	branchB := newTestBranch(t, tenantB)

	if branchA.Scope().Permits(tenantB, branchB.ID()) {
		t.Error("a branch of business A permitted a branch of business B")
	}
	if branchB.Scope().Permits(tenantA, branchA.ID()) {
		t.Error("a branch of business B permitted a branch of business A")
	}

	// A business-wide scope over A sees A's branch but never B's.
	scopeA := business.MustNewScope(tenantA)
	if !scopeA.Permits(tenantA, branchA.ID()) {
		t.Error("business A cannot see its own branch")
	}
	if scopeA.Permits(tenantB, branchB.ID()) {
		t.Error("business A can see business B's branch")
	}
}
