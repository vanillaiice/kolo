package syncing_test

import (
	"context"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	domainsync "github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// fakeStore stands in for the event log.
//
// The real repository is tested against PostgreSQL, where its idempotency is a
// primary key rather than a map. What this fake is for is the service's own
// decisions — what a replay means, what a bad reference means, what happens
// when the store fails partway — which is exactly the sort of thing a real
// database makes awkward to arrange on demand.
//
// It keeps the idempotency behaviour faithful, because the service's answers
// depend on it.
type fakeStore struct {
	mu       sync.Mutex
	events   []domainsync.Envelope
	rejected []domainsync.Envelope
	sequence int64

	// lastLimit records what the service asked for, so a test can check the
	// batch cap is applied before the store is reached.
	lastLimit int

	failRecord       bool
	failLatest       bool
	failSince        bool
	refuseReferences bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{}
}

var errStoreUnavailable = errors.New("the store is unavailable")

func (f *fakeStore) Record(
	_ context.Context, scope business.Scope, event *domainsync.Event,
) (postgres.RecordOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failRecord {
		return postgres.Recorded, errStoreUnavailable
	}
	if f.refuseReferences {
		// What PostgreSQL raises when an event names a user or device that does
		// not exist, which the service turns into a single rejection.
		return postgres.Recorded, &pgconn.PgError{Code: "23503", ConstraintName: "sync_events_user_id_fkey"}
	}

	envelope := event.Envelope()
	if err := scope.Guard(envelope.BusinessID, business.BranchID{}); err != nil {
		return postgres.Recorded, err
	}

	for _, existing := range f.events {
		if existing.ID == envelope.ID {
			return postgres.AlreadyRecorded, nil
		}
	}
	f.sequence++
	f.events = append(f.events, envelope)
	return postgres.Recorded, nil
}

func (f *fakeStore) Reject(
	_ context.Context, scope business.Scope, envelope domainsync.Envelope, reason string,
) (postgres.RecordOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if reason == "" {
		return postgres.Recorded, errors.New("a rejection needs a reason")
	}
	if err := scope.Guard(envelope.BusinessID, business.BranchID{}); err != nil {
		return postgres.Recorded, err
	}

	for _, existing := range f.rejected {
		if existing.ID == envelope.ID {
			return postgres.AlreadyRecorded, nil
		}
	}
	f.sequence++
	f.rejected = append(f.rejected, envelope)
	return postgres.Recorded, nil
}

func (f *fakeStore) Since(
	_ context.Context, scope business.Scope, cursor int64, excludeDevice devices.ID, limit int,
) ([]postgres.StoredEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.lastLimit = limit
	if f.failSince {
		return nil, errStoreUnavailable
	}

	out := make([]postgres.StoredEvent, 0)
	for index, envelope := range f.events {
		sequence := int64(index + 1)
		if sequence <= cursor {
			continue
		}
		if !scope.Permits(envelope.BusinessID, business.BranchID{}) {
			continue
		}
		if !excludeDevice.IsZero() && envelope.DeviceID == excludeDevice {
			continue
		}

		event, err := domainsync.Restore(envelope)
		if err != nil {
			return nil, err
		}
		out = append(out, postgres.StoredEvent{Event: event, ServerSequence: sequence})
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (f *fakeStore) LatestSequence(_ context.Context, _ business.Scope) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failLatest {
		return 0, errStoreUnavailable
	}
	return f.sequence, nil
}

func (f *fakeStore) recorded() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.events)
}

func (f *fakeStore) rejectedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.rejected)
}

func (f *fakeStore) first() domainsync.Envelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.events) == 0 {
		return domainsync.Envelope{}
	}
	return f.events[0]
}

// lastRequestedLimit reports what the service last asked the store for, so a
// test can check the batch cap is applied before the store is reached.
func (f *fakeStore) lastRequestedLimit() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastLimit
}
