package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// syncFixture is a business with two devices, which is the smallest setup in
// which sync means anything: one device sends and the other receives.
type syncFixture struct {
	events *postgres.SyncRepository
	ctx    context.Context

	scope  business.Scope
	tenant business.ID
	user   users.ID
	till   devices.ID
	phone  devices.ID
}

func newSyncFixture(t *testing.T) *syncFixture {
	t.Helper()

	pool := pgtest.Pool(t)
	ctx := context.Background()
	businesses := postgres.NewBusinessRepository(pool)
	userRepo := postgres.NewUserRepository(pool)
	deviceRepo := postgres.NewDeviceRepository(pool)

	tenant, scope := newTenant(t, businesses, ctx)

	user := newUser(t, tenant.ID(), "Jean Mbarga", authz.RoleCashier)
	if err := userRepo.Create(ctx, scope, user); err != nil {
		t.Fatalf("creating the user: %v", err)
	}

	registered := make([]devices.ID, 0, 2)
	for _, label := range []string{"Till 1", "Owner phone"} {
		device := newDevice(t, tenant.ID(), label)
		if err := deviceRepo.Create(ctx, scope, device); err != nil {
			t.Fatalf("creating the device: %v", err)
		}
		registered = append(registered, device.ID())
	}

	return &syncFixture{
		events: postgres.NewSyncRepository(pool),
		ctx:    ctx,
		scope:  scope,
		tenant: tenant.ID(),
		user:   user.ID(),
		till:   registered[0],
		phone:  registered[1],
	}
}

func (f *syncFixture) envelope(device devices.ID, sequence int64) sync.Envelope {
	return sync.Envelope{
		ID:             sync.NewEventID(),
		BusinessID:     f.tenant,
		DeviceID:       device,
		UserID:         f.user,
		Type:           sync.StockMoved,
		Payload:        json.RawMessage(`{"movements":[{"product_id":"abc","quantity":-3000}]}`),
		OccurredAt:     createdAt,
		DeviceSequence: sequence,
	}
}

func (f *syncFixture) record(t *testing.T, envelope sync.Envelope) postgres.RecordOutcome {
	t.Helper()

	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("sync.New: %v", err)
	}
	outcome, err := f.events.Record(f.ctx, f.scope, event)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	return outcome
}

// TestReplayingAnEventDoesNotApplyItTwice is the guarantee §27 asks for, and
// the reason the event identifier is the primary key.
func TestReplayingAnEventDoesNotApplyItTwice(t *testing.T) {
	f := newSyncFixture(t)
	envelope := f.envelope(f.till, 1)

	if outcome := f.record(t, envelope); outcome != postgres.Recorded {
		t.Errorf("the first push gave %v, want Recorded", outcome)
	}
	// The device never saw the response and pushes again.
	if outcome := f.record(t, envelope); outcome != postgres.AlreadyRecorded {
		t.Errorf("the replay gave %v, want AlreadyRecorded", outcome)
	}
	// And again.
	if outcome := f.record(t, envelope); outcome != postgres.AlreadyRecorded {
		t.Errorf("the second replay gave %v, want AlreadyRecorded", outcome)
	}

	// The other device sees it once, not three times.
	pulled, err := f.events.Since(f.ctx, f.scope, 0, f.phone, 100)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(pulled) != 1 {
		t.Errorf("the other device sees %d copies, want 1", len(pulled))
	}
}

