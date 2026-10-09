// Package postgres connects the backend to its server database.
//
// It is the outermost layer: everything here knows about a driver, and nothing
// above the repository boundary does (ADR-005). Domain types cross into driver
// types here and nowhere else.
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrConnect means the pool could not be opened or the database not reached.
var ErrConnect = errors.New("postgres: cannot connect")

// Defaults for a pool. They suit a single backend instance serving sync and
// API traffic; a deployment that needs different numbers sets them explicitly.
const (
	DefaultMaxConns        = 10
	DefaultMinConns        = 1
	DefaultMaxConnLifetime = time.Hour
	DefaultMaxConnIdleTime = 5 * time.Minute
	DefaultConnectTimeout  = 10 * time.Second
)

// Config describes how to reach the database.
type Config struct {
	// URL is a PostgreSQL connection string. Required.
	URL string
	// MaxConns bounds the pool. Zero means DefaultMaxConns.
	MaxConns int32
	// MinConns is how many connections are kept warm. Zero means DefaultMinConns.
	MinConns int32
	// MaxConnLifetime retires a connection after this long, so a rolling
	// database upgrade is picked up without a restart. Zero means the default.
	MaxConnLifetime time.Duration
	// MaxConnIdleTime closes connections left unused. Zero means the default.
	MaxConnIdleTime time.Duration
	// ConnectTimeout bounds the initial reachability check. Zero means the
	// default.
	ConnectTimeout time.Duration
}

func (c Config) withDefaults() Config {
	if c.MaxConns == 0 {
		c.MaxConns = DefaultMaxConns
	}
	if c.MinConns == 0 {
		c.MinConns = DefaultMinConns
	}
	if c.MaxConnLifetime == 0 {
		c.MaxConnLifetime = DefaultMaxConnLifetime
	}
	if c.MaxConnIdleTime == 0 {
		c.MaxConnIdleTime = DefaultMaxConnIdleTime
	}
	if c.ConnectTimeout == 0 {
		c.ConnectTimeout = DefaultConnectTimeout
	}
	return c
}

// Connect opens a pool and verifies the database is reachable.
//
// It fails fast rather than returning a pool that turns out to be unusable on
// first query, so a misconfigured deployment is obvious at startup. That is
// safe to do here because nothing on the client's critical path depends on this
// connection: the server being down must never stop a shop trading (ADR-001).
func Connect(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	cfg = cfg.withDefaults()

	if cfg.URL == "" {
		return nil, fmt.Errorf("%w: no database URL given", ErrConnect)
	}

	poolConfig, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		// The URL carries a password, so the driver's error is reported without
		// echoing what was parsed.
		return nil, fmt.Errorf("%w: invalid database URL: %w", ErrConnect, err)
	}
	poolConfig.MaxConns = cfg.MaxConns
	poolConfig.MinConns = cfg.MinConns
	poolConfig.MaxConnLifetime = cfg.MaxConnLifetime
	poolConfig.MaxConnIdleTime = cfg.MaxConnIdleTime

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrConnect, err)
	}

	reachable, cancel := context.WithTimeout(ctx, cfg.ConnectTimeout)
	defer cancel()
	if err := pool.Ping(reachable); err != nil {
		pool.Close()
		return nil, fmt.Errorf("%w: %w", ErrConnect, err)
	}

	return pool, nil
}
