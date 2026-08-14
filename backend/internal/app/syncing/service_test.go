package syncing_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

var occurredAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

type fixture struct {
	service *syncing.Service
	store   *fakeStore
	ctx     context.Context

	scope  business.Scope
	tenant business.ID
	user   users.ID
	till   devices.ID
	phone  devices.ID
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	tenant := business.NewID()
	store := newFakeStore()
	return &fixture{
		service: syncing.NewService(store, syncing.Options{
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		}),
		store:  store,
		ctx:    context.Background(),
		scope:  business.MustNewScope(tenant),
		tenant: tenant,
		user:   users.NewID(),
		till:   devices.NewID(),
		phone:  devices.NewID(),
	}
}

func (f *fixture) envelope(sequence int64) sync.Envelope {
	return sync.Envelope{
		ID:             sync.NewEventID(),
		BusinessID:     f.tenant,
		DeviceID:       f.till,
		UserID:         f.user,
		Type:           sync.StockMoved,
		Payload:        json.RawMessage(`{"movements":[]}`),
		OccurredAt:     occurredAt,
		DeviceSequence: sequence,
	}
}

func (f *fixture) push(t *testing.T, events ...sync.Envelope) syncing.PushResponse {
	t.Helper()
	response, err := f.service.Push(f.ctx, syncing.PushRequest{
		Scope: f.scope, DeviceID: f.till, Events: events,
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	return response
}

func TestPushAcceptsAnEvent(t *testing.T) {
	f := newFixture(t)
	envelope := f.envelope(1)

	response := f.push(t, envelope)

	if len(response.Results) != 1 {
		t.Fatalf("got %d results, want 1", len(response.Results))
	}
	if got := response.Results[0].Status; got != syncing.Accepted {
		t.Errorf("Status = %q, want accepted", got)
	}
	if got := response.Results[0].EventID; got != envelope.ID.String() {
		t.Errorf("EventID = %q, want %q", got, envelope.ID)
	}
	if response.Accepted != 1 || response.Duplicates != 0 || response.Rejected != 0 {
		t.Errorf("counts = %d/%d/%d", response.Accepted, response.Duplicates, response.Rejected)
	}
	if response.Cursor <= 0 {
		t.Errorf("Cursor = %d, want it to advance", response.Cursor)
	}
}

// TestAReplayIsASuccess is what keeps a device on a bad link from retrying
// forever: it could not tell whether its push arrived, so it pushed again.
func TestAReplayIsASuccess(t *testing.T) {
	f := newFixture(t)
	envelope := f.envelope(1)

	f.push(t, envelope)
	again := f.push(t, envelope)

	if got := again.Results[0].Status; got != syncing.Duplicate {
		t.Errorf("Status = %q, want duplicate", got)
	}
	if !again.Results[0].Settled() {
		t.Error("a duplicate is not settled, so the device would keep resending")
	}
	if again.Duplicates != 1 || again.Accepted != 0 {
		t.Errorf("counts = %d accepted, %d duplicate", again.Accepted, again.Duplicates)
	}
	if f.store.recorded() != 1 {
		t.Errorf("the store holds %d events, want 1", f.store.recorded())
	}
}

// TestOneBadEventDoesNotStopTheRest is §36's partial-failure requirement, and
// the difference between a shop that syncs and one stuck forever behind a
// single record it cannot fix from the till.
func TestOneBadEventDoesNotStopTheRest(t *testing.T) {
	f := newFixture(t)

	good := f.envelope(1)
	bad := f.envelope(2)
	bad.Type = "A_TYPE_THIS_SERVER_DOES_NOT_KNOW"
	alsoGood := f.envelope(3)

	response := f.push(t, good, bad, alsoGood)

	if len(response.Results) != 3 {
		t.Fatalf("got %d results, want 3", len(response.Results))
	}
	if response.Results[0].Status != syncing.Accepted {
		t.Errorf("the first event: %q", response.Results[0].Status)
	}
	if response.Results[1].Status != syncing.Rejected {
		t.Errorf("the bad event: %q, want rejected", response.Results[1].Status)
	}
	if response.Results[2].Status != syncing.Accepted {
		t.Errorf("the event after the bad one: %q, want accepted", response.Results[2].Status)
	}
	if response.Accepted != 2 || response.Rejected != 1 {
		t.Errorf("counts = %d accepted, %d rejected", response.Accepted, response.Rejected)
	}

	// A rejection says why, so someone can act on it.
	if response.Results[1].Reason == "" {
		t.Error("a rejection carries no reason")
	}
	// And it is kept rather than dropped.
	if f.store.rejectedCount() != 1 {
		t.Errorf("the store holds %d rejections, want 1", f.store.rejectedCount())
	}
}

func TestEventsAreRejectedForTheReasonsThatMatter(t *testing.T) {
	f := newFixture(t)

	tests := []struct {
		name   string
		mutate func(*sync.Envelope)
	}{
		{"an unknown type", func(e *sync.Envelope) { e.Type = "NOPE" }},
		{"no type", func(e *sync.Envelope) { e.Type = "" }},
		{"no payload", func(e *sync.Envelope) { e.Payload = nil }},
		{"a payload that is not an object", func(e *sync.Envelope) { e.Payload = json.RawMessage(`[1,2]`) }},
		{"a payload that is not JSON", func(e *sync.Envelope) { e.Payload = json.RawMessage(`nonsense`) }},
		{"no user", func(e *sync.Envelope) { e.UserID = users.ID{} }},
		{"no occurrence time", func(e *sync.Envelope) { e.OccurredAt = time.Time{} }},
		{"a sequence of zero", func(e *sync.Envelope) { e.DeviceSequence = 0 }},
		{"a negative sequence", func(e *sync.Envelope) { e.DeviceSequence = -1 }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			envelope := f.envelope(1)
			tc.mutate(&envelope)

			response := f.push(t, envelope)
			if got := response.Results[0].Status; got != syncing.Rejected {
				t.Errorf("Status = %q, want rejected", got)
			}
			if response.Results[0].Reason == "" {
				t.Error("the rejection carries no reason")
			}
		})
	}
}

// TestAnEventWithNoIdentifierIsRefusedInTheResponseAlone: without an identifier
// there is nothing to deduplicate on, so it cannot even be stored as a
// rejection.
func TestAnEventWithNoIdentifierIsRefusedInTheResponseAlone(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.ID = sync.EventID{}

	response := f.push(t, envelope)

	if got := response.Results[0].Status; got != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", got)
	}
	if f.store.rejectedCount() != 0 {
		t.Error("an event with no identifier was stored")
	}
}

