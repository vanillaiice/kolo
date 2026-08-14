package devices_test

import (
	"encoding/json"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id/idtest"
)

func TestNewIDsAreDistinct(t *testing.T) {
	const count = 500

	seen := make(map[devices.ID]struct{}, count)
	for range count {
		generated := devices.NewID()
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
	tagged := devices.IDFrom(generated)

	if got := tagged.ID(); got != generated {
		t.Errorf("ID() = %s, want %s", got, generated)
	}
	if got, want := tagged.String(), "00000000-0000-7000-8000-000000000001"; got != want {
		t.Errorf("String() = %q, want the deterministic %q", got, want)
	}
	if !devices.IDFrom(id.Nil).IsZero() {
		t.Error("tagging the nil identifier produced a non-zero device identifier")
	}
}

func TestParseID(t *testing.T) {
	deviceID := devices.NewID()

	parsed, err := devices.ParseID(deviceID.String())
	if err != nil {
		t.Fatalf("ParseID: %v", err)
	}
	if parsed != deviceID {
		t.Errorf("round trip gave %s, want %s", parsed, deviceID)
	}
}

func TestParseIDRejectsMalformedInput(t *testing.T) {
	for _, input := range []string{"", "nonsense", "0198c2d4", "0198c2d4-1e00-7000-abab-abababababzz"} {
		t.Run(input, func(t *testing.T) {
			parsed, err := devices.ParseID(input)
			if err == nil {
				t.Errorf("ParseID(%q) succeeded, giving %s", input, parsed)
			}
			if !parsed.IsZero() {
				t.Errorf("returned %s alongside an error", parsed)
			}
		})
	}
}

// TestDeviceIdentifiersDoNotInterchange matters because a device identifier
// appears alongside business and user identifiers in sessions, sync events, and
// audit records, where mixing them would attribute an action to the wrong
// thing.
func TestDeviceIdentifiersDoNotInterchange(t *testing.T) {
	underlying := id.New()

	device := devices.IDFrom(underlying)
	tenant := business.IDFrom(underlying)

	// var wrong business.ID = device   // must not compile

	if device.ID() != tenant.ID() {
		t.Error("the same underlying identifier differed between tags")
	}
	if any(device) == any(tenant) {
		t.Error("device and business identifiers are the same type")
	}
}

func TestIDJSONRoundTrip(t *testing.T) {
	type envelope struct {
		Device devices.ID `json:"device_id"`
	}
	original := envelope{Device: devices.NewID()}

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
