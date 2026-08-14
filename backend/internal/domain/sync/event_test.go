package sync_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

var occurredAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

func valid() sync.Envelope {
	return sync.Envelope{
		ID:             sync.NewEventID(),
		BusinessID:     business.NewID(),
		DeviceID:       devices.NewID(),
		UserID:         users.NewID(),
		Type:           sync.StockMoved,
		Payload:        json.RawMessage(`{"movements":[{"product_id":"abc","quantity":-3000}]}`),
		OccurredAt:     occurredAt,
		DeviceSequence: 1,
	}
}

func TestNewKeepsWhatItWasGiven(t *testing.T) {
	envelope := valid()

	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if got := event.ID(); got != envelope.ID {
		t.Errorf("ID() = %s, want %s", got, envelope.ID)
	}
	if got := event.BusinessID(); got != envelope.BusinessID {
		t.Errorf("BusinessID() = %s", got)
	}
	if got := event.DeviceID(); got != envelope.DeviceID {
		t.Errorf("DeviceID() = %s", got)
	}
	if got := event.UserID(); got != envelope.UserID {
		t.Errorf("UserID() = %s", got)
	}
	if got := event.Type(); got != sync.StockMoved {
		t.Errorf("Type() = %s", got)
	}
	if got := event.DeviceSequence(); got != 1 {
		t.Errorf("DeviceSequence() = %d", got)
	}
	if !event.OccurredAt().Equal(occurredAt) {
		t.Errorf("OccurredAt() = %s", event.OccurredAt())
	}
	if event.Envelope().ID != envelope.ID {
		t.Error("Envelope() did not round-trip the identifier")
	}
}

func TestNewRejectsInvalidEnvelopes(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*sync.Envelope)
		want   error
	}{
		{"no event id", func(e *sync.Envelope) { e.ID = sync.EventID{} }, sync.ErrInvalidID},
		{"no business", func(e *sync.Envelope) { e.BusinessID = business.ID{} }, sync.ErrInvalidID},
		{"no device", func(e *sync.Envelope) { e.DeviceID = devices.ID{} }, sync.ErrInvalidID},
		{"no user", func(e *sync.Envelope) { e.UserID = users.ID{} }, sync.ErrInvalidID},
		{"no type", func(e *sync.Envelope) { e.Type = "" }, sync.ErrInvalidType},
		{"whitespace type", func(e *sync.Envelope) { e.Type = "   " }, sync.ErrInvalidType},
		{"an unknown type", func(e *sync.Envelope) { e.Type = "TELEPORT" }, sync.ErrInvalidType},
		{"no payload", func(e *sync.Envelope) { e.Payload = nil }, sync.ErrInvalidPayload},
		{"an empty payload", func(e *sync.Envelope) { e.Payload = json.RawMessage("") }, sync.ErrInvalidPayload},
		{"a payload that is not JSON", func(e *sync.Envelope) { e.Payload = json.RawMessage("nonsense") }, sync.ErrInvalidPayload},
		{"an array payload", func(e *sync.Envelope) { e.Payload = json.RawMessage("[1,2]") }, sync.ErrInvalidPayload},
		{"a bare value payload", func(e *sync.Envelope) { e.Payload = json.RawMessage("42") }, sync.ErrInvalidPayload},
		{"a sequence of zero", func(e *sync.Envelope) { e.DeviceSequence = 0 }, sync.ErrInvalidSequence},
		{"a negative sequence", func(e *sync.Envelope) { e.DeviceSequence = -5 }, sync.ErrInvalidSequence},
		{"no occurrence time", func(e *sync.Envelope) { e.OccurredAt = time.Time{} }, sync.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			envelope := valid()
			tc.mutate(&envelope)

			event, err := sync.New(envelope)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if event != nil {
				t.Error("returned an event alongside an error")
			}
		})
	}
}

// TestAnUnknownTypeIsRefusedOnTheWayIn matters because a device running ahead
// of the server must find out, rather than believing its data arrived.
func TestAnUnknownTypeIsRefusedOnTheWayIn(t *testing.T) {
	envelope := valid()
	envelope.Type = "A_TYPE_FROM_A_NEWER_BUILD"

	if _, err := sync.New(envelope); !errors.Is(err, sync.ErrInvalidType) {
		t.Errorf("got %v, want ErrInvalidType", err)
	}
}

// TestRestoreRelaysATypeItDoesNotKnow is the other half: refusing to read a
// stored event would make the whole pull fail for every device, over one row an
// older build accepted.
func TestRestoreRelaysATypeItDoesNotKnow(t *testing.T) {
	envelope := valid()
	envelope.Type = "A_TYPE_FROM_A_NEWER_BUILD"

	event, err := sync.Restore(envelope)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := event.Type(); got != "A_TYPE_FROM_A_NEWER_BUILD" {
		t.Errorf("Type() = %s, want it relayed unchanged", got)
	}
}