// TestTheCallerCannotAttributeEventsElsewhere is the boundary ADR-008 exists
// for: the business and device come from the authenticated caller, not the
// payload.
func TestTheCallerCannotAttributeEventsElsewhere(t *testing.T) {
	f := newFixture(t)

	envelope := f.envelope(1)
	envelope.BusinessID = business.NewID() // claiming another tenant
	envelope.DeviceID = devices.NewID()    // claiming another device

	response := f.push(t, envelope)
	if got := response.Results[0].Status; got != syncing.Accepted {
		t.Fatalf("Status = %q, want accepted after correction", got)
	}

	stored := f.store.first()
	if stored.BusinessID != f.tenant {
		t.Errorf("the event landed under %s, want %s", stored.BusinessID, f.tenant)
	}
	if stored.DeviceID != f.till {
		t.Errorf("the event is attributed to %s, want the caller's device %s", stored.DeviceID, f.till)
	}
}

// TestAnEventNamingAnUnknownUserIsRejectedAlone: a reference the database
// refuses is that event's problem, not the batch's.
func TestAnEventNamingAnUnknownUserIsRejectedAlone(t *testing.T) {
	f := newFixture(t)
	f.store.refuseReferences = true

	good := f.envelope(1)
	response := f.push(t, good)

	if got := response.Results[0].Status; got != syncing.Rejected {
		t.Errorf("Status = %q, want rejected", got)
	}
	if response.Results[0].Reason == "" {
		t.Error("the rejection carries no reason")
	}
}

// TestAServerFaultLeavesTheEventUnsettled, so the device retries rather than
// giving up on data the server does not have.
func TestAServerFaultLeavesTheEventUnsettled(t *testing.T) {
	f := newFixture(t)
	f.store.failRecord = true

	response := f.push(t, f.envelope(1))

	result := response.Results[0]
	if result.Status == syncing.Rejected {
		t.Error("a server fault was reported as a rejection, so the device would stop retrying")
	}
	if result.Settled() {
		t.Error("a server fault was reported as settled")
	}
	if response.Accepted != 0 || response.Rejected != 0 {
		t.Errorf("counts = %d accepted, %d rejected; want neither", response.Accepted, response.Rejected)
	}
}

