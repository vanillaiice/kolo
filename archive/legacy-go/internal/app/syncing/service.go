// Package syncing is the application service behind push and pull.
//
// It is the only place that decides what happens to an event the server cannot
// use. Those decisions are the substance of the subsystem, more than the
// transport is:
//
//   - A replay is a success. A device on a bad link often cannot tell whether
//     its push arrived, so it pushes again; telling it the event failed would
//     make it retry forever (§27).
//   - A bad event fails alone. One malformed event in a batch of a hundred must
//     not stop the other ninety-nine, or a single bad record could stop a shop
//     syncing indefinitely (§36).
//   - A rejection is kept, not dropped. The device still holds the business
//     record, and someone has to be able to see why it did not land.
package syncing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/expenses"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/domain/products"
	"github.com/vanillaiice/kolo/backend/internal/domain/suppliers"
	"github.com/vanillaiice/kolo/backend/internal/domain/sync"
	"github.com/vanillaiice/kolo/backend/internal/kernel/clock"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// Errors reported by this service.
var (
	// ErrInvalidRequest means a push or pull was malformed as a whole, as
	// opposed to one event within it being bad.
	ErrInvalidRequest = errors.New("syncing: invalid request")
	// ErrBatchTooLarge means a push carried more events than are accepted at
	// once.
	ErrBatchTooLarge = errors.New("syncing: batch is too large")
)

// Batch sizes.
//
// Connectivity is assumed slow, intermittent, and expensive (§45). A bounded
// batch is what lets a device back from a week offline make progress in pieces
// that can each succeed, rather than one push that fails as a unit and is
// retried forever.
const (
	// MaxPushBatch is the most events one push may carry.
	MaxPushBatch = 500
	// DefaultPullBatch is how many events a pull returns when the caller does
	// not say.
	DefaultPullBatch = 200
	// MaxPullBatch bounds what a caller may ask for.
	MaxPullBatch = 500
)

// EventStore is the storage this service needs. It is declared here, by the
// code that uses it (ADR-005).
type EventStore interface {
	Record(ctx context.Context, scope business.Scope, event *sync.Event) (postgres.RecordOutcome, error)
	// RecordAndApply stores an event and everything it changes in one
	// transaction. Recording without applying would tell the device the event
	// landed while what it recorded silently never arrived.
	RecordAndApply(ctx context.Context, scope business.Scope, event *sync.Event, effects postgres.Effects) (postgres.RecordOutcome, error)
	Reject(ctx context.Context, scope business.Scope, envelope sync.Envelope, reason string) (postgres.RecordOutcome, error)
	Since(ctx context.Context, scope business.Scope, cursor int64, excludeDevice devices.ID, limit int) ([]postgres.StoredEvent, error)
	LatestSequence(ctx context.Context, scope business.Scope) (int64, error)
}

// Service accepts events from devices and hands them to other devices.
type Service struct {
	events EventStore
	logger *slog.Logger
	clock  clock.Clock
}

// now is when the server learned of something, which is distinct from when it
// happened on the device (§7). A backlog from a week offline is recorded now and
// occurred then.
func (s *Service) now() time.Time { return s.clock.Now() }

// Options configures a Service.
type Options struct {
	// Logger receives notices about events the server refused. Defaults to the
	// standard logger.
	Logger *slog.Logger
	// Clock supplies the time an event was recorded. Defaults to the system
	// clock; a test supplies a fixed one.
	Clock clock.Clock
}

// NewService returns a service backed by the given store.
func NewService(events EventStore, options Options) *Service {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	timepiece := options.Clock
	if timepiece == nil {
		timepiece = clock.System{}
	}
	return &Service{events: events, logger: logger, clock: timepiece}
}

// Status says what became of one pushed event.
type Status string

const (
	// Accepted means the event was new and has been recorded.
	Accepted Status = "accepted"
	// Duplicate means the server already had it. The device may stop resending.
	Duplicate Status = "duplicate"
	// Rejected means the server cannot use it and never will. Resending will
	// not help, and the device should stop and surface it.
	Rejected Status = "rejected"
)

// Result is what happened to one event.
type Result struct {
	// EventID is the event this result is about. It is echoed even for an event
	// whose identifier could not be parsed, as the empty value, so a client can
	// still match results to what it sent by position.
	EventID string
	Status  Status
	// Reason explains a rejection, and is empty otherwise.
	Reason string
}

// Settled reports whether the device may stop sending this event.
//
// Accepted and duplicate both mean the server has it. Rejected means it never
// will, which is equally settled — the device stops retrying and surfaces it
// instead.
func (r Result) Settled() bool { return r.Status != "" }

// PushRequest is a batch of events from one device.
type PushRequest struct {
	// Scope is the tenant the caller is authenticated for. Every event is
	// checked against it, so a device cannot push events attributed to another
	// business whatever its payload says (ADR-008).
	Scope business.Scope
	// DeviceID is the device the caller is authenticated as.
	DeviceID devices.ID
	Events   []sync.Envelope
}

