package api_test

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

// These drive sync over real HTTP, against a real database, with two devices —
// which is the smallest arrangement in which sync means anything: one records
// and the other must come to know.

type wireEvent struct {
	EventID    string          `json:"event_id"`
	UserID     string          `json:"user_id"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurred_at"`
	Sequence   int64           `json:"sequence"`
}

type wirePushResponse struct {
	Results []struct {
		EventID string `json:"event_id"`
		Status  string `json:"status"`
		Reason  string `json:"reason"`
		Retry   bool   `json:"retry"`
	} `json:"results"`
	Cursor     int64 `json:"cursor"`
	Accepted   int   `json:"accepted"`
	Duplicates int   `json:"duplicates"`
	Rejected   int   `json:"rejected"`
}

type wirePullResponse struct {
	Events []struct {
		EventID  string          `json:"event_id"`
		DeviceID string          `json:"device_id"`
		Type     string          `json:"type"`
		Payload  json.RawMessage `json:"payload"`
		Sequence int64           `json:"sequence"`
	} `json:"events"`
	Cursor  int64 `json:"cursor"`
	HasMore bool  `json:"has_more"`
}

func (h *harness) event(sequence int64) wireEvent {
	return wireEvent{
		EventID:    sync.NewEventID().String(),
		UserID:     h.user.ID().String(),
		Type:       string(sync.StockMoved),
		Payload:    h.stockPayload(),
		OccurredAt: registeredAt,
		Sequence:   sequence,
	}
}

// stockPayload is three units sold, which the server records and applies.
func (h *harness) stockPayload() json.RawMessage {
	encoded, err := json.Marshal(map[string]any{
		"movements": []map[string]any{{
			"id":             inventory.NewMovementID().String(),
			"product_id":     h.product.String(),
			"type":           string(inventory.Sale),
			"quantity":       -3000,
			"reference_kind": "SALE",
			"reference_id":   id.New().String(),
		}},
	})
	if err != nil {
		panic(err)
	}
	return encoded
}

// loginOnAnotherDevice registers a second installation, which is how the same
// person works from a till and their own phone.
func (h *harness) loginOnAnotherDevice(t *testing.T, label string) string {
	t.Helper()

	body := h.loginBody()
	body["device"] = map[string]any{"label": label, "platform": "ANDROID"}

	response := h.post(t, "/api/v1/auth/login", body, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("login on %s returned %d: %s", label, response.StatusCode, readBody(t, response))
	}
	var decoded struct {
		Token string `json:"token"`
	}
	decode(t, response, &decoded)
	return decoded.Token
}

func (h *harness) push(t *testing.T, token string, events ...wireEvent) wirePushResponse {
	t.Helper()

	response := h.post(t, "/api/v1/sync/push", map[string]any{"events": events}, token)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("push returned %d: %s", response.StatusCode, readBody(t, response))
	}
	var decoded wirePushResponse
	decode(t, response, &decoded)
	return decoded
}

func (h *harness) pull(t *testing.T, token, query string) wirePullResponse {
	t.Helper()

	response := h.get(t, "/api/v1/sync/pull"+query, token)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pull returned %d: %s", response.StatusCode, readBody(t, response))
	}
	var decoded wirePullResponse
	decode(t, response, &decoded)
	return decoded
}

// TestWhatOneDeviceRecordsAnotherReceives is the whole subsystem in one test.
func TestWhatOneDeviceRecordsAnotherReceives(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)
	phone := h.loginOnAnotherDevice(t, "Owner phone")

	sent := []wireEvent{h.event(1), h.event(2)}
	pushed := h.push(t, till, sent...)
	if pushed.Accepted != 2 {
		t.Fatalf("accepted %d of 2: %+v", pushed.Accepted, pushed.Results)
	}

	received := h.pull(t, phone, "")
	if len(received.Events) != 2 {
		t.Fatalf("the phone received %d events, want 2", len(received.Events))
	}
	for i, event := range received.Events {
		if event.EventID != sent[i].EventID {
			t.Errorf("event %d is %s, want %s", i, event.EventID, sent[i].EventID)
		}
		if event.Type != string(sync.StockMoved) {
			t.Errorf("event %d has type %q", i, event.Type)
		}
		if len(event.Payload) == 0 {
			t.Errorf("event %d arrived with no payload", i)
		}
	}

	// Pulling again from the cursor yields nothing: delivered exactly once.
	again := h.pull(t, phone, "?cursor="+strconv.FormatInt(received.Cursor, 10))
	if len(again.Events) != 0 {
		t.Errorf("pulling again returned %d events, want none", len(again.Events))
	}
}

