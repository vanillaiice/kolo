package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/api"
	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/app/syncing"
	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/money"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

// These drive real HTTP through the whole stack — router, middleware, service,
// repositories, PostgreSQL — because that is the only way to know the parts fit
// together. A handler tested against a fake service proves the handler compiles
// against an interface, not that logging in works.

const (
	testPIN  = "1357"
	wrongPIN = "9042"
)

var registeredAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

type harness struct {
	server *httptest.Server
	tenant business.ID
	user   *users.User
	number phone.Number
	ctx    context.Context
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	pool := pgtest.Pool(t)
	ctx := context.Background()

	businesses := postgres.NewBusinessRepository(pool)
	userRepo := postgres.NewUserRepository(pool)
	credentials := postgres.NewCredentialRepository(pool)
	deviceRepo := postgres.NewDeviceRepository(pool)
	sessions := postgres.NewSessionRepository(pool)

	tenant, err := business.New(business.NewID(), "Boutique Chez Jean", money.XAF, registeredAt)
	if err != nil {
		t.Fatalf("business.New: %v", err)
	}
	if err := businesses.Create(ctx, tenant); err != nil {
		t.Fatalf("creating the business: %v", err)
	}
	scope := tenant.Scope()

	user, err := users.New(users.NewID(), tenant.ID(), "Jean Mbarga", authz.RoleCashier, registeredAt)
	if err != nil {
		t.Fatalf("users.New: %v", err)
	}
	if err := userRepo.Create(ctx, scope, user); err != nil {
		t.Fatalf("creating the user: %v", err)
	}

	number := phone.MustParse("677123456")
	credential, err := auth.NewCredential(user.ID(), tenant.ID(), number, testPIN, registeredAt)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	if err := credentials.Create(ctx, scope, credential); err != nil {
		t.Fatalf("creating the credential: %v", err)
	}

	service := authn.NewService(credentials, userRepo, deviceRepo, sessions, authn.Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	router := api.NewRouter(api.Config{
		Auth: service,
		Sync: syncing.NewService(postgres.NewSyncRepository(pool), syncing.Options{
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		}),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	return &harness{server: server, tenant: tenant.ID(), user: user, number: number, ctx: ctx}
}

func (h *harness) post(t *testing.T, path string, body any, token string) *http.Response {
	t.Helper()

	var payload io.Reader
	switch value := body.(type) {
	case nil:
		payload = http.NoBody
	case string:
		payload = bytes.NewBufferString(value)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encoding the request: %v", err)
		}
		payload = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(h.ctx, http.MethodPost, h.server.URL+path, payload)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}

	response, err := h.server.Client().Do(request)
	if err != nil {
		t.Fatalf("sending the request: %v", err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func (h *harness) get(t *testing.T, path, token string) *http.Response {
	t.Helper()

	request, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.server.URL+path, nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}

	response, err := h.server.Client().Do(request)
	if err != nil {
		t.Fatalf("sending the request: %v", err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

// loginBody returns a well-formed login payload registering a new device.
func (h *harness) loginBody() map[string]any {
	return map[string]any{
		"business_id": h.tenant.String(),
		"phone":       "677123456",
		"pin":         testPIN,
		"device": map[string]any{
			"label":    "Till 1",
			"platform": "ANDROID",
		},
	}
}

func (h *harness) login(t *testing.T) string {
	t.Helper()

	response := h.post(t, "/api/v1/auth/login", h.loginBody(), "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("login returned %d: %s", response.StatusCode, readBody(t, response))
	}

	var body struct {
		Token string `json:"token"`
	}
	decode(t, response, &body)
	if body.Token == "" {
		t.Fatal("login returned no token")
	}
	return body.Token
}

func decode(t *testing.T, response *http.Response, into any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(into); err != nil {
		t.Fatalf("decoding the response: %v", err)
	}
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("reading the response: %v", err)
	}
	return string(body)
}

func errorCode(t *testing.T, response *http.Response) string {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	decode(t, response, &body)
	if body.Error.Message == "" {
		t.Error("the error carries no message")
	}
	return body.Error.Code
}

func TestLoginReturnsASessionAndToken(t *testing.T) {
	h := newHarness(t)

	response := h.post(t, "/api/v1/auth/login", h.loginBody(), "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("got %d: %s", response.StatusCode, readBody(t, response))
	}
	if got := response.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}

	var body struct {
		Token   string    `json:"token"`
		Expires time.Time `json:"expires_at"`
		User    struct {
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Role        string   `json:"role"`
			BusinessID  string   `json:"business_id"`
			Permissions []string `json:"permissions"`
		} `json:"user"`
		Device struct {
			ID       string `json:"id"`
			Label    string `json:"label"`
			Platform string `json:"platform"`
		} `json:"device"`
	}
	decode(t, response, &body)

	if body.Token == "" {
		t.Error("no token was returned")
	}
	if !body.Expires.After(time.Now()) {
		t.Errorf("the session expires at %s, which is not in the future", body.Expires)
	}
	if body.User.ID != h.user.ID().String() {
		t.Errorf("user id = %q, want %q", body.User.ID, h.user.ID())
	}
	if body.User.Role != "CASHIER" {
		t.Errorf("role = %q, want CASHIER", body.User.Role)
	}
	if body.User.BusinessID != h.tenant.String() {
		t.Errorf("business id = %q, want %q", body.User.BusinessID, h.tenant)
	}
	if len(body.User.Permissions) == 0 {
		t.Error("no permissions were returned, so the client cannot tailor its UI")
	}
	if body.Device.ID == "" || body.Device.Label != "Till 1" || body.Device.Platform != "ANDROID" {
		t.Errorf("the device was not registered as asked: %+v", body.Device)
	}
}

// TestTheTokenWorksOnASubsequentRequest is the point of the whole exercise.
func TestTheTokenWorksOnASubsequentRequest(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)

	response := h.get(t, "/api/v1/auth/me", token)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("got %d: %s", response.StatusCode, readBody(t, response))
	}

	var body struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	decode(t, response, &body)
	if body.User.ID != h.user.ID().String() {
		t.Errorf("user id = %q, want %q", body.User.ID, h.user.ID())
	}
}

// TestAnUnknownNumberAndAWrongPINAnswerIdentically carries the service's
// property out to the wire, where it is the one a client can actually observe.
func TestAnUnknownNumberAndAWrongPINAnswerIdentically(t *testing.T) {
	h := newHarness(t)

	unknown := h.loginBody()
	unknown["phone"] = "699000111"

	wrong := h.loginBody()
	wrong["pin"] = wrongPIN

	unknownResponse := h.post(t, "/api/v1/auth/login", unknown, "")
	wrongResponse := h.post(t, "/api/v1/auth/login", wrong, "")

	if unknownResponse.StatusCode != http.StatusUnauthorized {
		t.Errorf("an unknown number returned %d, want 401", unknownResponse.StatusCode)
	}
	if wrongResponse.StatusCode != http.StatusUnauthorized {
		t.Errorf("a wrong PIN returned %d, want 401", wrongResponse.StatusCode)
	}
	if unknownResponse.StatusCode != wrongResponse.StatusCode {
		t.Errorf("the two failures differ in status: %d against %d",
			unknownResponse.StatusCode, wrongResponse.StatusCode)
	}

	unknownBody := readBody(t, unknownResponse)
	wrongBody := readBody(t, wrongResponse)
	if unknownBody != wrongBody {
		t.Errorf("the two failures are distinguishable:\n  unknown number: %s\n  wrong PIN:      %s",
			unknownBody, wrongBody)
	}
}

func TestLoginRejectsMalformedRequests(t *testing.T) {
	h := newHarness(t)

	tests := []struct {
		name string
		body any
	}{
		{"not JSON", "not json at all"},
		{"empty body", ""},
		{"an array", "[]"},
		{"two objects", `{"business_id":"x"}{"business_id":"y"}`},
		{"an unknown field", map[string]any{
			"business_id": h.tenant.String(), "phone": "677123456",
			"pin_code": testPIN, // the field is "pin"
			"device":   map[string]any{"label": "Till", "platform": "ANDROID"},
		}},
		{"a malformed business id", map[string]any{
			"business_id": "not-a-uuid", "phone": "677123456", "pin": testPIN,
			"device": map[string]any{"label": "Till", "platform": "ANDROID"},
		}},
		{"a malformed phone", map[string]any{
			"business_id": h.tenant.String(), "phone": "nonsense", "pin": testPIN,
			"device": map[string]any{"label": "Till", "platform": "ANDROID"},
		}},
		{"an unknown platform", map[string]any{
			"business_id": h.tenant.String(), "phone": "677123456", "pin": testPIN,
			"device": map[string]any{"label": "Till", "platform": "SYMBIAN"},
		}},
		{"a malformed device id", map[string]any{
			"business_id": h.tenant.String(), "phone": "677123456", "pin": testPIN,
			"device": map[string]any{"id": "not-a-uuid"},
		}},
		{"no device at all", map[string]any{
			"business_id": h.tenant.String(), "phone": "677123456", "pin": testPIN,
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			response := h.post(t, "/api/v1/auth/login", tc.body, "")
			if response.StatusCode != http.StatusBadRequest {
				t.Errorf("got %d, want 400: %s", response.StatusCode, readBody(t, response))
				return
			}
			if got := errorCode(t, response); got != "invalid_request" {
				t.Errorf("code = %q, want invalid_request", got)
			}
		})
	}
}

// TestAnUnknownFieldIsRefused matters more than it looks: a client sending
// "pin_code" would otherwise authenticate with an empty PIN and be told its
// credentials were wrong, which is a miserable thing to debug.
func TestAnUnknownFieldIsRefused(t *testing.T) {
	h := newHarness(t)

	body := h.loginBody()
	body["remember_me"] = true

	response := h.post(t, "/api/v1/auth/login", body, "")
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("got %d, want 400", response.StatusCode)
	}
}

func TestAnOversizedBodyIsRefused(t *testing.T) {
	h := newHarness(t)

	body := h.loginBody()
	body["pin"] = string(bytes.Repeat([]byte("1"), 128<<10))

	response := h.post(t, "/api/v1/auth/login", body, "")
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("got %d, want 400", response.StatusCode)
	}
}

func TestLoginOnASuspendedAccountIsForbidden(t *testing.T) {
	h := newHarness(t)
	pool := pgtest.Pool(t)

	if _, err := pool.Exec(h.ctx, `UPDATE users SET active = false WHERE id = $1`,
		h.user.ID().ID()); err != nil {
		t.Fatalf("suspending the user: %v", err)
	}

	response := h.post(t, "/api/v1/auth/login", h.loginBody(), "")
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("got %d, want 403: %s", response.StatusCode, readBody(t, response))
	}
	if got := errorCode(t, response); got != "account_suspended" {
		t.Errorf("code = %q, want account_suspended", got)
	}
}