// TestAReplayDoesNotChangeWhatWasStored: the first version stands, so a device
// that resends a mutated payload under the same identifier cannot rewrite
// history.
func TestAReplayDoesNotChangeWhatWasStored(t *testing.T) {
	f := newSyncFixture(t)

	envelope := f.envelope(f.till, 1)
	f.record(t, envelope)

	tampered := envelope
	tampered.Payload = json.RawMessage(`{"movements":[{"product_id":"abc","quantity":-99000}]}`)
	if outcome := f.record(t, tampered); outcome != postgres.AlreadyRecorded {
		t.Fatalf("the replay gave %v, want AlreadyRecorded", outcome)
	}

	stored, err := f.events.Get(f.ctx, f.scope, envelope.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(stored.Event.Payload()) == string(tampered.Payload) {
		t.Error("a replay overwrote the payload the server had already accepted")
	}
}

// TestADeviceDoesNotPullItsOwnEvents keeps every sync from paying twice for the
// same data on a metered link.
func TestADeviceDoesNotPullItsOwnEvents(t *testing.T) {
	f := newSyncFixture(t)

	fromTill := f.envelope(f.till, 1)
	fromPhone := f.envelope(f.phone, 1)
	f.record(t, fromTill)
	f.record(t, fromPhone)

	forTill, err := f.events.Since(f.ctx, f.scope, 0, f.till, 100)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(forTill) != 1 || forTill[0].Event.ID() != fromPhone.ID {
		t.Errorf("the till pulled %d events, want only the phone's", len(forTill))
	}

	forPhone, err := f.events.Since(f.ctx, f.scope, 0, f.phone, 100)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(forPhone) != 1 || forPhone[0].Event.ID() != fromTill.ID {
		t.Errorf("the phone pulled %d events, want only the till's", len(forPhone))
	}
}

// TestPullingResumesFromTheCursor is what makes a multi-day gap survivable: a
// device asks for what it has not seen rather than for everything (§45).
func TestPullingResumesFromTheCursor(t *testing.T) {
	f := newSyncFixture(t)

	for sequence := int64(1); sequence <= 5; sequence++ {
		f.record(t, f.envelope(f.till, sequence))
	}

	first, err := f.events.Since(f.ctx, f.scope, 0, f.phone, 2)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("got %d events, want 2", len(first))
	}

	cursor := first[len(first)-1].ServerSequence
	rest, err := f.events.Since(f.ctx, f.scope, cursor, f.phone, 100)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(rest) != 3 {
		t.Errorf("got %d events after the cursor, want 3", len(rest))
	}

	// Nothing is delivered twice.
	seen := make(map[sync.EventID]bool)
	for _, entry := range append(first, rest...) {
		if seen[entry.Event.ID()] {
			t.Errorf("event %s was delivered twice", entry.Event.ID())
		}
		seen[entry.Event.ID()] = true
	}
	if len(seen) != 5 {
		t.Errorf("saw %d distinct events, want 5", len(seen))
	}
}

func TestEventsComeBackInServerOrder(t *testing.T) {
	f := newSyncFixture(t)

	sent := make([]sync.EventID, 0, 4)
	for sequence := int64(1); sequence <= 4; sequence++ {
		envelope := f.envelope(f.till, sequence)
		f.record(t, envelope)
		sent = append(sent, envelope.ID)
	}

	pulled, err := f.events.Since(f.ctx, f.scope, 0, f.phone, 100)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(pulled) != 4 {
		t.Fatalf("got %d events, want 4", len(pulled))
	}
	for i, entry := range pulled {
		if entry.Event.ID() != sent[i] {
			t.Errorf("event %d is %s, want %s", i, entry.Event.ID(), sent[i])
		}
		if i > 0 && entry.ServerSequence <= pulled[i-1].ServerSequence {
			t.Errorf("server sequence did not advance at position %d", i)
		}
	}
}

// TestOneTenantsEventsNeverReachAnother is the boundary that matters most here:
// sync is the one place a business's whole history moves at once.
func TestOneTenantsEventsNeverReachAnother(t *testing.T) {
	first := newSyncFixture(t)
	second := newSyncFixture(t)

	first.record(t, first.envelope(first.till, 1))

	pulled, err := second.events.Since(second.ctx, second.scope, 0, second.till, 100)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(pulled) != 0 {
		t.Errorf("another tenant pulled %d events", len(pulled))
	}

	// And an event cannot be written into another tenant's log.
	event, err := sync.New(first.envelope(first.till, 2))
	if err != nil {
		t.Fatalf("sync.New: %v", err)
	}
	if _, err := second.events.Record(second.ctx, second.scope, event); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("got %v, want ErrCrossTenant", err)
	}
}