// TestADeviceDoesNotPullItsOwnEventsBack: on a metered link that is paying
// twice for nothing (§45).
func TestADeviceDoesNotPullItsOwnEventsBack(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)

	h.push(t, till, h.event(1))

	pulled := h.pull(t, till, "")
	if len(pulled.Events) != 0 {
		t.Errorf("the till pulled back %d of its own events", len(pulled.Events))
	}
	// The cursor still advances, or the device would re-scan forever.
	if pulled.Cursor == 0 {
		t.Error("an empty pull did not advance the cursor")
	}
}

// TestARetriedPushIsASuccess is what a device on a bad link actually does when
// it never saw the response.
func TestARetriedPushIsASuccess(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)

	event := h.event(1)
	first := h.push(t, till, event)
	if first.Results[0].Status != "accepted" {
		t.Fatalf("the first push: %+v", first.Results[0])
	}

	retried := h.push(t, till, event)
	if got := retried.Results[0].Status; got != "duplicate" {
		t.Errorf("the retry: status %q, want duplicate", got)
	}
	if retried.Results[0].Retry {
		t.Error("the retry told the device to send again, which would loop forever")
	}
	if retried.Duplicates != 1 || retried.Accepted != 0 {
		t.Errorf("counts = %d accepted, %d duplicate", retried.Accepted, retried.Duplicates)
	}
}

// TestABadEventDoesNotStopTheBatch is §36's partial-failure requirement seen
// from the wire, where it is what a client can actually observe.
func TestABadEventDoesNotStopTheBatch(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)
	phone := h.loginOnAnotherDevice(t, "Owner phone")

	good := h.event(1)
	bad := h.event(2)
	bad.Type = "A_TYPE_THIS_SERVER_DOES_NOT_KNOW"
	alsoGood := h.event(3)

	response := h.post(t, "/api/v1/sync/push",
		map[string]any{"events": []wireEvent{good, bad, alsoGood}}, till)

	// The request succeeded even though one event did not: a non-2xx would tell
	// the client the whole batch failed and make it resend what landed.
	if response.StatusCode != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", response.StatusCode, readBody(t, response))
	}
	var decoded wirePushResponse
	decode(t, response, &decoded)

	if decoded.Accepted != 2 || decoded.Rejected != 1 {
		t.Errorf("counts = %d accepted, %d rejected", decoded.Accepted, decoded.Rejected)
	}
	if got := decoded.Results[1].Status; got != "rejected" {
		t.Errorf("the bad event: status %q, want rejected", got)
	}
	if decoded.Results[1].Reason == "" {
		t.Error("the rejection carries no reason")
	}
	if decoded.Results[1].Retry {
		t.Error("a rejected event told the device to retry, which will never help")
	}

	// The two good events reached the other device; the bad one did not.
	received := h.pull(t, phone, "")
	if len(received.Events) != 2 {
		t.Errorf("the phone received %d events, want the 2 good ones", len(received.Events))
	}
	for _, event := range received.Events {
		if event.EventID == bad.EventID {
			t.Error("a rejected event was relayed")
		}
	}
}

// TestADeviceCannotAttributeEventsToAnotherTenant is the boundary ADR-008
// exists for, seen at the edge: the payload has no business field at all, and
// the device is taken from the token.
func TestADeviceCannotAttributeEventsToAnotherTenant(t *testing.T) {
	first := newHarness(t)
	second := newHarness(t)

	firstToken := first.login(t)
	secondToken := second.login(t)

	first.push(t, firstToken, first.event(1))

	// The other business sees nothing of it.
	pulled := second.pull(t, secondToken, "")
	if len(pulled.Events) != 0 {
		t.Errorf("another tenant pulled %d events", len(pulled.Events))
	}
}

// TestAnEventIsAttributedToTheDeviceThatSentIt, whatever else it claims.
func TestAnEventIsAttributedToTheDeviceThatSentIt(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)
	phone := h.loginOnAnotherDevice(t, "Owner phone")

	// Find out which device the phone is, so the assertion below is meaningful.
	me := h.get(t, "/api/v1/auth/me", phone)
	var identity struct {
		Device struct {
			ID string `json:"id"`
		} `json:"device"`
	}
	decode(t, me, &identity)

	h.push(t, phone, h.event(1))

	received := h.pull(t, till, "")
	if len(received.Events) != 1 {
		t.Fatalf("the till received %d events, want 1", len(received.Events))
	}
	if received.Events[0].DeviceID != identity.Device.ID {
		t.Errorf("the event is attributed to %s, want the phone %s",
			received.Events[0].DeviceID, identity.Device.ID)
	}
}

