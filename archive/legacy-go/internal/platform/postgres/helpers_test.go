package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/finance"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// These helpers insert rows with raw SQL rather than through a repository, so
// the schema tests exercise the constraints themselves and do not pass or fail
// on repository behaviour.

func newUUID(t *testing.T) uuid.UUID {
	t.Helper()
	return id.New()
}

func insertBusiness(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()

	tenant := newUUID(t)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO businesses (id, name, currency, active, created_at, updated_at)
		VALUES ($1, 'Boutique Chez Jean', 'XAF', true, now(), now())`, tenant)
	if err != nil {
		t.Fatalf("inserting a business: %v", err)
	}
	return tenant
}

func insertBranch(t *testing.T, pool *pgxpool.Pool, tenant uuid.UUID) uuid.UUID {
	t.Helper()

	branch := newUUID(t)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO branches (id, business_id, name, active, created_at, updated_at)
		VALUES ($1, $2, 'Marché Central', true, now(), now())`, branch, tenant)
	if err != nil {
		t.Fatalf("inserting a branch: %v", err)
	}
	return branch
}

func insertUser(t *testing.T, pool *pgxpool.Pool, tenant uuid.UUID) uuid.UUID {
	t.Helper()

	user := newUUID(t)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO users (id, business_id, name, role, active, created_at, updated_at)
		VALUES ($1, $2, 'Jean Mbarga', 'CASHIER', true, now(), now())`, user, tenant)
	if err != nil {
		t.Fatalf("inserting a user: %v", err)
	}
	return user
}

// openAccount creates a financial account for money to land in.
//
// Since 00010 a payment names a real account, so every test that takes money
// needs one. Created through the repository rather than by raw SQL, because
// what is under test here is the payment, not the account.
func openAccount(
	t *testing.T, pool *pgxpool.Pool, ctx context.Context,
	scope business.Scope, tenant business.ID, name string,
) finance.AccountID {
	t.Helper()

	account, err := finance.NewAccount(finance.AccountSnapshot{
		ID:         finance.NewAccountID(),
		BusinessID: tenant,
		Name:       name,
		Kind:       finance.Cash,
		Currency:   money.XAF,
		CreatedAt:  createdAt,
	})
	if err != nil {
		t.Fatalf("finance.NewAccount: %v", err)
	}
	if err := postgres.NewAccountRepository(pool).Create(ctx, scope, account); err != nil {
		t.Fatalf("creating an account: %v", err)
	}
	return account.ID()
}

// isForeignKeyViolation distinguishes a referential failure from any other
// database error, so a test asserting on the boundary cannot pass because of an
// unrelated fault.
//
// PostgreSQL reports two distinct codes here. A row referring to something that
// does not exist is a foreign key violation; a deletion blocked by ON DELETE
// RESTRICT is a restrict violation. Both mean the reference held.
func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	const (
		foreignKeyViolation = "23503"
		restrictViolation   = "23001"
	)
	return pgErr.Code == foreignKeyViolation || pgErr.Code == restrictViolation
}