// TestARejectedEventIsKept: the device still holds the business record, and
// someone has to be able to see why it did not land.
func TestARejectedEventIsKept(t *testing.T) {
	f := newSyncFixture(t)

	envelope := f.envelope(f.till, 1)
	envelope.Type = "SOMETHING_THIS_BUILD_DOES_NOT_KNOW"

	outcome, err := f.events.Reject(f.ctx, f.scope, envelope, "unknown event type")
	if err != nil {
		t.Fatalf("Reject: %v", err)
	}
	if outcome != postgres.Recorded {
		t.Errorf("got %v, want Recorded", outcome)
	}

	rejected, err := f.events.Rejected(f.ctx, f.scope, 100)
	if err != nil {
		t.Fatalf("Rejected: %v", err)
	}
	if len(rejected) != 1 {
		t.Fatalf("got %d rejected events, want 1", len(rejected))
	}
	if rejected[0].RejectionReason != "unknown event type" {
		t.Errorf("RejectionReason = %q", rejected[0].RejectionReason)
	}
	if !rejected[0].Rejected {
		t.Error("a rejected event does not report itself rejected")
	}

	// A rejected event is not relayed to other devices: they cannot use what
	// this server could not.
	pulled, err := f.events.Since(f.ctx, f.scope, 0, f.phone, 100)
	if err != nil {
		t.Fatalf("Since: %v", err)
	}
	if len(pulled) != 0 {
		t.Errorf("a rejected event was relayed to %d devices", len(pulled))
	}
}

// TestRejectingTheSameEventTwiceIsIdempotent, for the same reason recording is.
func TestRejectingTheSameEventTwiceIsIdempotent(t *testing.T) {
	f := newSyncFixture(t)
	envelope := f.envelope(f.till, 1)

	if _, err := f.events.Reject(f.ctx, f.scope, envelope, "unknown event type"); err != nil {
		t.Fatalf("Reject: %v", err)
	}
	outcome, err := f.events.Reject(f.ctx, f.scope, envelope, "unknown event type")
	if err != nil {
		t.Fatalf("Reject: %v", err)
	}
	if outcome != postgres.AlreadyRecorded {
		t.Errorf("got %v, want AlreadyRecorded", outcome)
	}
}

// TestAnEventWithNoPayloadCanStillBeRejected covers why the column has a
// fallback: a payload that could not be read is a common reason to reject.
func TestAnEventWithNoPayloadCanStillBeRejected(t *testing.T) {
	f := newSyncFixture(t)

	envelope := f.envelope(f.till, 1)
	envelope.Payload = nil

	if _, err := f.events.Reject(f.ctx, f.scope, envelope, "the payload could not be read"); err != nil {
		t.Fatalf("Reject: %v", err)
	}
	rejected, err := f.events.Rejected(f.ctx, f.scope, 100)
	if err != nil {
		t.Fatalf("Rejected: %v", err)
	}
	if len(rejected) != 1 {
		t.Errorf("got %d rejected events, want 1", len(rejected))
	}
}

func TestLatestSequence(t *testing.T) {
	f := newSyncFixture(t)

	empty, err := f.events.LatestSequence(f.ctx, f.scope)
	if err != nil {
		t.Fatalf("LatestSequence: %v", err)
	}
	if empty != 0 {
		t.Errorf("a business with no events is at %d, want 0", empty)
	}

	f.record(t, f.envelope(f.till, 1))
	after, err := f.events.LatestSequence(f.ctx, f.scope)
	if err != nil {
		t.Fatalf("LatestSequence: %v", err)
	}
	if after <= 0 {
		t.Errorf("LatestSequence = %d, want it to advance", after)
	}
}

// TestAnEventNamingAnUnknownDeviceIsRefused is what stops one tenant
// attributing events to another's staff, and what the service turns into a
// per-event rejection.
func TestAnEventNamingAnUnknownDeviceIsRefused(t *testing.T) {
	f := newSyncFixture(t)

	envelope := f.envelope(devices.NewID(), 1)
	envelope.BusinessID = f.tenant

	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("sync.New: %v", err)
	}
	_, err = f.events.Record(f.ctx, f.scope, event)
	if err == nil {
		t.Fatal("an event naming an unregistered device was recorded")
	}
	if !postgres.IsForeignKeyViolation(err) {
		t.Errorf("got %v, want a foreign key violation", err)
	}
}

