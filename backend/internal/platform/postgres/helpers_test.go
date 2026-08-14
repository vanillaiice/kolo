package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
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