func TestRepeatedFailuresAreThrottled(t *testing.T) {
	h := newHarness(t)

	body := h.loginBody()
	body["pin"] = wrongPIN

	var throttled *http.Response
	for range authn.DefaultAttemptAllowance + 2 {
		response := h.post(t, "/api/v1/auth/login", body, "")
		if response.StatusCode == http.StatusTooManyRequests {
			throttled = response
			break
		}
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("got %d, want 401 or 429: %s", response.StatusCode, readBody(t, response))
		}
	}
	if throttled == nil {
		t.Fatal("repeated wrong PINs were never throttled")
	}

	// The client is told how long to wait, rather than being invited to keep
	// trying.
	retryAfter := throttled.Header.Get("Retry-After")
	if retryAfter == "" {
		t.Fatal("no Retry-After header was sent")
	}
	seconds, err := strconv.Atoi(retryAfter)
	if err != nil || seconds < 1 {
		t.Errorf("Retry-After = %q, want a positive number of seconds", retryAfter)
	}
	if got := errorCode(t, throttled); got != "too_many_attempts" {
		t.Errorf("code = %q, want too_many_attempts", got)
	}
}

func TestUnauthenticatedRequestsAreRefused(t *testing.T) {
	h := newHarness(t)
	valid := h.login(t)

	tests := []struct {
		name  string
		token string
		raw   string
	}{
		{name: "no header"},
		{name: "an empty bearer", raw: "Bearer "},
		{name: "the wrong scheme", raw: "Basic " + valid},
		{name: "no scheme", raw: valid},
		{name: "a malformed token", token: "not-a-token"},
		{name: "an unissued token", token: auth.NewToken().Secret()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.server.URL+"/api/v1/auth/me", nil)
			if err != nil {
				t.Fatalf("building the request: %v", err)
			}
			switch {
			case tc.raw != "":
				request.Header.Set("Authorization", tc.raw)
			case tc.token != "":
				request.Header.Set("Authorization", "Bearer "+tc.token)
			}

			response, err := h.server.Client().Do(request)
			if err != nil {
				t.Fatalf("sending the request: %v", err)
			}
			defer response.Body.Close()

			if response.StatusCode != http.StatusUnauthorized {
				t.Errorf("got %d, want 401", response.StatusCode)
				return
			}
			if got := errorCode(t, response); got != "unauthenticated" {
				t.Errorf("code = %q, want unauthenticated", got)
			}
		})
	}
}

