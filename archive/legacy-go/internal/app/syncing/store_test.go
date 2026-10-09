package syncing_test

import (
	"context"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/expenses"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/inventory"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/purchases"
	"github.com/vanillaiice/kolo/backend/internal/domain/sales"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
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
	// customerRecords is the customer table, likewise holding the winning edit.
	// Distinct from credit below: a customer is state, their debts are not.
	customerRecords map[customers.ID]*customers.Customer
	// accounts is the financial account table, resolved the same way again.
	accounts map[finance.AccountID]*finance.Account
	// cash is money moved by hand, appended and keyed by the movement's own
	// identifier so a replay collides rather than moving money twice.
	cash map[finance.MovementID]*finance.Movement
	// spent is what the business paid out that did not become stock.
	spent map[expenses.ID]*expenses.Expense
	// sales and salePayments are the sale tables. A sale is immutable, so a
	// second one under the same identifier is refused as the primary key would.
	sales        map[sales.ID]*sales.Sale
	salePayments map[sales.ID][]*sales.Payment
	// credit is the customer ledger, keyed as the real table is: by the entry's
	// own identifier, so a replay collides rather than doubling a debt.
	credit map[customers.TransactionID]*customers.Transaction
	// supplierRecords is the supplier table, holding the winning edit. State,
	// like a customer; what the business owes them is the ledger below.
	supplierRecords map[suppliers.ID]*suppliers.Supplier
	// purchases is the delivery table. Immutable, so a second one under the
	// same identifier is refused as the primary key would.
	purchases map[purchases.ID]*purchases.Purchase
	// owed is the supplier ledger, keyed by the entry's own identifier so a
	// replay collides rather than doubling what the shop owes.
	owed map[suppliers.TransactionID]*suppliers.Transaction

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
		movements:       make(map[domainsync.EventID][]*inventory.Movement),
		appliedIDs:      make(map[inventory.MovementID]bool),
		products:        make(map[products.ID]*products.Product),
		customerRecords: make(map[customers.ID]*customers.Customer),
		accounts:        make(map[finance.AccountID]*finance.Account),
		cash:            make(map[finance.MovementID]*finance.Movement),
		spent:           make(map[expenses.ID]*expenses.Expense),
		sales:           make(map[sales.ID]*sales.Sale),
		salePayments:    make(map[sales.ID][]*sales.Payment),
		credit:          make(map[customers.TransactionID]*customers.Transaction),
		supplierRecords: make(map[suppliers.ID]*suppliers.Supplier),
		purchases:       make(map[purchases.ID]*purchases.Purchase),
		owed:            make(map[suppliers.TransactionID]*suppliers.Transaction),
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
	for _, entry := range effects.Credit {
		if err := scope.Guard(entry.BusinessID(), entry.BranchID()); err != nil {
			return postgres.Recorded, err
		}
		if _, exists := f.credit[entry.ID()]; exists {
			// The ledger is append-only, so a second entry under one identifier
			// is the primary key's answer rather than an overwrite (§13, §41).
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "customer_transactions_pkey"}
		}
		f.credit[entry.ID()] = entry
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

	// The same rule for customers, since they are state in exactly the same
	// sense (ADR-015).
	for _, customer := range effects.Customers {
		if err := scope.Guard(customer.BusinessID(), business.BranchID{}); err != nil {
			return postgres.Recorded, err
		}
		held, seen := f.customerRecords[customer.ID()]
		if seen && !customerWins(customer, held) {
			continue
		}
		f.customerRecords[customer.ID()] = customer
	}

	for _, account := range effects.Accounts {
		if err := scope.Guard(account.BusinessID(), account.BranchID()); err != nil {
			return postgres.Recorded, err
		}
		held, seen := f.accounts[account.ID()]
		if seen && !accountWins(account, held) {
			continue
		}
		f.accounts[account.ID()] = account
	}

	for _, movement := range effects.Cash {
		if err := scope.Guard(movement.BusinessID(), movement.BranchID()); err != nil {
			return postgres.Recorded, err
		}
		if _, exists := f.cash[movement.ID()]; exists {
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "account_movements_pkey"}
		}
		f.cash[movement.ID()] = movement
	}

	for _, expense := range effects.Spent {
		if err := scope.Guard(expense.BusinessID(), expense.BranchID()); err != nil {
			return postgres.Recorded, err
		}
		if _, exists := f.spent[expense.ID()]; exists {
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "expenses_pkey"}
		}
		f.spent[expense.ID()] = expense
	}

	// A supplier is state, resolved by the same rule again (ADR-015).
	for _, supplier := range effects.Suppliers {
		if err := scope.Guard(supplier.BusinessID(), business.BranchID{}); err != nil {
			return postgres.Recorded, err
		}
		held, seen := f.supplierRecords[supplier.ID()]
		if seen && !supplierWins(supplier, held) {
			continue
		}
		f.supplierRecords[supplier.ID()] = supplier
	}

	if effects.Purchase != nil {
		if err := scope.Guard(effects.Purchase.BusinessID(), effects.Purchase.BranchID()); err != nil {
			return postgres.Recorded, err
		}
		if _, exists := f.purchases[effects.Purchase.ID()]; exists {
			// What a delivery cost is financial history, so a second one under
			// the same identifier is the primary key's answer (§41).
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "purchases_pkey"}
		}
		f.purchases[effects.Purchase.ID()] = effects.Purchase
	}
	for _, entry := range effects.Owed {
		if err := scope.Guard(entry.BusinessID(), entry.BranchID()); err != nil {
			return postgres.Recorded, err
		}
		if _, exists := f.owed[entry.ID()]; exists {
			return postgres.Recorded, &pgconn.PgError{Code: "23505", ConstraintName: "supplier_transactions_pkey"}
		}
		f.owed[entry.ID()] = entry
	}
	return postgres.Recorded, nil
}