func TestPushRejectsAMalformedRequest(t *testing.T) {
	f := newFixture(t)

	var unset business.Scope
	if _, err := f.service.Push(f.ctx, syncing.PushRequest{Scope: unset, DeviceID: f.till}); !errors.Is(err, syncing.ErrInvalidRequest) {
		t.Errorf("no scope: got %v, want ErrInvalidRequest", err)
	}
	if _, err := f.service.Push(f.ctx, syncing.PushRequest{Scope: f.scope}); !errors.Is(err, syncing.ErrInvalidRequest) {
		t.Errorf("no device: got %v, want ErrInvalidRequest", err)
	}
}

// TestABatchTooLargeIsRefusedWhole, because accepting it would mean a device
// could make one request the server has to hold entirely in memory.
func TestABatchTooLargeIsRefusedWhole(t *testing.T) {
	f := newFixture(t)

	oversized := make([]sync.Envelope, syncing.MaxPushBatch+1)
	for i := range oversized {
		oversized[i] = f.envelope(int64(i + 1))
	}

	_, err := f.service.Push(f.ctx, syncing.PushRequest{
		Scope: f.scope, DeviceID: f.till, Events: oversized,
	})
	if !errors.Is(err, syncing.ErrBatchTooLarge) {
		t.Errorf("got %v, want ErrBatchTooLarge", err)
	}
	if f.store.recorded() != 0 {
		t.Error("an oversized batch stored events before being refused")
	}
}

func TestAnEmptyPushIsHarmless(t *testing.T) {
	f := newFixture(t)

	response := f.push(t)
	if len(response.Results) != 0 {
		t.Errorf("got %d results, want none", len(response.Results))
	}
}

// TestPushStillReportsResultsWhenTheCursorCannotBeRead: the events are
// recorded, and failing the push would make the device resend all of them.
func TestPushStillReportsResultsWhenTheCursorCannotBeRead(t *testing.T) {
	f := newFixture(t)
	f.store.failLatest = true

	response := f.push(t, f.envelope(1))

	if response.Results[0].Status != syncing.Accepted {
		t.Errorf("Status = %q, want accepted", response.Results[0].Status)
	}
	if response.Cursor != 0 {
		t.Errorf("Cursor = %d, want it left alone", response.Cursor)
	}
}

func TestPullReturnsWhatTheDeviceHasNotSeen(t *testing.T) {
	f := newFixture(t)

	f.push(t, f.envelope(1), f.envelope(2))

	response, err := f.service.Pull(f.ctx, syncing.PullRequest{
		Scope: f.scope, DeviceID: f.phone, Cursor: 0,
	})
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(response.Events) != 2 {
		t.Fatalf("got %d events, want 2", len(response.Events))
	}
	if response.Cursor <= 0 {
		t.Errorf("Cursor = %d, want it to advance", response.Cursor)
	}
	if response.HasMore {
		t.Error("HasMore is set although everything was returned")
	}
}

// TestPullSaysWhenThereIsMore, so a client comes straight back rather than
// waiting for the next scheduled sync.
func TestPullSaysWhenThereIsMore(t *testing.T) {
	f := newFixture(t)

	for i := int64(1); i <= 5; i++ {
		f.push(t, f.envelope(i))
	}

	first, err := f.service.Pull(f.ctx, syncing.PullRequest{
		Scope: f.scope, DeviceID: f.phone, Limit: 2,
	})
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(first.Events) != 2 {
		t.Fatalf("got %d events, want 2", len(first.Events))
	}
	if !first.HasMore {
		t.Error("HasMore is not set although the batch was truncated")
	}

	rest, err := f.service.Pull(f.ctx, syncing.PullRequest{
		Scope: f.scope, DeviceID: f.phone, Cursor: first.Cursor, Limit: 100,
	})
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(rest.Events) != 3 {
		t.Errorf("got %d events after the cursor, want 3", len(rest.Events))
	}
	if rest.HasMore {
		t.Error("HasMore is set on the last batch")
	}
}

// TestAnEmptyPullStillAdvancesTheCursor: otherwise a device that only ever sees
// its own events would re-scan them on every sync forever.
func TestAnEmptyPullStillAdvancesTheCursor(t *testing.T) {
	f := newFixture(t)

	f.push(t, f.envelope(1))

	// The till pulls: the only event is its own, so there is nothing for it.
	response, err := f.service.Pull(f.ctx, syncing.PullRequest{
		Scope: f.scope, DeviceID: f.till, Cursor: 0,
	})
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(response.Events) != 0 {
		t.Fatalf("got %d events, want none", len(response.Events))
	}
	if response.Cursor == 0 {
		t.Error("the cursor did not advance, so the device would re-scan forever")
	}
}

