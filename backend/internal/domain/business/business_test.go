package business_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
)

var createdAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

func newTestBusiness(t *testing.T) *business.Business {
	t.Helper()
	created, err := business.New(business.NewID(), "Boutique Chez Jean", money.XAF, createdAt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return created
}

func TestNew(t *testing.T) {
	tenant := business.NewID()

	created, err := business.New(tenant, "Boutique Chez Jean", money.XAF, createdAt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if got := created.ID(); got != tenant {
		t.Errorf("ID() = %s, want %s", got, tenant)
	}
	if got := created.Name(); got != "Boutique Chez Jean" {
		t.Errorf("Name() = %q", got)
	}
	if got := created.Currency(); got != money.XAF {
		t.Errorf("Currency() = %s, want XAF", got)
	}
	if !created.IsActive() {
		t.Error("a new business is not active")
	}
	if !created.CreatedAt().Equal(createdAt) || !created.UpdatedAt().Equal(createdAt) {
		t.Errorf("timestamps are %s and %s, want both %s", created.CreatedAt(), created.UpdatedAt(), createdAt)
	}
}

func TestNewNormalisesTheTimestampToUTC(t *testing.T) {
	// A device in Cameroon reports WAT, one hour ahead of UTC.
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	local := time.Date(2026, 8, 14, 10, 30, 0, 0, wat)

	created, err := business.New(business.NewID(), "Boutique", money.XAF, local)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if got := created.CreatedAt().Location(); got != time.UTC {
		t.Errorf("CreatedAt() location = %s, want UTC", got)
	}
	if !created.CreatedAt().Equal(local) {
		t.Errorf("CreatedAt() = %s, want the same instant as %s", created.CreatedAt(), local)
	}
}

func TestNewRejectsInvalidInput(t *testing.T) {
	tenant := business.NewID()

	tests := []struct {
		name     string
		id       business.ID
		business string
		currency money.Currency
		now      time.Time
		want     error
	}{
		{"zero identifier", business.ID{}, "Boutique", money.XAF, createdAt, business.ErrInvalidID},
		{"empty name", tenant, "", money.XAF, createdAt, business.ErrInvalidName},
		{"whitespace name", tenant, "   \t\n ", money.XAF, createdAt, business.ErrInvalidName},
		{"undefined currency", tenant, "Boutique", money.Currency{}, createdAt, business.ErrInvalidCurrency},
		{"zero timestamp", tenant, "Boutique", money.XAF, time.Time{}, business.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			created, err := business.New(tc.id, tc.business, tc.currency, tc.now)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if created != nil {
				t.Error("returned a business alongside an error")
			}
		})
	}
}

func TestNameValidation(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string // empty means the name must be rejected
	}{
		{"plain", "Boutique Chez Jean", "Boutique Chez Jean"},
		{"trimmed", "  Boutique Chez Jean  ", "Boutique Chez Jean"},
		{"accented", "Épicerie Générale", "Épicerie Générale"},
		{"inner spaces kept", "Chez  Jean", "Chez  Jean"},
		{"punctuation", "Jean & Fils (Douala)", "Jean & Fils (Douala)"},
		{"digits", "Boutique 24/7", "Boutique 24/7"},
		{"single character", "J", "J"},
		{"at the length limit", strings.Repeat("é", 120), strings.Repeat("é", 120)},

		{"empty", "", ""},
		{"only whitespace", " \t\r\n ", ""},
		{"past the length limit", strings.Repeat("a", 121), ""},
		{"embedded newline", "Boutique\nChez Jean", ""},
		{"embedded tab", "Boutique\tChez Jean", ""},
		{"nul byte", "Boutique\x00", ""},
		{"bell character", "Boutique\a", ""},
		{"invalid utf-8", "Boutique\xff", ""},

		// Invisible characters make two names render identically while
		// comparing differently, and a bidi override can make a receipt show a
		// name other than the one stored.
		{"left-to-right mark", "Boutique‎", ""},
		{"zero-width space", "Bou​tique", ""},
		{"zero-width joiner", "Bou‍tique", ""},
		{"right-to-left override", "Boutique‮", ""},
		{"private use character", "Boutique", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			created, err := business.New(business.NewID(), tc.input, money.XAF, createdAt)

			if tc.want == "" {
				if !errors.Is(err, business.ErrInvalidName) {
					t.Errorf("got %v, want ErrInvalidName", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if got := created.Name(); got != tc.want {
				t.Errorf("Name() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestNameLengthIsCountedInRunesNotBytes matters for the target market: French
// accents and other multi-byte characters must not cost a business half its
// allowance.
func TestNameLengthIsCountedInRunesNotBytes(t *testing.T) {
	// 120 accented characters is 240 bytes but exactly the rune limit.
	name := strings.Repeat("é", business.MaxNameLength)
	if len(name) <= business.MaxNameLength {
		t.Fatalf("the test name is %d bytes, expected it to exceed the rune limit", len(name))
	}

	if _, err := business.New(business.NewID(), name, money.XAF, createdAt); err != nil {
		t.Errorf("a name at the rune limit was rejected: %v", err)
	}
}

func TestRename(t *testing.T) {
	created := newTestBusiness(t)
	renamedAt := createdAt.Add(time.Hour)

	if err := created.Rename("  Supermarché Chez Jean  ", renamedAt); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	if got := created.Name(); got != "Supermarché Chez Jean" {
		t.Errorf("Name() = %q", got)
	}
	if !created.UpdatedAt().Equal(renamedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", created.UpdatedAt(), renamedAt)
	}
	if !created.CreatedAt().Equal(createdAt) {
		t.Errorf("Rename changed CreatedAt to %s", created.CreatedAt())
	}
}

func TestRenameRejectsInvalidInput(t *testing.T) {
	created := newTestBusiness(t)
	before := created.Name()

	if err := created.Rename("", createdAt.Add(time.Hour)); !errors.Is(err, business.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
	if err := created.Rename("Valid", time.Time{}); !errors.Is(err, business.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}

	// A rejected rename must leave the entity untouched.
	if got := created.Name(); got != before {
		t.Errorf("a failed rename changed the name to %q", got)
	}
	if !created.UpdatedAt().Equal(createdAt) {
		t.Errorf("a failed rename moved UpdatedAt to %s", created.UpdatedAt())
	}
}

func TestDeactivateAndActivate(t *testing.T) {
	created := newTestBusiness(t)
	closedAt := createdAt.Add(24 * time.Hour)

	if err := created.Deactivate(closedAt); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if created.IsActive() {
		t.Error("still active after Deactivate")
	}
	if !created.UpdatedAt().Equal(closedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", created.UpdatedAt(), closedAt)
	}

	reopenedAt := closedAt.Add(24 * time.Hour)
	if err := created.Activate(reopenedAt); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if !created.IsActive() {
		t.Error("not active after Activate")
	}
	if !created.UpdatedAt().Equal(reopenedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", created.UpdatedAt(), reopenedAt)
	}
}

// TestActivationIsIdempotent keeps a replayed sync event from looking like a
// change: applying the same state twice must not move the timestamp.
func TestActivationIsIdempotent(t *testing.T) {
	created := newTestBusiness(t)
	closedAt := createdAt.Add(24 * time.Hour)

	if err := created.Deactivate(closedAt); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if err := created.Deactivate(closedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if !created.UpdatedAt().Equal(closedAt) {
		t.Errorf("a repeated Deactivate moved UpdatedAt to %s, want %s", created.UpdatedAt(), closedAt)
	}

	// Activating an already active business is likewise a no-op.
	fresh := newTestBusiness(t)
	if err := fresh.Activate(createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if !fresh.UpdatedAt().Equal(createdAt) {
		t.Errorf("a redundant Activate moved UpdatedAt to %s", fresh.UpdatedAt())
	}
}

func TestActivationRejectsAZeroTimestamp(t *testing.T) {
	created := newTestBusiness(t)

	if err := created.Deactivate(time.Time{}); !errors.Is(err, business.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if !created.IsActive() {
		t.Error("a rejected Deactivate still took the business out of service")
	}
}

func TestBusinessScopeCoversItsOwnData(t *testing.T) {
	created := newTestBusiness(t)

	scope := created.Scope()
	if !scope.Valid() {
		t.Fatal("a business produced an invalid scope")
	}
	if got := scope.Business(); got != created.ID() {
		t.Errorf("Business() = %s, want %s", got, created.ID())
	}
	if scope.IsBranchScoped() {
		t.Error("a business scope is narrowed to a branch")
	}
	if !scope.Permits(created.ID(), business.BranchID{}) {
		t.Error("a business cannot see its own records")
	}
	if scope.Permits(business.NewID(), business.BranchID{}) {
		t.Error("a business scope permitted another tenant's record")
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	created := newTestBusiness(t)
	if err := created.Rename("Supermarché", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := created.Deactivate(createdAt.Add(2 * time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	restored, err := business.Restore(created.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if restored.Snapshot() != created.Snapshot() {
		t.Errorf("round trip gave %+v, want %+v", restored.Snapshot(), created.Snapshot())
	}
}

// TestRestoreValidatesStoredData covers records written by an older version or
// synced from another device: they get the same checks as new ones, so a broken
// record surfaces at the boundary rather than deep in a calculation.
func TestRestoreValidatesStoredData(t *testing.T) {
	valid := business.Snapshot{
		ID:        business.NewID(),
		Name:      "Boutique",
		Currency:  money.XAF,
		Active:    true,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}

	if _, err := business.Restore(valid); err != nil {
		t.Fatalf("Restore rejected a valid snapshot: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*business.Snapshot)
		want   error
	}{
		{"zero identifier", func(s *business.Snapshot) { s.ID = business.ID{} }, business.ErrInvalidID},
		{"empty name", func(s *business.Snapshot) { s.Name = "" }, business.ErrInvalidName},
		{"control character in name", func(s *business.Snapshot) { s.Name = "Bou\x00tique" }, business.ErrInvalidName},
		{"overlong name", func(s *business.Snapshot) { s.Name = strings.Repeat("a", 121) }, business.ErrInvalidName},
		{"undefined currency", func(s *business.Snapshot) { s.Currency = money.Currency{} }, business.ErrInvalidCurrency},
		{"zero creation time", func(s *business.Snapshot) { s.CreatedAt = time.Time{} }, business.ErrInvalidTime},
		{"zero update time", func(s *business.Snapshot) { s.UpdatedAt = time.Time{} }, business.ErrInvalidTime},
		{
			"update before creation",
			func(s *business.Snapshot) { s.UpdatedAt = s.CreatedAt.Add(-time.Hour) },
			business.ErrInvalidTime,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := valid
			tc.mutate(&snapshot)

			restored, err := business.Restore(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if restored != nil {
				t.Error("returned a business alongside an error")
			}
		})
	}
}

func TestRestoreTrimsAndNormalises(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))

	restored, err := business.Restore(business.Snapshot{
		ID:        business.NewID(),
		Name:      "  Boutique  ",
		Currency:  money.XAF,
		Active:    true,
		CreatedAt: createdAt.In(wat),
		UpdatedAt: createdAt.In(wat),
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if got := restored.Name(); got != "Boutique" {
		t.Errorf("Name() = %q, want %q", got, "Boutique")
	}
	if got := restored.CreatedAt().Location(); got != time.UTC {
		t.Errorf("CreatedAt() location = %s, want UTC", got)
	}
}

// TestSnapshotDoesNotShareStateWithTheEntity keeps a caller holding a snapshot
// from seeing later edits, which would make it useless as a persistence record.
func TestSnapshotDoesNotShareStateWithTheEntity(t *testing.T) {
	created := newTestBusiness(t)
	before := created.Snapshot()

	if err := created.Rename("Something Else", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	if before.Name != "Boutique Chez Jean" {
		t.Errorf("the snapshot changed to %q when the entity was renamed", before.Name)
	}
	if created.Snapshot() == before {
		t.Error("the entity's snapshot did not change after a rename")
	}
}
