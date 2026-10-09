package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/vanillaiice/kolo/backend/migrations"
)

// ErrMigrate means the schema could not be brought up to date.
var ErrMigrate = errors.New("postgres: migration failed")

// AppliedMigration records one migration that ran.
type AppliedMigration struct {
	Version int64
	Name    string
}

// Migrate brings the schema up to the latest embedded version and reports
// which migrations it applied. Applying none is success, not an error: it means
// the schema was already current.
//
// Migrations are forward-only in production. Rollback is not a strategy for a
// database holding financial history that §40 says is never destroyed; a
// mistake is corrected by a further migration (ADR-013).
func Migrate(ctx context.Context, pool *pgxpool.Pool) ([]AppliedMigration, error) {
	provider, closeProvider, err := newProvider(pool)
	if err != nil {
		return nil, err
	}
	defer closeProvider()

	results, err := provider.Up(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrMigrate, err)
	}

	applied := make([]AppliedMigration, 0, len(results))
	for _, result := range results {
		applied = append(applied, AppliedMigration{Version: result.Source.Version, Name: result.Source.Path})
	}
	return applied, nil
}

// MigrateDown reverts the most recent migration.
//
// It exists so a developer can step back locally. It is not for production —
// see Migrate.
func MigrateDown(ctx context.Context, pool *pgxpool.Pool) error {
	provider, closeProvider, err := newProvider(pool)
	if err != nil {
		return err
	}
	defer closeProvider()

	if _, err := provider.Down(ctx); err != nil {
		return fmt.Errorf("%w: %w", ErrMigrate, err)
	}
	return nil
}

// SchemaVersion returns the version the database is currently at. A database
// with no migrations applied is at version zero.
func SchemaVersion(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	provider, closeProvider, err := newProvider(pool)
	if err != nil {
		return 0, err
	}
	defer closeProvider()

	statuses, err := provider.Status(ctx)
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrMigrate, err)
	}

	var current int64
	for _, status := range statuses {
		if status.State == goose.StateApplied && status.Source.Version > current {
			current = status.Source.Version
		}
	}
	return current, nil
}

// newProvider adapts the pool to the migration runner, which works in terms of
// database/sql. The returned function releases the adapter, not the pool.
func newProvider(pool *pgxpool.Pool) (*goose.Provider, func(), error) {
	db := stdlib.OpenDBFromPool(pool)

	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		_ = db.Close()
		return nil, nil, fmt.Errorf("%w: %w", ErrMigrate, err)
	}
	return provider, func() { _ = db.Close() }, nil
}