func TestPullBoundsTheBatch(t *testing.T) {
	f := newFixture(t)

	for i := int64(1); i <= 3; i++ {
		f.push(t, f.envelope(i))
	}

	// Asking for more than the maximum is capped rather than refused: the
	// caller gets a sensible batch instead of an error it cannot act on.
	response, err := f.service.Pull(f.ctx, syncing.PullRequest{
		Scope: f.scope, DeviceID: f.phone, Limit: syncing.MaxPullBatch * 10,
	})
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(response.Events) != 3 {
		t.Errorf("got %d events, want 3", len(response.Events))
	}
	if got := f.store.lastRequestedLimit(); got > syncing.MaxPullBatch+1 {
		t.Errorf("the store was asked for %d, above the cap", got)
	}
}

func TestPullRejectsAMalformedRequest(t *testing.T) {
	f := newFixture(t)

	var unset business.Scope
	if _, err := f.service.Pull(f.ctx, syncing.PullRequest{Scope: unset}); !errors.Is(err, syncing.ErrInvalidRequest) {
		t.Errorf("no scope: got %v, want ErrInvalidRequest", err)
	}
	if _, err := f.service.Pull(f.ctx, syncing.PullRequest{Scope: f.scope, Cursor: -1}); !errors.Is(err, syncing.ErrInvalidRequest) {
		t.Errorf("a negative cursor: got %v, want ErrInvalidRequest", err)
	}
}

func TestPullReportsAStoreFailure(t *testing.T) {
	f := newFixture(t)
	f.store.failSince = true

	if _, err := f.service.Pull(f.ctx, syncing.PullRequest{Scope: f.scope, DeviceID: f.phone}); err == nil {
		t.Error("Pull succeeded although the store failed")
	}
}

// TestAnEmptyPullSurvivesAFailedCursorRead: slower but correct, rather than
// failing a sync that had nothing to do anyway.
func TestAnEmptyPullSurvivesAFailedCursorRead(t *testing.T) {
	f := newFixture(t)
	f.store.failLatest = true

	response, err := f.service.Pull(f.ctx, syncing.PullRequest{
		Scope: f.scope, DeviceID: f.phone, Cursor: 7,
	})
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if response.Cursor != 7 {
		t.Errorf("Cursor = %d, want the caller's own %d", response.Cursor, 7)
	}
}

// TestARoundTripBetweenTwoDevices is the whole point: what one till records
// reaches the other, exactly once.
func TestARoundTripBetweenTwoDevices(t *testing.T) {
	f := newFixture(t)

	sent := []sync.Envelope{f.envelope(1), f.envelope(2), f.envelope(3)}
	f.push(t, sent...)

	// The phone catches up in two batches, as a device on a bad link would.
	received := make([]sync.Envelope, 0, len(sent))
	cursor := int64(0)
	for range 10 {
		response, err := f.service.Pull(f.ctx, syncing.PullRequest{
			Scope: f.scope, DeviceID: f.phone, Cursor: cursor, Limit: 2,
		})
		if err != nil {
			t.Fatalf("Pull: %v", err)
		}
		received = append(received, response.Events...)
		cursor = response.Cursor
		if !response.HasMore {
			break
		}
	}

	if len(received) != len(sent) {
		t.Fatalf("the phone received %d events, want %d", len(received), len(sent))
	}
	for i, envelope := range received {
		if envelope.ID != sent[i].ID {
			t.Errorf("event %d is %s, want %s", i, envelope.ID, sent[i].ID)
		}
		if envelope.DeviceID != f.till {
			t.Errorf("event %d came from %s, want the till", i, envelope.DeviceID)
		}
	}

	// Pulling again from the same cursor yields nothing: exactly once.
	after, err := f.service.Pull(f.ctx, syncing.PullRequest{
		Scope: f.scope, DeviceID: f.phone, Cursor: cursor,
	})
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(after.Events) != 0 {
		t.Errorf("pulling again returned %d events, want none", len(after.Events))
	}
}

func TestServiceDefaultsAreUsable(t *testing.T) {
	f := newFixture(t)

	// A service built with no options must still work.
	service := syncing.NewService(f.store, syncing.Options{})
	if _, err := service.Push(f.ctx, syncing.PushRequest{
		Scope: f.scope, DeviceID: f.till, Events: []sync.Envelope{f.envelope(1)},
	}); err != nil {
		t.Errorf("Push: %v", err)
	}
}