func TestSyncOperationsRefuseAnUnsetScope(t *testing.T) {
	f := newSyncFixture(t)
	envelope := f.envelope(f.till, 1)
	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("sync.New: %v", err)
	}

	var unset business.Scope

	operations := map[string]func() error{
		"Record":         func() error { _, err := f.events.Record(f.ctx, unset, event); return err },
		"Reject":         func() error { _, err := f.events.Reject(f.ctx, unset, envelope, "why"); return err },
		"Since":          func() error { _, err := f.events.Since(f.ctx, unset, 0, f.till, 10); return err },
		"LatestSequence": func() error { _, err := f.events.LatestSequence(f.ctx, unset); return err },
		"Get":            func() error { _, err := f.events.Get(f.ctx, unset, envelope.ID); return err },
		"Rejected":       func() error { _, err := f.events.Rejected(f.ctx, unset, 10); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestSyncOperationsRejectBadArguments(t *testing.T) {
	f := newSyncFixture(t)

	if _, err := f.events.Since(f.ctx, f.scope, 0, f.till, 0); err == nil {
		t.Error("Since accepted a zero limit")
	}
	if _, err := f.events.Rejected(f.ctx, f.scope, -1); err == nil {
		t.Error("Rejected accepted a negative limit")
	}
	if _, err := f.events.Get(f.ctx, f.scope, sync.EventID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := f.events.Get(f.ctx, f.scope, sync.NewEventID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := f.events.Reject(f.ctx, f.scope, f.envelope(f.till, 1), ""); err == nil {
		t.Error("Reject accepted an empty reason")
	}
}

// TestAStoredEventWithAnUnknownTypeStillReads covers a build older than its
// data: refusing to read it would make the whole pull fail for every device.
func TestAStoredEventWithAnUnknownTypeStillReads(t *testing.T) {
	f := newSyncFixture(t)
	pool := pgtest.Pool(t)

	envelope := f.envelope(f.till, 1)
	f.record(t, envelope)

	if _, err := pool.Exec(f.ctx,
		`UPDATE sync_events SET type = 'A_TYPE_FROM_A_NEWER_BUILD' WHERE event_id = $1`,
		envelope.ID.ID()); err != nil {
		t.Fatalf("planting the unknown type: %v", err)
	}

	pulled, err := f.events.Since(f.ctx, f.scope, 0, f.phone, 100)
	if err != nil {
		t.Fatalf("a stored event with an unfamiliar type broke the pull: %v", err)
	}
	if len(pulled) != 1 {
		t.Fatalf("got %d events, want 1", len(pulled))
	}
	if got := pulled[0].Event.Type(); got != "A_TYPE_FROM_A_NEWER_BUILD" {
		t.Errorf("Type() = %s, want it relayed unchanged", got)
	}
}

func TestSyncOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewSyncRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	envelope := sync.Envelope{
		ID: sync.NewEventID(), BusinessID: tenant, DeviceID: devices.NewID(),
		UserID: users.NewID(), Type: sync.StockMoved,
		Payload: json.RawMessage(`{}`), OccurredAt: createdAt, DeviceSequence: 1,
	}
	event, err := sync.New(envelope)
	if err != nil {
		t.Fatalf("sync.New: %v", err)
	}

	operations := map[string]func() error{
		"Record":         func() error { _, err := repo.Record(ctx, scope, event); return err },
		"Reject":         func() error { _, err := repo.Reject(ctx, scope, envelope, "why"); return err },
		"Since":          func() error { _, err := repo.Since(ctx, scope, 0, devices.ID{}, 10); return err },
		"LatestSequence": func() error { _, err := repo.LatestSequence(ctx, scope); return err },
		"Get":            func() error { _, err := repo.Get(ctx, scope, envelope.ID); return err },
		"Rejected":       func() error { _, err := repo.Rejected(ctx, scope, 10); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}
}
