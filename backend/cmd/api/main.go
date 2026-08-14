// Command api serves the KOLO backend.
//
// It is deliberately thin: it reads configuration, opens the database, wires
// the layers together, and serves. Every decision it makes is about how to
// start and stop, not about the business.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/api"
	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

func main() {
	if err := run(); err != nil {
		slog.Error("the server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	config, err := loadConfig()
	if err != nil {
		return err
	}
	logger := newLogger(config)
	slog.SetDefault(logger)

	// Signals are handled from the start, so a container killed during startup
	// stops rather than ignoring the request until it is serving.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := postgres.Connect(ctx, postgres.Config{URL: config.databaseURL})
	if err != nil {
		return err
	}
	defer pool.Close()

	if config.migrateOnStart {
		applied, err := postgres.Migrate(ctx, pool)
		if err != nil {
			return err
		}
		for _, migration := range applied {
			logger.Info("applied a migration", "version", migration.Version, "name", migration.Name)
		}
	}

	version, err := postgres.SchemaVersion(ctx, pool)
	if err != nil {
		return err
	}
	logger.Info("connected to the database", "schema_version", version)

	server := api.NewServer(config.address, api.NewRouter(api.Config{
		Auth:   newAuthService(pool, logger),
		Sync:   syncing.NewService(postgres.NewSyncRepository(pool), syncing.Options{Logger: logger}),
		Health: healthCheck{pool: pool},
		Logger: logger,
	}))

	return serve(ctx, server, logger, config.shutdownGrace)
}

func newAuthService(pool *pgxpool.Pool, logger *slog.Logger) *authn.Service {
	return authn.NewService(
		postgres.NewCredentialRepository(pool),
		postgres.NewUserRepository(pool),
		postgres.NewDeviceRepository(pool),
		postgres.NewSessionRepository(pool),
		authn.Options{Logger: logger},
	)
}

// serve runs the server until the context is cancelled, then drains.
//
// In-flight requests are given time to finish rather than being cut off: a
// sale being recorded when a deployment rolls is exactly the request that must
// not be lost.
func serve(ctx context.Context, server *http.Server, logger *slog.Logger, grace time.Duration) error {
	failed := make(chan error, 1)
	go func() {
		logger.Info("serving", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			failed <- err
		}
	}()

	select {
	case err := <-failed:
		return fmt.Errorf("serving: %w", err)
	case <-ctx.Done():
		logger.Info("shutting down", "grace", grace)
	}

	draining, cancel := context.WithTimeout(context.WithoutCancel(ctx), grace)
	defer cancel()

	if err := server.Shutdown(draining); err != nil {
		// The deadline passed with requests still running. Reported rather than
		// hidden: it means the grace period is too short for what this server
		// does.
		return fmt.Errorf("shutting down: %w", err)
	}
	logger.Info("stopped cleanly")
	return nil
}

// healthCheck reports whether the database is reachable.
type healthCheck struct {
	pool *pgxpool.Pool
}

// Check pings the database, bounded so a hung connection does not hang the
// readiness probe as well.
func (h healthCheck) Check(r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := h.pool.Ping(ctx); err != nil {
		return fmt.Errorf("database unreachable: %w", err)
	}
	return nil
}

// config is everything the process needs to start.
type config struct {
	address        string
	databaseURL    string
	migrateOnStart bool
	shutdownGrace  time.Duration
	logLevel       slog.Level
	logJSON        bool
}

// Environment variables the process reads.
const (
	envAddress     = "KOLO_ADDRESS"
	envDatabaseURL = "KOLO_DATABASE_URL"
	envMigrate     = "KOLO_MIGRATE_ON_START"
	envGrace       = "KOLO_SHUTDOWN_GRACE"
	envLogLevel    = "KOLO_LOG_LEVEL"
	envLogFormat   = "KOLO_LOG_FORMAT"
)

func loadConfig() (config, error) {
	loaded := config{
		address: envOr(envAddress, ":8080"),
		// Applying migrations at startup suits a single-instance deployment and
		// is how the development database is brought up. A deployment running
		// several instances should turn it off and migrate as its own step,
		// rather than have instances race to apply the same change.
		migrateOnStart: envBool(envMigrate, true),
		shutdownGrace:  30 * time.Second,
		logJSON:        envOr(envLogFormat, "json") == "json",
	}

	loaded.databaseURL = os.Getenv(envDatabaseURL)
	if loaded.databaseURL == "" {
		return config{}, fmt.Errorf("%s is not set, so there is no database to serve from", envDatabaseURL)
	}

	if raw := os.Getenv(envGrace); raw != "" {
		grace, err := time.ParseDuration(raw)
		if err != nil {
			return config{}, fmt.Errorf("%s is not a duration: %w", envGrace, err)
		}
		if grace <= 0 {
			return config{}, fmt.Errorf("%s must be positive, got %s", envGrace, grace)
		}
		loaded.shutdownGrace = grace
	}

	if raw := os.Getenv(envLogLevel); raw != "" {
		if err := loaded.logLevel.UnmarshalText([]byte(raw)); err != nil {
			return config{}, fmt.Errorf("%s is not a log level: %w", envLogLevel, err)
		}
	}

	return loaded, nil
}

func newLogger(config config) *slog.Logger {
	options := &slog.HandlerOptions{Level: config.logLevel}
	if config.logJSON {
		return slog.New(slog.NewJSONHandler(os.Stdout, options))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, options))
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envBool(name string, fallback bool) bool {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