// supplierWins is the product comparison over a supplier's two fields.
func supplierWins(incoming, held *suppliers.Supplier) bool {
	if !incoming.UpdatedAt().Equal(held.UpdatedAt()) {
		return incoming.UpdatedAt().After(held.UpdatedAt())
	}
	return incoming.UpdatedByDevice().String() > held.UpdatedByDevice().String()
}

// supplier returns the supplier the store holds, if any.
func (f *fakeStore) supplier(id suppliers.ID) *suppliers.Supplier {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.supplierRecords[id]
}

// purchase returns the delivery the store holds, if any.
func (f *fakeStore) purchase(id purchases.ID) *purchases.Purchase {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.purchases[id]
}

// owedTo returns the ledger entries recorded against a supplier.
func (f *fakeStore) owedTo(supplierID suppliers.ID) []*suppliers.Transaction {
	f.mu.Lock()
	defer f.mu.Unlock()

	found := make([]*suppliers.Transaction, 0, len(f.owed))
	for _, entry := range f.owed {
		if entry.SupplierID() == supplierID {
			found = append(found, entry)
		}
	}
	return found
}

// expenseOf returns the expense the store holds, if any.
func (f *fakeStore) expenseOf(id expenses.ID) *expenses.Expense {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.spent[id]
}

// cashOf returns the movements recorded against an account.
func (f *fakeStore) cashOf(accountID finance.AccountID) []*finance.Movement {
	f.mu.Lock()
	defer f.mu.Unlock()

	found := make([]*finance.Movement, 0, len(f.cash))
	for _, movement := range f.cash {
		if movement.AccountID() == accountID {
			found = append(found, movement)
		}
	}
	return found
}

// accountWins is the same comparison over an account's two fields.
func accountWins(incoming, held *finance.Account) bool {
	if !incoming.UpdatedAt().Equal(held.UpdatedAt()) {
		return incoming.UpdatedAt().After(held.UpdatedAt())
	}
	return incoming.UpdatedByDevice().String() > held.UpdatedByDevice().String()
}

// account returns the account the store holds, if any.
func (f *fakeStore) account(id finance.AccountID) *finance.Account {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.accounts[id]
}

// customerWins is the product comparison over a customer's two fields.
func customerWins(incoming, held *customers.Customer) bool {
	if !incoming.UpdatedAt().Equal(held.UpdatedAt()) {
		return incoming.UpdatedAt().After(held.UpdatedAt())
	}
	return incoming.UpdatedByDevice().String() > held.UpdatedByDevice().String()
}

// customer returns the customer the store holds, if any.
func (f *fakeStore) customer(id customers.ID) *customers.Customer {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.customerRecords[id]
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