func TestRestoreStillRefusesWhatCannotBeRead(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*sync.Envelope)
		want   error
	}{
		{"no event id", func(e *sync.Envelope) { e.ID = sync.EventID{} }, sync.ErrInvalidID},
		{"no business", func(e *sync.Envelope) { e.BusinessID = business.ID{} }, sync.ErrInvalidID},
		{"no type at all", func(e *sync.Envelope) { e.Type = "  " }, sync.ErrInvalidType},
		{"an unreadable payload", func(e *sync.Envelope) { e.Payload = json.RawMessage("nope") }, sync.ErrInvalidPayload},
		{"no occurrence time", func(e *sync.Envelope) { e.OccurredAt = time.Time{} }, sync.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			envelope := valid()
			tc.mutate(&envelope)

			if _, err := sync.Restore(envelope); !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
		})
	}
}

// TestAnEnormousPayloadIsRefused: connectivity is assumed slow and expensive
// (§45), so an event that large is far more likely a mistake than a record.
func TestAnEnormousPayloadIsRefused(t *testing.T) {
	envelope := valid()
	envelope.Payload = json.RawMessage(`{"note":"` + strings.Repeat("x", sync.MaxPayloadBytes) + `"}`)

	if _, err := sync.New(envelope); !errors.Is(err, sync.ErrInvalidPayload) {
		t.Errorf("got %v, want ErrInvalidPayload", err)
	}
}

func TestNewNormalisesTheTimestampToUTC(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	envelope := valid()
	envelope.OccurredAt = occurredAt.In(wat)

	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := event.OccurredAt().Location(); got != time.UTC {
		t.Errorf("OccurredAt() location = %s, want UTC", got)
	}
	if !event.OccurredAt().Equal(occurredAt) {
		t.Errorf("OccurredAt() = %s, want the same instant", event.OccurredAt())
	}
}

func TestDecodePayload(t *testing.T) {
	event, err := sync.New(valid())
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	var decoded struct {
		Movements []struct {
			ProductID string `json:"product_id"`
			Quantity  int64  `json:"quantity"`
		} `json:"movements"`
	}
	if err := event.DecodePayload(&decoded); err != nil {
		t.Fatalf("DecodePayload: %v", err)
	}
	if len(decoded.Movements) != 1 {
		t.Fatalf("got %d movements, want 1", len(decoded.Movements))
	}
	if decoded.Movements[0].Quantity != -3000 {
		t.Errorf("Quantity = %d, want -3000", decoded.Movements[0].Quantity)
	}

	// A payload that does not fit the shape asked for is an error rather than a
	// half-filled value.
	var wrong struct {
		Movements string `json:"movements"`
	}
	if err := event.DecodePayload(&wrong); !errors.Is(err, sync.ErrInvalidPayload) {
		t.Errorf("got %v, want ErrInvalidPayload", err)
	}
}

func TestScopeIsTheEventsBusiness(t *testing.T) {
	envelope := valid()
	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	scope := event.Scope()
	if got := scope.Business(); got != envelope.BusinessID {
		t.Errorf("Business() = %s, want %s", got, envelope.BusinessID)
	}
	if scope.Permits(business.NewID(), business.BranchID{}) {
		t.Error("the scope permitted another tenant")
	}
}

func TestTypes(t *testing.T) {
	known := sync.Types()
	if len(known) == 0 {
		t.Fatal("no event types are defined")
	}
	for _, eventType := range known {
		if !eventType.Defined() {
			t.Errorf("%s is listed but not defined", eventType)
		}
		if eventType.String() != string(eventType) {
			t.Errorf("String() = %q", eventType.String())
		}
	}

	if sync.Type("TELEPORT").Defined() {
		t.Error("an unknown type reported itself defined")
	}

	// The registry is not the caller's to modify.
	mutated := sync.Types()
	slices.Reverse(mutated)
	mutated[0] = "tampered"
	if !slices.Equal(sync.Types(), known) {
		t.Error("mutating the result changed the registry")
	}
}

func TestEventIDHelpers(t *testing.T) {
	eventID := sync.NewEventID()
	if eventID.IsZero() {
		t.Fatal("NewEventID produced a zero identifier")
	}

	parsed, err := sync.ParseEventID(eventID.String())
	if err != nil || parsed != eventID {
		t.Errorf("round trip gave %s, %v", parsed, err)
	}
	if _, err := sync.ParseEventID("nonsense"); err == nil {
		t.Error("ParseEventID accepted malformed input")
	}
	if sync.EventIDFrom(eventID.ID()) != eventID {
		t.Error("EventIDFrom did not round trip")
	}

	// An event identifier must not interchange with the others it travels
	// beside, or an event could be attributed to the wrong thing.
	underlying := id.New()
	if any(sync.EventIDFrom(underlying)) == any(users.IDFrom(underlying)) {
		t.Error("event and user identifiers are the same type")
	}
}

func TestPayloadIsReturnedUnchanged(t *testing.T) {
	envelope := valid()
	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if string(event.Payload()) != string(envelope.Payload) {
		t.Errorf("Payload() = %s, want it unchanged", event.Payload())
	}
}
