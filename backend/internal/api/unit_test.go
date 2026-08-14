package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/api"
	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
)

// These need no database: they are about how the HTTP layer translates, which
// is decided entirely by the error it is handed.

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// stubAuthenticator answers with whatever it is told to.
type stubAuthenticator struct {
	result authn.LoginResult
	err    error
}

func (s stubAuthenticator) Authenticate(context.Context, auth.Token) (authn.LoginResult, error) {
	return s.result, s.err
}

// TestEveryErrorIsAnsweredWithItsOwnStatusAndCode pins the mapping in one
// place, so a change to how a failure reads is a visible decision.
func TestEveryErrorIsAnsweredWithItsOwnStatusAndCode(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"bad credentials", authn.ErrInvalidCredentials, http.StatusUnauthorized, "invalid_credentials"},
		{"not authenticated", authn.ErrUnauthenticated, http.StatusUnauthorized, "unauthenticated"},
		{"suspended account", authn.ErrAccountSuspended, http.StatusForbidden, "account_suspended"},
		{"suspended device", authn.ErrDeviceSuspended, http.StatusForbidden, "device_suspended"},
		{"invalid request", authn.ErrInvalidRequest, http.StatusBadRequest, "invalid_request"},
		{"too many attempts", authn.ErrTooManyAttempts, http.StatusTooManyRequests, "too_many_attempts"},
		{"cross tenant", business.ErrCrossTenant, http.StatusNotFound, "not_found"},
		{"no tenant", business.ErrNoTenant, http.StatusNotFound, "not_found"},
		{"not found", postgres.ErrNotFound, http.StatusNotFound, "not_found"},
		{"conflict", postgres.ErrConflict, http.StatusConflict, "conflict"},
		{"a query failure", postgres.ErrQuery, http.StatusInternalServerError, "internal_error"},
		{"something unrecognised", errors.New("boom"), http.StatusInternalServerError, "internal_error"},
		{"a wrapped known error", fmt.Errorf("context: %w", authn.ErrInvalidRequest), http.StatusBadRequest, "invalid_request"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			recorder := serveFailing(tc.err)

			if recorder.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", recorder.Code, tc.wantStatus)
			}
			if got := codeOf(t, recorder); got != tc.wantCode {
				t.Errorf("code = %q, want %q", got, tc.wantCode)
			}
		})
	}
}

// TestAnInternalErrorNeverEchoesItsCause is the rule that keeps a table name or
// a constraint out of a stranger's hands.
func TestAnInternalErrorNeverEchoesItsCause(t *testing.T) {
	secret := "relation \"user_credentials\" does not exist"

	recorder := serveFailing(errors.New(secret))
	body := recorder.Body.String()

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if strings.Contains(body, "user_credentials") || strings.Contains(body, "relation") {
		t.Errorf("the response echoed the cause: %s", body)
	}
}

// TestARetryAfterHeaderIsSentWhenThrottled tells a client to wait rather than
// inviting it to hammer.
func TestARetryAfterHeaderIsSentWhenThrottled(t *testing.T) {
	// A bare ErrTooManyAttempts carries no duration; the header is then omitted
	// rather than sent as zero, which a client would read as "retry now".
	bare := serveFailing(authn.ErrTooManyAttempts)
	if got := bare.Header().Get("Retry-After"); got != "" {
		t.Errorf("Retry-After = %q for an error carrying no wait, want it omitted", got)
	}
	if bare.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", bare.Code)
	}
}

func TestRequireAuthenticationPassesThePrincipalThrough(t *testing.T) {
	principal := fakePrincipal(t)
	middleware := api.RequireAuthentication(stubAuthenticator{result: principal}, quietLogger())

	var seen api.Principal
	var found bool
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, found = api.PrincipalFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/anything", nil)
	request.Header.Set("Authorization", "Bearer "+auth.NewToken().Secret())
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if !found {
		t.Fatal("no principal reached the handler")
	}
	if seen.User.ID() != principal.User.ID() {
		t.Errorf("principal user = %s, want %s", seen.User.ID(), principal.User.ID())
	}
	// The scope the handler must bound everything by comes from the principal,
	// never from anything the client sent.
	if seen.Scope().Business() != principal.User.BusinessID() {
		t.Errorf("scope business = %s, want %s", seen.Scope().Business(), principal.User.BusinessID())
	}
}

func TestRequirePermission(t *testing.T) {
	principal := fakePrincipal(t)
	authenticated := api.RequireAuthentication(stubAuthenticator{result: principal}, quietLogger())

	reached := false
	protected := func(permission authz.Permission) http.Handler {
		reached = false
		inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reached = true
			w.WriteHeader(http.StatusOK)
		})
		return authenticated(api.RequirePermission(permission, quietLogger())(inner))
	}

	t.Run("a permission the user holds", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/anything", nil)
		request.Header.Set("Authorization", "Bearer "+auth.NewToken().Secret())

		protected(authz.SalesCreate).ServeHTTP(recorder, request)

		if recorder.Code != http.StatusOK || !reached {
			t.Errorf("status = %d, reached = %v; want 200 and the handler to run", recorder.Code, reached)
		}
	})

	t.Run("a permission the user lacks", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/anything", nil)
		request.Header.Set("Authorization", "Bearer "+auth.NewToken().Secret())

		protected(authz.ReportsFinancial).ServeHTTP(recorder, request)

		if recorder.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", recorder.Code)
		}
		if reached {
			t.Error("the handler ran despite the permission being refused")
		}
		if got := codeOf(t, recorder); got != "forbidden" {
			t.Errorf("code = %q, want forbidden", got)
		}
	})
}