func TestPullPaginates(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)
	phone := h.loginOnAnotherDevice(t, "Owner phone")

	events := make([]wireEvent, 5)
	for i := range events {
		events[i] = h.event(int64(i + 1))
	}
	h.push(t, till, events...)

	first := h.pull(t, phone, "?limit=2")
	if len(first.Events) != 2 {
		t.Fatalf("got %d events, want 2", len(first.Events))
	}
	if !first.HasMore {
		t.Error("has_more is not set although the batch was truncated")
	}

	rest := h.pull(t, phone, "?cursor="+strconv.FormatInt(first.Cursor, 10)+"&limit=100")
	if len(rest.Events) != 3 {
		t.Errorf("got %d events after the cursor, want 3", len(rest.Events))
	}
	if rest.HasMore {
		t.Error("has_more is set on the last batch")
	}
}

func TestSyncRequiresAuthentication(t *testing.T) {
	h := newHarness(t)

	for _, attempt := range []struct {
		name string
		call func() *http.Response
	}{
		{"push with no token", func() *http.Response {
			return h.post(t, "/api/v1/sync/push", map[string]any{"events": []wireEvent{}}, "")
		}},
		{"pull with no token", func() *http.Response {
			return h.get(t, "/api/v1/sync/pull", "")
		}},
	} {
		t.Run(attempt.name, func(t *testing.T) {
			response := attempt.call()
			if response.StatusCode != http.StatusUnauthorized {
				t.Errorf("got %d, want 401", response.StatusCode)
				return
			}
			if got := errorCode(t, response); got != "unauthenticated" {
				t.Errorf("code = %q, want unauthenticated", got)
			}
		})
	}
}

func TestPushRejectsAMalformedRequest(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)

	tests := []struct {
		name string
		body any
	}{
		{"not JSON", "nonsense"},
		{"an array", "[]"},
		{"an unknown field", map[string]any{"events": []wireEvent{}, "device_id": "sneaky"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			response := h.post(t, "/api/v1/sync/push", tc.body, till)
			if response.StatusCode != http.StatusBadRequest {
				t.Errorf("got %d, want 400: %s", response.StatusCode, readBody(t, response))
			}
		})
	}
}

func TestPullRejectsAMalformedQuery(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)

	for _, query := range []string{"?cursor=abc", "?cursor=-1", "?limit=nonsense"} {
		t.Run(query, func(t *testing.T) {
			response := h.get(t, "/api/v1/sync/pull"+query, till)
			if response.StatusCode != http.StatusBadRequest {
				t.Errorf("got %d, want 400", response.StatusCode)
				return
			}
			if got := errorCode(t, response); got != "invalid_request" {
				t.Errorf("code = %q, want invalid_request", got)
			}
		})
	}
}

// TestAnEventWithAMalformedIdentifierIsRejectedAlone confirms the handler does
// not fail the batch over one bad field: the service decides, per event.
func TestAnEventWithAMalformedIdentifierIsRejectedAlone(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)

	good := h.event(1)
	bad := h.event(2)
	bad.EventID = "not-a-uuid"

	pushed := h.push(t, till, good, bad)
	if pushed.Accepted != 1 || pushed.Rejected != 1 {
		t.Errorf("counts = %d accepted, %d rejected", pushed.Accepted, pushed.Rejected)
	}
	if pushed.Results[1].Status != "rejected" {
		t.Errorf("the bad event: %+v", pushed.Results[1])
	}
}

func TestAnEmptyPushIsAccepted(t *testing.T) {
	h := newHarness(t)
	till := h.login(t)

	pushed := h.push(t, till)
	if len(pushed.Results) != 0 {
		t.Errorf("got %d results, want none", len(pushed.Results))
	}
}

// The whole point, end to end: a device pushes a sale over HTTP and the
// server's stock goes down. Before this, an event was filed and the ledger was
// left disagreeing with the device that sent it.
func TestPushingASaleMovesServerStock(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)

	first, second := h.event(1), h.event(2)
	response := h.push(t, token, first, second)
	if response.Accepted != 2 {
		t.Fatalf("accepted %d of 2 events", response.Accepted)
	}

	// Six units sold across two events, so the shelf is six down. It reads as
	// negative because nothing was ever received into this ledger — which is the
	// honest answer, not a bug (§29).
	if got := h.stock(t); got != -6_000 {
		t.Errorf("stock = %d thousandths, want -6000", got)
	}

	// And the very same events again change nothing. This has to resend the
	// identical envelopes — a fresh one would be a different sale, not a replay.
	h.push(t, token, first, second)
	if got := h.stock(t); got != -6_000 {
		t.Errorf("stock = %d after a resend, want it unchanged", got)
	}
}
