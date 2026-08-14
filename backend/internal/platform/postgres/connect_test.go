package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// Connecting is checked without a database as well as with one: a
// misconfiguration must be obvious at startup rather than at the first query.

func TestConnectRejectsAnUnusableConfiguration(t *testing.T) {
	tests := []struct {
		name string
		url  string
	}{
		{"no URL", ""},
		{"whitespace only", "   "},
		{"not a URL", "nonsense"},
		{"wrong scheme", "mysql://user:pass@localhost:3306/db"},
		{"malformed port", "postgres://user:pass@localhost:notaport/db"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			pool, err := postgres.Connect(ctx, postgres.Config{URL: tc.url})
			if !errors.Is(err, postgres.ErrConnect) {
				t.Errorf("got %v, want ErrConnect", err)
			}
			if pool != nil {
				pool.Close()
				t.Error("returned a pool alongside an error")
			}
		})
	}
}

// TestConnectFailsFastWhenTheServerIsUnreachable is the behaviour that makes a
// bad deployment visible immediately. It is safe to fail here because nothing
// on a shop's critical path depends on this connection (ADR-001).
func TestConnectFailsFastWhenTheServerIsUnreachable(t *testing.T) {
	// Port 1 is reserved and nothing listens on it.
	const unreachable = "postgres://kolo:kolo@127.0.0.1:1/kolo?sslmode=disable"

	started := time.Now()
	pool, err := postgres.Connect(context.Background(), postgres.Config{
		URL:            unreachable,
		ConnectTimeout: 3 * time.Second,
	})
	elapsed := time.Since(started)

	if err == nil {
		pool.Close()
		t.Fatal("connecting to an unreachable server succeeded")
	}
	if !errors.Is(err, postgres.ErrConnect) {
		t.Errorf("got %v, want ErrConnect", err)
	}
	if elapsed > 10*time.Second {
		t.Errorf("took %s to give up, want it bounded by the connect timeout", elapsed)
	}
}

// TestConnectDoesNotEchoTheURL keeps credentials out of a startup log, since a
// connection string carries a password.
func TestConnectDoesNotEchoTheURL(t *testing.T) {
	const secret = "hunter2correcthorse"
	url := "postgres://kolo:" + secret + "@localhost:notaport/kolo"

	_, err := postgres.Connect(context.Background(), postgres.Config{URL: url})
	if err == nil {
		t.Fatal("connecting with a malformed URL succeeded")
	}
	if strings.Contains(err.Error(), secret) {
		t.Errorf("the error leaked the password: %v", err)
	}
}

func TestConnectAppliesDefaults(t *testing.T) {
	pool := pgtest.Pool(t)

	config := pool.Config()
	if config.MaxConns <= 0 {
		t.Errorf("MaxConns = %d, want a positive bound", config.MaxConns)
	}
	if config.MaxConnLifetime <= 0 {
		t.Errorf("MaxConnLifetime = %s, want connections to be retired eventually", config.MaxConnLifetime)
	}
}

// TestMigrateDownStepsBackOneVersion covers the developer escape hatch. It runs
// against a database of its own, because it changes the schema rather than the
// data.
func TestMigrateDownStepsBackOneVersion(t *testing.T) {
	pool := pgtest.FreshPool(t)
	ctx := context.Background()

	before, err := postgres.SchemaVersion(ctx, pool)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if before < 2 {
		t.Fatalf("the database is at version %d, so there is nothing to step back from", before)
	}

	if err := postgres.MigrateDown(ctx, pool); err != nil {
		t.Fatalf("MigrateDown: %v", err)
	}

	after, err := postgres.SchemaVersion(ctx, pool)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if after != before-1 {
		t.Errorf("version went from %d to %d, want %d", before, after, before-1)
	}

	// And stepping back up restores it, so the pair is usable iteratively.
	applied, err := postgres.Migrate(ctx, pool)
	if err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if len(applied) != 1 {
		t.Errorf("re-applying gave %d migrations, want 1", len(applied))
	}

	restored, err := postgres.SchemaVersion(ctx, pool)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if restored != before {
		t.Errorf("version = %d after stepping back up, want %d", restored, before)
	}
}
