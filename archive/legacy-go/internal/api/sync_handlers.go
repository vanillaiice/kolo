package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

// maxSyncBody bounds a push.
//
// Larger than an ordinary request because a device back from a week offline
// sends a real backlog, but still bounded: §45 assumes expensive links, and a
// body beyond this is a mistake rather than a shop's week of trading.
const maxSyncBody = 4 << 20 // 4 MiB

// syncHandlers serves /api/v1/sync.
type syncHandlers struct {
	service *syncing.Service
	logger  *slog.Logger
}

// pushRequest is a batch of events from one device.
//
// It carries no business and no device. Those come from the token, so a device
// cannot attribute events to another tenant whatever it sends (ADR-008).
type pushRequest struct {
	Events []pushEvent `json:"events"`
}

type pushEvent struct {
	EventID string `json:"event_id"`
	// UserID is who was logged in when the event happened, which is not
	// necessarily who is logged in now. A device offline for days sends events
	// from earlier sessions, and attributing them to the current user would
	// make the audit trail (§39) say the wrong thing.
	//
	// The server checks the user belongs to the authenticated business, so this
	// cannot reach another tenant. Within one business it is the device's word,
	// which is the same trust already placed in it for the action itself.
	UserID     string          `json:"user_id"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurred_at"`
	// Sequence is the device's own ordering. It means nothing between devices.
	Sequence int64 `json:"sequence"`
}

type pushResponse struct {
	Results    []pushResult `json:"results"`
	Cursor     int64        `json:"cursor"`
	Accepted   int          `json:"accepted"`
	Duplicates int          `json:"duplicates"`
	Rejected   int          `json:"rejected"`
}

type pushResult struct {
	EventID string `json:"event_id"`
	// Status is one of accepted, duplicate, or rejected. It is empty when the
	// server could not settle the event at all, which tells the device to
	// retry rather than to stop.
	Status string `json:"status,omitempty"`
	Reason string `json:"reason,omitempty"`
	// Retry says plainly whether the device should send this event again,
	// rather than making every client re-derive it from the status.
	Retry bool `json:"retry"`
}

// push handles POST /api/v1/sync/push.
//
// It answers 200 even when some events were rejected. The request succeeded —
// the server considered every event and says so per event. A non-2xx would tell
// a client the whole batch failed, which would make it resend the events that
// landed (§36).
func (h *syncHandlers) push(w http.ResponseWriter, r *http.Request) {
	principal, authenticated := PrincipalFrom(r.Context())
	if !authenticated {
		writeError(w, r, h.logger, authn.ErrUnauthenticated)
		return
	}

	var body pushRequest
	if err := decodeJSONWithLimit(w, r, &body, maxSyncBody); err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	envelopes := make([]sync.Envelope, 0, len(body.Events))
	for _, event := range body.Events {
		envelopes = append(envelopes, event.toEnvelope())
	}

	result, err := h.service.Push(r.Context(), syncing.PushRequest{
		Scope:    principal.Scope(),
		DeviceID: principal.Device.ID(),
		Events:   envelopes,
	})
	if err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	response := pushResponse{
		Results:    make([]pushResult, 0, len(result.Results)),
		Cursor:     result.Cursor,
		Accepted:   result.Accepted,
		Duplicates: result.Duplicates,
		Rejected:   result.Rejected,
	}
	for _, entry := range result.Results {
		response.Results = append(response.Results, pushResult{
			EventID: entry.EventID,
			Status:  string(entry.Status),
			Reason:  entry.Reason,
			Retry:   !entry.Settled(),
		})
	}

	writeJSON(w, r, h.logger, http.StatusOK, response)
}

type pullResponse struct {
	Events []pulledEvent `json:"events"`
	Cursor int64         `json:"cursor"`
	// HasMore tells a client to come straight back rather than waiting for its
	// next scheduled sync.
	HasMore bool `json:"has_more"`
}

type pulledEvent struct {
	EventID    string          `json:"event_id"`
	DeviceID   string          `json:"device_id"`
	UserID     string          `json:"user_id"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurred_at"`
	Sequence   int64           `json:"sequence"`
}

// pull handles GET /api/v1/sync/pull.
func (h *syncHandlers) pull(w http.ResponseWriter, r *http.Request) {
	principal, authenticated := PrincipalFrom(r.Context())
	if !authenticated {
		writeError(w, r, h.logger, authn.ErrUnauthenticated)
		return
	}

	cursor, err := queryInt(r, "cursor", 0)
	if err != nil {
		writeError(w, r, h.logger, err)
		return
	}
	limit, err := queryInt(r, "limit", 0)
	if err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	result, err := h.service.Pull(r.Context(), syncing.PullRequest{
		Scope:    principal.Scope(),
		DeviceID: principal.Device.ID(),
		Cursor:   cursor,
		Limit:    int(limit),
	})
	if err != nil {
		writeError(w, r, h.logger, err)
		return
	}

	response := pullResponse{
		Events:  make([]pulledEvent, 0, len(result.Events)),
		Cursor:  result.Cursor,
		HasMore: result.HasMore,
	}
	for _, envelope := range result.Events {
		response.Events = append(response.Events, pulledEvent{
			EventID:    envelope.ID.String(),
			DeviceID:   envelope.DeviceID.String(),
			UserID:     envelope.UserID.String(),
			Type:       string(envelope.Type),
			Payload:    envelope.Payload,
			OccurredAt: envelope.OccurredAt,
			Sequence:   envelope.DeviceSequence,
		})
	}

	writeJSON(w, r, h.logger, http.StatusOK, response)
}

// toEnvelope converts a wire event, leaving anything unparseable as its zero
// value.
//
// A malformed identifier or type is not rejected here. The service decides what
// happens to a bad event, and it rejects that one alone rather than the batch —
// which is the whole point of per-event results (§36). Failing here would throw
// away the good events alongside it.
func (e pushEvent) toEnvelope() sync.Envelope {
	envelope := sync.Envelope{
		Type:           sync.Type(e.Type),
		Payload:        e.Payload,
		OccurredAt:     e.OccurredAt,
		DeviceSequence: e.Sequence,
	}
	if eventID, err := sync.ParseEventID(e.EventID); err == nil {
		envelope.ID = eventID
	}
	if userID, err := users.ParseID(e.UserID); err == nil {
		envelope.UserID = userID
	}
	return envelope
}

// queryInt reads a whole number from the query string.
func queryInt(r *http.Request, name string, fallback int64) (int64, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, nil
	}

	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: %s must be a whole number", syncing.ErrInvalidRequest, name)
	}
	if value < 0 {
		return 0, fmt.Errorf("%w: %s cannot be negative", syncing.ErrInvalidRequest, name)
	}
	return value, nil
}
