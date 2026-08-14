// Package pgtest gives repository tests a real PostgreSQL to run against.
//
// Repository tests are not run against a mock. The property most worth proving
// is that a query cannot reach another tenant's rows (ADR-008), and a mock
// would only replay whatever the test author assumed — it would pass just as
// happily against a repository that forgot its WHERE clause. So these tests
// need a live database, and skip loudly when one is not configured rather than
// quietly passing.
package pgtest

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// URLVariable names the environment variable holding the test database URL.
const URLVariable = "KOLO_TEST_DATABASE_URL"

const skipMessage = URLVariable + ` is not set, so there is no database to test against.

Start one and re-run:

    make db-up
    make test-integration

Or point at your own PostgreSQL:

    export ` + URLVariable + `=postgres://user:pass@localhost:5432/postgres`

var (
	// The migrated template is built once per test binary. Migrating is slow
	// relative to a test, and every test works in its own tenant anyway.
	once     sync.Once
	shared   *pgxpool.Pool
	setupErr error
)

// Pool returns a pool against a migrated test database, skipping the test if no
// database is configured.
//
// Every test shares one database. That is safe because every row is
// tenant-scoped and each test works under freshly generated identifiers, so
// tests cannot see each other's data — which is the same property the
// production code relies on, exercised incidentally by the whole suite.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	url := strings.TrimSpace(os.Getenv(URLVariable))
	if url == "" {
		t.Skip(skipMessage)
	}

	once.Do(func() { shared, setupErr = prepare(url) })
	if setupErr != nil {
		t.Fatalf("preparing the test database: %v", setupErr)
	}
	return shared
}

// prepare creates a database for this test binary and migrates it.
//
// A dedicated database, rather than the one named in the URL, keeps a test run
// from touching whatever else lives on that server — including a developer's
// own data if they pointed the variable at a real instance.
func prepare(url string) (*pgxpool.Pool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	admin, err := postgres.Connect(ctx, postgres.Config{URL: url, MaxConns: 2})
	if err != nil {
		return nil, err
	}
	defer admin.Close()

	name := databaseName()
	// The name is generated here from a UUID, never from input, so it cannot
	// carry anything an identifier should not.
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		return nil, fmt.Errorf("creating database %q: %w", name, err)
	}

	pool, err := postgres.Connect(ctx, postgres.Config{URL: replaceDatabase(url, name)})
	if err != nil {
		return nil, err
	}

	if _, err := postgres.Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// databaseName returns a name unique to this test binary run.
func databaseName() string {
	unique := strings.ReplaceAll(id.New().String(), "-", "")
	return "kolo_test_" + unique
}

// replaceDatabase points a connection URL at a different database, leaving the
// host, credentials, and options alone.
func replaceDatabase(url, name string) string {
	scheme, rest, found := strings.Cut(url, "://")
	if !found {
		return url
	}
	authority, tail, hasPath := strings.Cut(rest, "/")
	if !hasPath {
		return scheme + "://" + authority + "/" + name
	}

	options := ""
	if _, query, hasQuery := strings.Cut(tail, "?"); hasQuery {
		options = "?" + query
	}
	return scheme + "://" + authority + "/" + name + options
}
