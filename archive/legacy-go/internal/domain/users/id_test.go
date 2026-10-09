package users_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id/idtest"
)

func TestNewIDsAreDistinct(t *testing.T) {
	const count = 500

	seen := make(map[users.ID]struct{}, count)
	for range count {
		generated := users.NewID()
		if generated.IsZero() {
			t.Fatal("generated a zero identifier")
		}
		if _, duplicate := seen[generated]; duplicate {
			t.Fatalf("identifier %s generated twice", generated)
		}
		seen[generated] = struct{}{}
	}
}

func TestIDFromTagsAGeneratedIdentifier(t *testing.T) {
	generator := idtest.NewSequence()

	generated, err := generator.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	tagged := users.IDFrom(generated)

	if got := tagged.ID(); got != generated {
		t.Errorf("ID() = %s, want %s", got, generated)
	}
	if got, want := tagged.String(), "00000000-0000-7000-8000-000000000001"; got != want {
		t.Errorf("String() = %q, want the deterministic %q", got, want)
	}
	if users.IDFrom(id.Nil).IsZero() != true {
		t.Error("tagging the nil identifier produced a non-zero user identifier")
	}
}

func TestParseID(t *testing.T) {
	userID := users.NewID()

	parsed, err := users.ParseID(userID.String())
	if err != nil {
		t.Fatalf("ParseID: %v", err)
	}
	if parsed != userID {
		t.Errorf("round trip gave %s, want %s", parsed, userID)
	}
}

func TestParseIDRejectsMalformedInput(t *testing.T) {
	for _, input := range []string{"", "nonsense", "0198c2d4", "0198c2d4-1e00-7000-abab-abababababzz"} {
		t.Run(input, func(t *testing.T) {
			parsed, err := users.ParseID(input)
			if err == nil {
				t.Errorf("ParseID(%q) succeeded, giving %s", input, parsed)
			}
			if !parsed.IsZero() {
				t.Errorf("returned %s alongside an error", parsed)
			}
		})
	}
}

// TestUserIdentifiersDoNotInterchangeWithTenantOnes is the point of tagging: a
// user identifier used where a business identifier is expected would silently
// address the wrong tenant.
func TestUserIdentifiersDoNotInterchangeWithTenantOnes(t *testing.T) {
	underlying := id.New()

	user := users.IDFrom(underlying)
	tenant := business.IDFrom(underlying)

	// var wrong business.ID = user   // must not compile

	if user.ID() != tenant.ID() {
		t.Error("the same underlying identifier differed between tags")
	}
	if any(user) == any(tenant) {
		t.Error("user and business identifiers are the same type")
	}
}

func TestIDJSONRoundTrip(t *testing.T) {
	type envelope struct {
		User users.ID `json:"user_id"`
	}
	original := envelope{User: users.NewID()}

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
