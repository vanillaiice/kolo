package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
)

// Version is the API version this router serves. §35 requires it to be
// explicit, so it appears in the path rather than in a header a client might
// omit.
const Version = "v1"

// basePath is the prefix every endpoint sits under.
const basePath = "/api/" + Version

// Config assembles a router.
type Config struct {
	// Auth is the authentication service. Required.
	Auth *authn.Service
	// Sync is the synchronization service. Optional: without one the sync
	// endpoints are not mounted, which is what the auth-only tests want.
	Sync *syncing.Service
	// Health reports whether the backend's dependencies are reachable.
	// Optional: without one, the readiness endpoint reports healthy.
	Health HealthChecker
	// Logger receives request diagnostics. Defaults to the standard logger.
	Logger *slog.Logger
}

// HealthChecker reports whether the backend can serve.
type HealthChecker interface {
	// Check returns nil when the backend's dependencies are reachable.
	Check(r *http.Request) error
}

// NewRouter builds the HTTP handler for the API.
//
// Routing is stdlib. Go's ServeMux matches on method and path pattern, which is
// all this needs, and a router dependency would be one more thing to keep
// current for no gain.
func NewRouter(config Config) http.Handler {
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}

	handlers := &authHandlers{service: config.Auth, logger: logger}
	authenticated := RequireAuthentication(config.Auth, logger)

	mux := http.NewServeMux()

	// Liveness and readiness sit outside the version prefix: they describe the
	// process, not the API, and an orchestrator polling them should not have to
	// track which version is deployed.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, r, logger, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if config.Health != nil {
			if err := config.Health.Check(r); err != nil {
				logger.ErrorContext(r.Context(), "readiness check failed", "error", err)
				writeJSON(w, r, logger, http.StatusServiceUnavailable,
					map[string]string{"status": "unavailable"})
				return
			}
		}
		writeJSON(w, r, logger, http.StatusOK, map[string]string{"status": "ready"})
	})

	// Logging in cannot require being logged in. It is throttled in the service
	// rather than here, so the limit applies however the call arrives.
	mux.HandleFunc("POST "+basePath+"/auth/login", handlers.login)

	// Logging out reads the token itself rather than sitting behind the
	// middleware: a client whose session has already lapsed should still get a
	// clean answer when it tries to end it.
	mux.HandleFunc("POST "+basePath+"/auth/logout", handlers.logout)

	mux.Handle("GET "+basePath+"/auth/me",
		chain(http.HandlerFunc(handlers.currentUser), authenticated))

	// Synchronization has dedicated endpoints rather than pretending to be CRUD
	// (§36). Both require a live session, so the tenant and the device come
	// from the token rather than from anything a client sends.
	if config.Sync != nil {
		sync := &syncHandlers{service: config.Sync, logger: logger}
		mux.Handle("POST "+basePath+"/sync/push",
			chain(http.HandlerFunc(sync.push), authenticated))
		mux.Handle("GET "+basePath+"/sync/pull",
			chain(http.HandlerFunc(sync.pull), authenticated))
	}

	// A request to an unknown path gets the same JSON shape as everything else,
	// rather than ServeMux's plain-text default, so a client has one way to
	// read a failure. The pattern is the least specific one registered, so
	// every route above still wins.
	mux.Handle("/", notFound(logger))

	return mux
}

// notFound answers an unrouted request in the API's own error shape.
func notFound(logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, r, logger, http.StatusNotFound, errorBody{Error: errorDetail{
			Code:    CodeNotFound,
			Message: "Not found.",
		}})
	})
}

// Server timeouts.
//
// A connection that never finishes sending, or never reads its response, holds
// a slot. On a backend reached over slow and intermittent links (§45) the read
// and write allowances are generous, but they are not absent.
const (
	DefaultReadHeaderTimeout = 10 * time.Second
	DefaultReadTimeout       = 30 * time.Second
	DefaultWriteTimeout      = 60 * time.Second
	DefaultIdleTimeout       = 2 * time.Minute
)

// NewServer returns an HTTP server with timeouts set.
//
// Go's zero-value Server has no timeouts at all, which is the wrong default for
// anything facing a network.
func NewServer(address string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: DefaultReadHeaderTimeout,
		ReadTimeout:       DefaultReadTimeout,
		WriteTimeout:      DefaultWriteTimeout,
		IdleTimeout:       DefaultIdleTimeout,
	}
}