// TestTheBearerSchemeIsCaseInsensitive follows RFC 7235; a client sending
// "bearer" is not wrong.
func TestTheBearerSchemeIsCaseInsensitive(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)

	request, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.server.URL+"/api/v1/auth/me", nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	request.Header.Set("Authorization", "bearer "+token)

	response, err := h.server.Client().Do(request)
	if err != nil {
		t.Fatalf("sending the request: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Errorf("got %d, want 200", response.StatusCode)
	}
}

func TestLogout(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)

	response := h.post(t, "/api/v1/auth/logout", nil, token)
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("got %d, want 204: %s", response.StatusCode, readBody(t, response))
	}

	// The token is dead.
	after := h.get(t, "/api/v1/auth/me", token)
	if after.StatusCode != http.StatusUnauthorized {
		t.Errorf("the token still works after logging out: %d", after.StatusCode)
	}

	// And logging out again is not an error, so a client retrying a request it
	// could not confirm is not told it failed.
	again := h.post(t, "/api/v1/auth/logout", nil, token)
	if again.StatusCode != http.StatusUnauthorized && again.StatusCode != http.StatusNoContent {
		t.Errorf("logging out twice returned %d", again.StatusCode)
	}
}

// TestLoggingInTwiceGivesTwoLiveSessions is how a person works from a till and
// their own phone at once.
func TestLoggingInTwiceGivesTwoLiveSessions(t *testing.T) {
	h := newHarness(t)

	first := h.login(t)
	second := h.login(t)
	if first == second {
		t.Fatal("two logins returned the same token")
	}

	for name, token := range map[string]string{"first": first, "second": second} {
		if response := h.get(t, "/api/v1/auth/me", token); response.StatusCode != http.StatusOK {
			t.Errorf("the %s session does not work: %d", name, response.StatusCode)
		}
	}

	// Ending one leaves the other alone.
	h.post(t, "/api/v1/auth/logout", nil, first)
	if response := h.get(t, "/api/v1/auth/me", second); response.StatusCode != http.StatusOK {
		t.Errorf("logging out of one session ended the other: %d", response.StatusCode)
	}
}