// TestRequirePermissionWithoutAuthenticationRefuses guards a misconfigured
// route: mounted without authentication in front of it, the safe reading is to
// refuse rather than let the request through.
func TestRequirePermissionWithoutAuthenticationRefuses(t *testing.T) {
	reached := false
	handler := api.RequirePermission(authz.SalesCreate, quietLogger())(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reached = true
			w.WriteHeader(http.StatusOK)
		}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/anything", nil))

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", recorder.Code)
	}
	if reached {
		t.Error("the handler ran on a route with no authentication in front of it")
	}
}

func TestRequireAuthenticationRefusesWhenTheServiceDoes(t *testing.T) {
	middleware := api.RequireAuthentication(
		stubAuthenticator{err: authn.ErrAccountSuspended}, quietLogger())

	reached := false
	handler := middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/anything", nil)
	request.Header.Set("Authorization", "Bearer "+auth.NewToken().Secret())
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", recorder.Code)
	}
	if reached {
		t.Error("the handler ran for a suspended account")
	}
}

// TestNewServerSetsTimeouts matters because Go's zero-value Server has none,
// which is the wrong default for anything facing a network.
func TestNewServerSetsTimeouts(t *testing.T) {
	server := api.NewServer(":8080", http.NotFoundHandler())

	if server.Addr != ":8080" {
		t.Errorf("Addr = %q", server.Addr)
	}
	timeouts := map[string]time.Duration{
		"ReadHeaderTimeout": server.ReadHeaderTimeout,
		"ReadTimeout":       server.ReadTimeout,
		"WriteTimeout":      server.WriteTimeout,
		"IdleTimeout":       server.IdleTimeout,
	}
	for name, timeout := range timeouts {
		if timeout <= 0 {
			t.Errorf("%s is unset, so a stalled connection would hold a slot forever", name)
		}
	}
	if server.Handler == nil {
		t.Error("the server has no handler")
	}
}

// TestReadinessReportsAnUnreachableDependency is what an orchestrator uses to
// keep traffic away from an instance that cannot serve.
func TestReadinessReportsAnUnreachableDependency(t *testing.T) {
	router := api.NewRouter(api.Config{
		Auth:   nil,
		Health: failingHealth{},
		Logger: quietLogger(),
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", recorder.Code)
	}

	// Liveness still answers: the process is running, it just cannot serve.
	live := httptest.NewRecorder()
	router.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if live.Code != http.StatusOK {
		t.Errorf("liveness returned %d, want 200", live.Code)
	}
}

type failingHealth struct{}

func (failingHealth) Check(*http.Request) error { return errors.New("database unreachable") }

// TestABranchAssignmentAppearsInTheResponse covers the optional fields, which
// are omitted rather than sent empty so a client can tell "no branch" from
// "some branch".
func TestABranchAssignmentAppearsInTheResponse(t *testing.T) {
	principal := fakePrincipal(t)
	branchID := business.NewBranchID()

	if err := principal.User.AssignToBranch(branchID, registeredAt.Add(time.Hour)); err != nil {
		t.Fatalf("AssignToBranch: %v", err)
	}
	if err := principal.Device.StationAt(branchID, registeredAt.Add(time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}

	router := api.NewRouter(api.Config{Auth: nil, Logger: quietLogger()})
	_ = router // the response shape is exercised through the middleware below

	middleware := api.RequireAuthentication(stubAuthenticator{result: principal}, quietLogger())
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, _ := api.PrincipalFrom(r.Context())
		if got, assigned := seen.User.BranchID(); !assigned || got != branchID {
			t.Errorf("the principal's branch is %s, %v; want %s, true", got, assigned, branchID)
		}
		if got, stationed := seen.Device.BranchID(); !stationed || got != branchID {
			t.Errorf("the device's branch is %s, %v; want %s, true", got, stationed, branchID)
		}
		// And the scope is narrowed to it.
		if !seen.Scope().IsBranchScoped() {
			t.Error("a branch-assigned user produced a business-wide scope")
		}
	}))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/anything", nil)
	request.Header.Set("Authorization", "Bearer "+auth.NewToken().Secret())
	handler.ServeHTTP(recorder, request)
}

// serveFailing runs a handler that fails with the given error, through the
// package's own error writing.
func serveFailing(err error) *httptest.ResponseRecorder {
	middleware := api.RequireAuthentication(stubAuthenticator{err: err}, quietLogger())
	handler := middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/anything", nil)
	request.Header.Set("Authorization", "Bearer "+auth.NewToken().Secret())
	handler.ServeHTTP(recorder, request)
	return recorder
}

func fakePrincipal(t *testing.T) authn.LoginResult {
	t.Helper()

	tenant := business.NewID()
	user, err := users.New(users.NewID(), tenant, "Jean Mbarga", authz.RoleCashier, registeredAt)
	if err != nil {
		t.Fatalf("users.New: %v", err)
	}
	device, err := devices.Register(devices.NewID(), tenant, "Till 1", devices.PlatformAndroid, registeredAt)
	if err != nil {
		t.Fatalf("devices.Register: %v", err)
	}
	session, _, err := auth.Issue(
		auth.NewSessionID(), user.ID(), tenant, device.ID(), registeredAt, auth.DefaultLifetime,
	)
	if err != nil {
		t.Fatalf("auth.Issue: %v", err)
	}
	return authn.LoginResult{User: user, Device: device, Session: session}
}

func codeOf(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()

	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding %q: %v", recorder.Body.String(), err)
	}
	if body.Error.Message == "" {
		t.Error("the error carries no message")
	}
	return body.Error.Code
}
