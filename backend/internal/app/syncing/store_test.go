package syncing_test

import (
	"context"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
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

	// movements holds what each applied event moved, so a test can check the
	// service applied an event rather than merely filing it.
	movements map[domainsync.EventID][]*inventory.Movement
	// appliedIDs is every movement identifier the ledger holds, standing in for
	// the real table's primary key.
	appliedIDs map[inventory.MovementID]bool
	// products is the product table, holding whichever edit won.
	products map[products.ID]*products.Product
	// sales and salePayments are the sale tables. A sale is immutable, so a
	// second one under the same identifier is refused as the primary key would.
	sales        map[sales.ID]*sales.Sale
	salePayments map[sales.ID][]*sales.Payment
	// credit is the customer ledger, keyed as the real table is: by the entry's
	// own identifier, so a replay collides rather than doubling a debt.
	credit map[customers.TransactionID]*customers.Transaction

	failRecord       bool
	failLatest       bool
	failSince        bool
	refuseReferences bool
	// failApply makes the write of the movements fail while the event itself
	// would have succeeded — the split that must never leave the event stored.
	failApply bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		movements:    make(map[domainsync.EventID][]*inventory.Movement),
		appliedIDs:   make(map[inventory.MovementID]bool),
		products:     make(map[products.ID]*products.Product),
		sales:        make(map[sales.ID]*sales.Sale),
		salePayments: make(map[sales.ID][]*sales.Payment),
		credit:       make(map[customers.TransactionID]*customers.Transaction),
	}
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

// RecordWithMovements files an event and its movements together, or neither.
//
// The real repository gets that from a transaction. This fake gets it from
// checking everything before it writes anything, which is the same guarantee by
// a cruder route — and it is the guarantee the service is entitled to assume.
func (f *fakeStore) RecordAndApply(
	_ context.Context, scope business.Scope, event *domainsync.Event, effects postgres.Effects,
) (postgres.RecordOutcome, error) {
	movements := effects.Movements
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.failRecord {
		return postgres.Recorded, errStoreUnavailable
	}
	if f.refuseReferences {
		return postgres.Recorded, &pgconn.PgError{Code: "23503", ConstraintName: "inventory_movements_product_id_fkey"}
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

	for _, movement := range movements {
		snapshot := movement.Snapshot()
		if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
			return postgres.Recorded, err
		}
		if f.appliedIDs[snapshot.ID] {
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "inventory_movements_pkey"}
		}
	}
	if f.failApply {
		// Nothing above was written, which is the point: the caller sees a
		// failure and the event is not in the log.
		return postgres.Recorded, errStoreUnavailable
	}

	for _, movement := range movements {
		f.appliedIDs[movement.Snapshot().ID] = true
	}
	if effects.Sale != nil {
		saleID := effects.Sale.ID()
		if err := scope.Guard(effects.Sale.BusinessID(), business.BranchID{}); err != nil {
			return postgres.Recorded, err
		}
		if _, exists := f.sales[saleID]; exists {
			// Financial history is immutable: a second sale under the same
			// identifier is the primary key's answer, not an overwrite (§41).
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "sales_pkey"}
		}
		f.sales[saleID] = effects.Sale
		f.salePayments[saleID] = effects.Payments
	}
	if effects.Credit != nil {
		if err := scope.Guard(effects.Credit.BusinessID(), effects.Credit.BranchID()); err != nil {
			return postgres.Recorded, err
		}
		if _, exists := f.credit[effects.Credit.ID()]; exists {
			// The ledger is append-only, so a second entry under one identifier
			// is the primary key's answer rather than an overwrite (§13, §41).
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "customer_transactions_pkey"}
		}
		f.credit[effects.Credit.ID()] = effects.Credit
	}

	f.sequence++
	f.events = append(f.events, envelope)
	f.movements[envelope.ID] = movements

	// Last-write-wins, the same comparison the real upsert makes (ADR-015), so
	// the service is tested against the rule rather than against a map that
	// always accepts.
	for _, product := range effects.Products {
		snapshot := product.Snapshot()
		if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
			return postgres.Recorded, err
		}
		held, seen := f.products[snapshot.ID]
		if seen && !wins(snapshot, held.Snapshot()) {
			continue
		}
		f.products[snapshot.ID] = product
	}
	return postgres.Recorded, nil
}

// wins reports whether an incoming edit beats the one already held, ordered by
// (updated_at, updated_by_device) exactly as the database does.
func wins(incoming, held products.Snapshot) bool {
	if !incoming.UpdatedAt.Equal(held.UpdatedAt) {
		return incoming.UpdatedAt.After(held.UpdatedAt)
	}
	return incoming.UpdatedByDevice.String() > held.UpdatedByDevice.String()
}

// product returns the product the store holds, if any.
func (f *fakeStore) product(id products.ID) *products.Product {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.products[id]
}

// sale returns the sale the store holds, if any.
func (f *fakeStore) sale(id sales.ID) *sales.Sale {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sales[id]
}

// paymentsOf returns what was recorded against a sale.
func (f *fakeStore) paymentsOf(id sales.ID) []*sales.Payment {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.salePayments[id]
}

// creditOf returns the ledger entries recorded against a customer.
func (f *fakeStore) creditOf(customerID customers.ID) []*customers.Transaction {
	f.mu.Lock()
	defer f.mu.Unlock()

	found := make([]*customers.Transaction, 0, len(f.credit))
	for _, entry := range f.credit {
		if entry.CustomerID() == customerID {
			found = append(found, entry)
		}
	}
	return found
}

// applied reports how many movements an event was recorded as having moved.
func (f *fakeStore) applied(eventID domainsync.EventID) []*inventory.Movement {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.movements[eventID]
}

// appliedTotal counts every movement in the ledger.
func (f *fakeStore) appliedTotal() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.appliedIDs)
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