func TestHealthEndpoints(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{"/healthz", "/readyz"} {
		response := h.get(t, path, "")
		if response.StatusCode != http.StatusOK {
			t.Errorf("%s returned %d", path, response.StatusCode)
		}
	}
}

// TestAnUnknownPathAnswersInTheAPIsErrorShape means a client has one way to
// read a failure, rather than JSON from handlers and plain text from the muxer.
func TestAnUnknownPathAnswersInTheAPIsErrorShape(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{"/", "/nonsense", "/api/v1/nothing-here", "/api/v2/auth/login"} {
		t.Run(path, func(t *testing.T) {
			response := h.get(t, path, "")
			if response.StatusCode != http.StatusNotFound {
				t.Errorf("got %d, want 404", response.StatusCode)
				return
			}
			if got := response.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
				t.Errorf("Content-Type = %q, want JSON", got)
			}
			if got := errorCode(t, response); got != "not_found" {
				t.Errorf("code = %q, want not_found", got)
			}
		})
	}
}

func TestTheWrongMethodIsRefused(t *testing.T) {
	h := newHarness(t)

	// Login is a POST; a GET must not reach the handler.
	response := h.get(t, "/api/v1/auth/login", "")
	if response.StatusCode == http.StatusOK {
		t.Error("a GET to the login endpoint succeeded")
	}
}

// TestAnInternalErrorRevealsNothing keeps a table name, a query, or a
// constraint from reaching a stranger.
func TestAnInternalErrorRevealsNothing(t *testing.T) {
	h := newHarness(t)

	// A user whose row has been removed leaves a credential pointing at
	// nothing, which the service reports as a fault rather than bad
	// credentials.
	pool := pgtest.Pool(t)
	if _, err := pool.Exec(h.ctx,
		`UPDATE users SET name = $2 WHERE id = $1`, h.user.ID().ID(), "Jean​Mbarga"); err != nil {
		t.Fatalf("corrupting the user row: %v", err)
	}

	response := h.post(t, "/api/v1/auth/login", h.loginBody(), "")
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500: %s", response.StatusCode, readBody(t, response))
	}

	body := readBody(t, response)
	for _, leak := range []string{"users", "SELECT", "pgx", "postgres", "constraint", "column"} {
		if bytes.Contains(bytes.ToLower([]byte(body)), bytes.ToLower([]byte(leak))) {
			t.Errorf("the response mentions %q, which is not a stranger's business: %s", leak, body)
		}
	}
}
