package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/customers"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// CustomerRepository stores who a business sells to.
//
// It holds no balance. What a customer owes is the sum of their credit
// transactions, and a column here would be a second version of the same truth —
// the one number a shopkeeper and a customer will actually argue about (§13,
// §59). CreditRepository derives it.
type CustomerRepository struct {
	pool *pgxpool.Pool
}

// NewCustomerRepository returns a repository backed by the given pool.
func NewCustomerRepository(pool *pgxpool.Pool) *CustomerRepository {
	return &CustomerRepository{pool: pool}
}

const customerColumns = `id, business_id, name, phone, address, notes,
	credit_limit_minor, credit_limit_currency, active, created_at, updated_at,
	updated_by_device`

// customerInsert writes one customer row. Shared by the ordinary create and by
// the conflict-resolving upsert a sync event uses, so there is one column list.
const customerInsert = `
	INSERT INTO customers (` + customerColumns + `)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`

// customerValues lays a customer out in the order customerInsert expects.
func customerValues(customer *customers.Customer) []any {
	snapshot := customer.Snapshot()
	limit, limitCurrency := optionalMoney(snapshot.CreditLimit)
	return []any{
		snapshot.ID.ID(), snapshot.BusinessID.ID(), snapshot.Name,
		optionalPhone(snapshot.Phone), optionalText(snapshot.Address),
		optionalText(snapshot.Notes), limit, limitCurrency,
		snapshot.Active, snapshot.CreatedAt, snapshot.UpdatedAt,
		optionalDevice(snapshot.UpdatedByDevice),
	}
}

// Create stores a new customer within the scope's business.
func (r *CustomerRepository) Create(
	ctx context.Context, scope business.Scope, customer *customers.Customer,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if customer == nil {
		return fmt.Errorf("%w: no customer", ErrQuery)
	}
	snapshot := customer.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	if _, err := r.pool.Exec(ctx, customerInsert, customerValues(customer)...); err != nil {
		return wrapWrite("creating customer", err)
	}
	return nil
}

// Get returns a customer within the scope.
func (r *CustomerRepository) Get(
	ctx context.Context, scope business.Scope, customerID customers.ID,
) (*customers.Customer, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if customerID.IsZero() {
		return nil, fmt.Errorf("%w: no customer identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+customerColumns+` FROM customers WHERE id = $1 AND business_id = $2`,
		customerID.ID(), scope.Business().ID())
	return scanCustomer(row)
}

// List returns the scope's customers, ordered by name.
//
// activeOnly is what a till wants; an administration screen passes false to see
// those who have been closed.
func (r *CustomerRepository) List(
	ctx context.Context, scope business.Scope, activeOnly bool,
) ([]*customers.Customer, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+customerColumns+`
		FROM customers
		WHERE business_id = $1 AND (NOT $2::boolean OR active)
		ORDER BY name, id`,
		scope.Business().ID(), activeOnly)
	if err != nil {
		return nil, fmt.Errorf("%w: listing customers: %w", ErrQuery, err)
	}
	defer rows.Close()

	return collectCustomers(rows)
}

// FindByPhone returns everyone registered to a number within the scope.
//
// Several, deliberately. A number is how a customer is found at the counter,
// but it is not an identity: a household shares one phone, and returning a
// single record would be picking one of them arbitrarily. The caller — a
// cashier looking at two names — chooses.
func (r *CustomerRepository) FindByPhone(
	ctx context.Context, scope business.Scope, number phone.Number,
) ([]*customers.Customer, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if number.IsZero() {
		return nil, fmt.Errorf("%w: no phone number given", ErrNotFound)
	}

	// The stored form is E.164, which is what the phone type normalises to, so
	// 6 99 12 34 56 typed at a till matches +237699123456 in the table
	// (ADR-012).
	rows, err := r.pool.Query(ctx, `
		SELECT `+customerColumns+`
		FROM customers
		WHERE business_id = $1 AND phone = $2
		ORDER BY name, id`,
		scope.Business().ID(), number.String())
	if err != nil {
		return nil, fmt.Errorf("%w: finding customers by phone: %w", ErrQuery, err)
	}
	defer rows.Close()

	return collectCustomers(rows)
}

// Update writes a customer's current state, within the scope.
//
// A customer record is descriptive — a name, a number, a limit — so it is
// edited in place. Their credit history is not, and lives in a ledger that
// refuses an edit outright.
func (r *CustomerRepository) Update(
	ctx context.Context, scope business.Scope, customer *customers.Customer,
) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	if customer == nil {
		return fmt.Errorf("%w: no customer", ErrQuery)
	}
	snapshot := customer.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, business.BranchID{}); err != nil {
		return err
	}

	limit, limitCurrency := optionalMoney(snapshot.CreditLimit)
	tag, err := r.pool.Exec(ctx, `
		UPDATE customers
		SET name = $3, phone = $4, address = $5, notes = $6,
		    credit_limit_minor = $7, credit_limit_currency = $8,
		    active = $9, updated_at = $10, updated_by_device = $11
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), snapshot.Name,
		optionalPhone(snapshot.Phone), optionalText(snapshot.Address),
		optionalText(snapshot.Notes), limit, limitCurrency,
		snapshot.Active, snapshot.UpdatedAt, optionalDevice(snapshot.UpdatedByDevice))
	if err != nil {
		return wrapWrite("updating customer", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: customer %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

func collectCustomers(rows pgx.Rows) ([]*customers.Customer, error) {
	found := make([]*customers.Customer, 0)
	for rows.Next() {
		customer, err := scanCustomer(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, customer)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: reading customers: %w", ErrQuery, err)
	}
	return found, nil
}

func scanCustomer(row pgx.Row) (*customers.Customer, error) {
	var (
		snapshot                 customers.Snapshot
		rawID, rawOwner          uuid.UUID
		rawPhone, address, notes *string
		limitMinor               *int64
		limitCurrency            *string
		updatedByDevice          *uuid.UUID
	)
	err := row.Scan(&rawID, &rawOwner, &snapshot.Name, &rawPhone, &address, &notes,
		&limitMinor, &limitCurrency, &snapshot.Active,
		&snapshot.CreatedAt, &snapshot.UpdatedAt, &updatedByDevice)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading customer: %w", ErrQuery, err)
	}

	if rawPhone != nil {
		number, err := phone.Parse(*rawPhone)
		if err != nil {
			return nil, fmt.Errorf("%w: customer %s: %w", ErrQuery, rawID, err)
		}
		snapshot.Phone = number
	}
	if limitMinor != nil && limitCurrency != nil {
		currency, err := money.ByCode(*limitCurrency)
		if err != nil {
			return nil, fmt.Errorf("%w: customer %s: %w", ErrQuery, rawID, err)
		}
		limit, err := money.New(*limitMinor, currency)
		if err != nil {
			return nil, fmt.Errorf("%w: customer %s: %w", ErrQuery, rawID, err)
		}
		snapshot.CreditLimit = limit
	}

	if updatedByDevice != nil {
		snapshot.UpdatedByDevice = devices.IDFrom(*updatedByDevice)
	}
	snapshot.ID = customers.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	snapshot.Address = text(address)
	snapshot.Notes = text(notes)

	return customers.Restore(snapshot)
}

// optionalPhone renders an unrecorded number as SQL NULL.
//
// A customer without a phone is ordinary — a village shop's regulars may have
// none — so absence is stored as absence rather than as an empty string that
// would read as a recorded blank number.
func optionalPhone(number phone.Number) *string {
	if number.IsZero() {
		return nil
	}
	e164 := number.String()
	return &e164
}