// PushResponse reports on each event and where the caller now stands.
type PushResponse struct {
	Results []Result
	// Cursor is the server's newest sequence for this business, so a client can
	// pull from here rather than from the beginning.
	Cursor int64
	// Accepted, Duplicates, and Rejected count the results, so a client can log
	// one line instead of walking the list.
	Accepted   int
	Duplicates int
	Rejected   int
}

// Push records a batch of events.
//
// Every event is handled on its own. A malformed one is rejected and the rest
// continue, because a device with one bad record must still be able to sync
// everything else it holds — the alternative is a shop stuck forever behind a
// single event it cannot fix from the till.
func (s *Service) Push(ctx context.Context, request PushRequest) (PushResponse, error) {
	if !request.Scope.Valid() {
		return PushResponse{}, fmt.Errorf("%w: no business", ErrInvalidRequest)
	}
	if request.DeviceID.IsZero() {
		return PushResponse{}, fmt.Errorf("%w: no device", ErrInvalidRequest)
	}
	if len(request.Events) > MaxPushBatch {
		return PushResponse{}, fmt.Errorf("%w: %d events, the limit is %d",
			ErrBatchTooLarge, len(request.Events), MaxPushBatch)
	}

	response := PushResponse{Results: make([]Result, 0, len(request.Events))}
	for _, envelope := range request.Events {
		result := s.handle(ctx, request, envelope)
		response.Results = append(response.Results, result)

		switch result.Status {
		case Accepted:
			response.Accepted++
		case Duplicate:
			response.Duplicates++
		case Rejected:
			response.Rejected++
		}
	}

	cursor, err := s.events.LatestSequence(ctx, request.Scope)
	if err != nil {
		// The events are recorded; only the cursor could not be read. Failing
		// the push would make the device resend everything it just delivered,
		// so the results stand and the client keeps the cursor it had.
		s.logger.ErrorContext(ctx, "could not read the cursor after a push", "error", err)
		return response, nil
	}
	response.Cursor = cursor
	return response, nil
}

// handle records one event, deciding on its own whether it can be used.
func (s *Service) handle(ctx context.Context, request PushRequest, envelope sync.Envelope) Result {
	identifier := envelope.ID.String()
	if envelope.ID.IsZero() {
		// Without an identifier there is nothing to deduplicate on, so it
		// cannot even be stored as a rejection. It is refused in the response
		// alone.
		return Result{Status: Rejected, Reason: "the event has no identifier"}
	}

	// The event's business and device come from the authenticated caller, not
	// from the payload. A device saying it belongs to another tenant is exactly
	// the attack ADR-008 exists to stop, and the quiet correction here means a
	// mislabelled event lands in the right place rather than being refused.
	envelope.BusinessID = request.Scope.Business()
	envelope.DeviceID = request.DeviceID

	event, err := sync.New(envelope)
	if err != nil {
		return s.reject(ctx, request.Scope, envelope, err.Error())
	}

	// An event is not merely filed, it is applied. A STOCK_MOVED that were only
	// logged would leave the server's ledger disagreeing with the device that
	// sent it, and §7 says stock is the sum of movements — so the movements have
	// to be there.
	//
	// An event type this build does not apply is still recorded and still handed
	// to other devices. It is a real event, and refusing it would strand a
	// device on a newer client with a backlog it can never clear.
	effects, err := s.effectsOf(request.Scope, envelope)
	if err != nil {
		// The payload is wrong and resending will not make it right.
		return s.reject(ctx, request.Scope, envelope, err.Error())
	}

	outcome, err := s.events.RecordAndApply(ctx, request.Scope, event, effects)
	if err != nil {
		// A reference the database refuses — a user who does not exist here —
		// is this event's problem, not the batch's.
		if postgres.IsForeignKeyViolation(err) {
			return s.reject(ctx, request.Scope, envelope,
				"the event names a user, device, or product this business does not have")
		}
		// A movement identifier the ledger already holds means this event's
		// effects are already in place under a different event — a client bug
		// rather than a transient fault, and resending will not clear it.
		if postgres.IsUniqueViolation(err) {
			return s.reject(ctx, request.Scope, envelope,
				"the event reuses a movement identifier the ledger already holds")
		}
		// Anything else is the server's fault. The device should retry, so this
		// is reported as unsettled rather than rejected.
		s.logger.ErrorContext(ctx, "could not record an event",
			"event", identifier, "error", err)
		return Result{EventID: identifier, Reason: "the server could not record this event"}
	}

	if outcome == postgres.AlreadyRecorded {
		return Result{EventID: identifier, Status: Duplicate}
	}
	return Result{EventID: identifier, Status: Accepted}
}

