package business_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id/idtest"
)

func TestNewIDsAreDistinct(t *testing.T) {
	const count = 500

	businesses := make(map[business.ID]struct{}, count)
	branches := make(map[business.BranchID]struct{}, count)
	for range count {
		tenant, branch := business.NewID(), business.NewBranchID()

		if tenant.IsZero() || branch.IsZero() {
			t.Fatal("generated a zero identifier")
		}
		if _, duplicate := businesses[tenant]; duplicate {
			t.Fatalf("business identifier %s generated twice", tenant)
		}
		if _, duplicate := branches[branch]; duplicate {
			t.Fatalf("branch identifier %s generated twice", branch)
		}
		businesses[tenant] = struct{}{}
		branches[branch] = struct{}{}
	}
}

// TestIDFromTagsAGeneratedIdentifier covers the path a service takes: draw from
// the injected generator, then tag, so tests can supply a known sequence.
func TestIDFromTagsAGeneratedIdentifier(t *testing.T) {
	generator := idtest.NewSequence()

	first, err := generator.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	second, err := generator.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	tenant := business.IDFrom(first)
	branch := business.BranchIDFrom(second)

	if got := tenant.ID(); got != first {
		t.Errorf("ID() = %s, want %s", got, first)
	}
	if got := branch.ID(); got != second {
		t.Errorf("ID() = %s, want %s", got, second)
	}
	if got, want := tenant.String(), "00000000-0000-7000-8000-000000000001"; got != want {
		t.Errorf("String() = %q, want the deterministic %q", got, want)
	}
}

func TestIDFromTheNilIdentifierIsZero(t *testing.T) {
	if !business.IDFrom(id.Nil).IsZero() {
		t.Error("tagging the nil identifier produced a non-zero business identifier")
	}
	if !business.BranchIDFrom(id.Nil).IsZero() {
		t.Error("tagging the nil identifier produced a non-zero branch identifier")
	}
}

func TestParseID(t *testing.T) {
	tenant := business.NewID()

	parsed, err := business.ParseID(tenant.String())
	if err != nil {
		t.Fatalf("ParseID: %v", err)
	}
	if parsed != tenant {
		t.Errorf("ParseID round trip gave %s, want %s", parsed, tenant)
	}

	branch := business.NewBranchID()
	parsedBranch, err := business.ParseBranchID(branch.String())
	if err != nil {
		t.Fatalf("ParseBranchID: %v", err)
	}
	if parsedBranch != branch {
		t.Errorf("ParseBranchID round trip gave %s, want %s", parsedBranch, branch)
	}
}

func TestParseIDRejectsMalformedInput(t *testing.T) {
	for _, input := range []string{"", "nonsense", "0198c2d4", "0198c2d4-1e00-7000-abab-abababababzz"} {
		t.Run(input, func(t *testing.T) {
			tenant, err := business.ParseID(input)
			if err == nil {
				t.Errorf("ParseID(%q) succeeded, giving %s", input, tenant)
			}
			if !tenant.IsZero() {
				t.Errorf("ParseID returned %s alongside an error", tenant)
			}

			branch, err := business.ParseBranchID(input)
			if err == nil {
				t.Errorf("ParseBranchID(%q) succeeded, giving %s", input, branch)
			}
			if !branch.IsZero() {
				t.Errorf("ParseBranchID returned %s alongside an error", branch)
			}
		})
	}
}

// TestBusinessAndBranchIdentifiersDoNotInterchange is the point of tagging
// them: a branch identifier must not be usable where a business identifier is
// expected, since that would silently address the wrong tenant.
func TestBusinessAndBranchIdentifiersDoNotInterchange(t *testing.T) {
	underlying := id.New()

	tenant := business.IDFrom(underlying)
	branch := business.BranchIDFrom(underlying)

	// var wrong business.ID = branch    // must not compile

	if tenant.ID() != branch.ID() {
		t.Error("the same underlying identifier differed between tags")
	}
	if any(tenant) == any(branch) {
		t.Error("business and branch identifiers are the same type")
	}
}

func TestIdentifiersJSONRoundTrip(t *testing.T) {
	type envelope struct {
		Business business.ID       `json:"business_id"`
		Branch   business.BranchID `json:"branch_id"`
	}
	original := envelope{Business: business.NewID(), Branch: business.NewBranchID()}

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded envelope
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded != original {
		t.Errorf("round trip gave %+v, want %+v", decoded, original)
	}
}