// effectsOf works out what an event changes, before anything is written.
//
// Deciding here rather than inside the transaction keeps the two apart: a
// payload this build cannot read is the event's own fault and is rejected,
// while a write that fails is the server's and is retried. Conflating them
// would either retry a bad payload forever or discard a sale over a hiccup.
func (s *Service) effectsOf(scope business.Scope, envelope sync.Envelope) (postgres.Effects, error) {
	switch envelope.Type {
	case sync.StockMoved:
		movements, err := stockMovements(scope, envelope, s.now())
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Movements: movements}, nil

	case sync.ProductSaved:
		product, err := savedProduct(scope, envelope)
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Products: []*products.Product{product}}, nil

	case sync.CustomerSaved:
		customer, err := savedCustomer(scope, envelope)
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Customers: []*customers.Customer{customer}}, nil

	case sync.ExpenseRecorded:
		expense, err := recordedExpense(scope, envelope, s.now())
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Spent: []*expenses.Expense{expense}}, nil

	case sync.CashMoved:
		movements, err := cashMovements(scope, envelope, s.now())
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Cash: movements}, nil

	case sync.AccountSaved:
		account, err := savedAccount(scope, envelope)
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Accounts: []*finance.Account{account}}, nil

	case sync.CustomerPaid:
		payment, err := customerPayment(scope, envelope, s.now())
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Credit: []*customers.Transaction{payment}}, nil

	case sync.SupplierSaved:
		supplier, err := savedSupplier(scope, envelope)
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Suppliers: []*suppliers.Supplier{supplier}}, nil

	case sync.SaleCompleted:
		return completedSale(scope, envelope, s.now())

	case sync.PurchaseRecorded:
		return recordedPurchase(scope, envelope, s.now())

	case sync.SupplierPaid:
		payment, err := supplierPayment(scope, envelope, s.now())
		if err != nil {
			return postgres.Effects{}, err
		}
		return postgres.Effects{Owed: []*suppliers.Transaction{payment}}, nil

	default:
		// Recorded and relayed, but not applied.
		return postgres.Effects{}, nil
	}
}

// reject records a refusal and reports it.
//
// The event is stored as rejected so an operator can see it, but a failure to
// store the rejection does not change the answer: the event is still refused,
// and the device must still stop resending it.
func (s *Service) reject(
	ctx context.Context, scope business.Scope, envelope sync.Envelope, reason string,
) Result {
	if _, err := s.events.Reject(ctx, scope, envelope, reason); err != nil {
		s.logger.ErrorContext(ctx, "could not record a rejected event",
			"event", envelope.ID.String(), "reason", reason, "error", err)
	}
	s.logger.WarnContext(ctx, "rejected an event",
		"event", envelope.ID.String(), "type", string(envelope.Type), "reason", reason)

	return Result{EventID: envelope.ID.String(), Status: Rejected, Reason: reason}
}

// PullRequest asks for what a device has not seen.
type PullRequest struct {
	Scope business.Scope
	// DeviceID is the caller, whose own events are left out: it already has
	// them, and returning them would make every sync pay twice (§45).
	DeviceID devices.ID
	// Cursor is where the caller left off. Zero means from the beginning, which
	// is what a newly registered device sends.
	Cursor int64
	// Limit bounds the batch. Zero means DefaultPullBatch.
	Limit int
}

// PullResponse carries events and the cursor to resume from.
type PullResponse struct {
	Events []sync.Envelope
	// Cursor is where the caller should resume. It advances even when no events
	// were returned, so a device seeing only its own traffic does not re-scan
	// the same rows forever.
	Cursor int64
	// HasMore says whether the batch was truncated, so a client knows to come
	// straight back rather than waiting for the next scheduled sync.
	HasMore bool
}

// Pull returns the events a device has not seen.
func (s *Service) Pull(ctx context.Context, request PullRequest) (PullResponse, error) {
	if !request.Scope.Valid() {
		return PullResponse{}, fmt.Errorf("%w: no business", ErrInvalidRequest)
	}
	if request.Cursor < 0 {
		return PullResponse{}, fmt.Errorf("%w: cursor %d is before the beginning",
			ErrInvalidRequest, request.Cursor)
	}

	limit := request.Limit
	if limit <= 0 {
		limit = DefaultPullBatch
	}
	if limit > MaxPullBatch {
		limit = MaxPullBatch
	}

	// One more than asked for, so a full batch can be distinguished from a
	// batch that happens to end exactly at the limit.
	stored, err := s.events.Since(ctx, request.Scope, request.Cursor, request.DeviceID, limit+1)
	if err != nil {
		return PullResponse{}, fmt.Errorf("syncing: pulling events: %w", err)
	}

	response := PullResponse{Cursor: request.Cursor}
	if len(stored) > limit {
		response.HasMore = true
		stored = stored[:limit]
	}

	response.Events = make([]sync.Envelope, 0, len(stored))
	for _, entry := range stored {
		response.Events = append(response.Events, entry.Event.Envelope())
		response.Cursor = entry.ServerSequence
	}

	// With nothing to return, the cursor still moves to wherever the business
	// has reached. Otherwise a device that only ever sees its own events would
	// re-scan them on every sync forever.
	if len(stored) == 0 {
		latest, err := s.events.LatestSequence(ctx, request.Scope)
		if err != nil {
			// Not fatal: the caller keeps the cursor it had and scans again
			// next time, which is slower but correct.
			s.logger.ErrorContext(ctx, "could not advance an empty pull's cursor", "error", err)
			return response, nil
		}
		if latest > response.Cursor {
			response.Cursor = latest
		}
	}

	return response, nil
}
