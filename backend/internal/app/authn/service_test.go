package authn_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/clock"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id/idtest"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

const (
	correctPIN = "1357"
	wrongPIN   = "9042"
)

var loginAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

type fixture struct {
	service     *authn.Service
	credentials *fakeCredentialStore
	users       *fakeUserStore
	devices     *fakeDeviceStore
	sessions    *fakeSessionStore
	clock       *clock.Fixed

	tenant business.ID
	user   *users.User
	device *devices.Device
	number phone.Number
	ctx    context.Context
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	f := &fixture{
		credentials: newFakeCredentialStore(),
		users:       newFakeUserStore(),
		devices:     newFakeDeviceStore(),
		sessions:    newFakeSessionStore(),
		clock:       clock.NewFixed(loginAt),
		tenant:      business.NewID(),
		number:      phone.MustParse("677123456"),
		ctx:         context.Background(),
	}
	f.service = authn.NewService(f.credentials, f.users, f.devices, f.sessions, authn.Options{
		Clock: f.clock,
		IDs:   idtest.NewSequence(),
		// Discarded so a warning about a rehash does not clutter the run; the
		// tests assert on behaviour rather than on log output.
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	user, err := users.New(users.NewID(), f.tenant, "Jean Mbarga", authz.RoleCashier, loginAt)
	if err != nil {
		t.Fatalf("users.New: %v", err)
	}
	f.user = user
	f.users.put(user)

	credential, err := auth.NewCredential(user.ID(), f.tenant, f.number, correctPIN, loginAt)
	if err != nil {
		t.Fatalf("auth.NewCredential: %v", err)
	}
	f.credentials.put(credential)

	device, err := devices.Register(devices.NewID(), f.tenant, "Till 1", devices.PlatformAndroid, loginAt)
	if err != nil {
		t.Fatalf("devices.Register: %v", err)
	}
	f.device = device
	f.devices.put(device)

	return f
}

// newFixtureWithLimiter builds a fixture whose service throttles with the given
// limiter, for tests about repeated attempts.
func newFixtureWithLimiter(t *testing.T, limiter authn.AttemptLimiter) *fixture {
	t.Helper()

	f := newFixture(t)
	f.service = authn.NewService(f.credentials, f.users, f.devices, f.sessions, authn.Options{
		Clock:   f.clock,
		IDs:     idtest.NewSequence(),
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Limiter: limiter,
	})
	return f
}

func (f *fixture) request() authn.LoginRequest {
	return authn.LoginRequest{
		BusinessID: f.tenant,
		Phone:      f.number,
		PIN:        correctPIN,
		Device:     authn.DeviceRequest{ID: f.device.ID()},
	}
}

func TestLogin(t *testing.T) {
	f := newFixture(t)

	result, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	if result.Token.IsZero() {
		t.Error("no token was issued")
	}
	if result.Session == nil {
		t.Fatal("no session was issued")
	}
	if result.User.ID() != f.user.ID() {
		t.Errorf("logged in as %s, want %s", result.User.ID(), f.user.ID())
	}
	if result.Device.ID() != f.device.ID() {
		t.Errorf("device = %s, want %s", result.Device.ID(), f.device.ID())
	}
	if result.Session.BusinessID() != f.tenant {
		t.Errorf("session business = %s, want %s", result.Session.BusinessID(), f.tenant)
	}
	if err := result.Session.Authenticate(result.Token, loginAt); err != nil {
		t.Errorf("the issued token does not authenticate its own session: %v", err)
	}
}

// TestLoginAcceptsAnyValidSpellingOfTheNumber is the practical payoff of
// normalising: someone typing their number the way they always do gets in.
func TestLoginAcceptsAnyValidSpellingOfTheNumber(t *testing.T) {
	f := newFixture(t)

	for _, spelling := range []string{"677123456", "677 123 456", "+237677123456", "00237677123456"} {
		t.Run(spelling, func(t *testing.T) {
			number, err := phone.Parse(spelling)
			if err != nil {
				t.Fatalf("phone.Parse: %v", err)
			}
			request := f.request()
			request.Phone = number

			if _, err := f.service.Login(f.ctx, request); err != nil {
				t.Errorf("Login: %v", err)
			}
		})
	}
}

// TestAnUnknownNumberAndAWrongPINAreIndistinguishable is the property that
// keeps the login endpoint from being used to discover who works for a
// business.
func TestAnUnknownNumberAndAWrongPINAreIndistinguishable(t *testing.T) {
	f := newFixture(t)

	unknownNumber := f.request()
	unknownNumber.Phone = phone.MustParse("699000111")

	badPIN := f.request()
	badPIN.PIN = wrongPIN

	_, unknownErr := f.service.Login(f.ctx, unknownNumber)
	_, wrongErr := f.service.Login(f.ctx, badPIN)

	if !errors.Is(unknownErr, authn.ErrInvalidCredentials) {
		t.Errorf("an unknown number gave %v, want ErrInvalidCredentials", unknownErr)
	}
	if !errors.Is(wrongErr, authn.ErrInvalidCredentials) {
		t.Errorf("a wrong PIN gave %v, want ErrInvalidCredentials", wrongErr)
	}
	if unknownErr.Error() != wrongErr.Error() {
		t.Errorf("the two failures read differently:\n  unknown number: %v\n  wrong PIN:      %v",
			unknownErr, wrongErr)
	}
}

// TestAnUnknownNumberStillCostsAVerification is the timing half of the same
// property: returning early would make the two cases measurably different.
func TestAnUnknownNumberStillCostsAVerification(t *testing.T) {
	f := newFixture(t)

	request := f.request()
	request.Phone = phone.MustParse("699000111")

	started := time.Now()
	if _, err := f.service.Login(f.ctx, request); !errors.Is(err, authn.ErrInvalidCredentials) {
		t.Fatalf("got %v, want ErrInvalidCredentials", err)
	}
	unknownCost := time.Since(started)

	started = time.Now()
	wrong := f.request()
	wrong.PIN = wrongPIN
	if _, err := f.service.Login(f.ctx, wrong); !errors.Is(err, authn.ErrInvalidCredentials) {
		t.Fatalf("got %v, want ErrInvalidCredentials", err)
	}
	knownCost := time.Since(started)

	// Not a tight bound — a shared runner is noisy — but an early return would
	// be orders of magnitude faster, which this catches.
	if unknownCost < knownCost/4 {
		t.Errorf("an unknown number took %s against %s for a wrong PIN, "+
			"which is fast enough to reveal that the number is not registered",
			unknownCost, knownCost)
	}
}

// TestAStoreFailureLooksLikeBadCredentials continues the same reasoning: a
// database problem must not be a way to learn that a number exists.
func TestAStoreFailureLooksLikeBadCredentials(t *testing.T) {
	f := newFixture(t)
	f.credentials.failFind = true

	_, err := f.service.Login(f.ctx, f.request())
	if !errors.Is(err, authn.ErrInvalidCredentials) {
		t.Errorf("got %v, want ErrInvalidCredentials", err)
	}
}

func TestASuspendedUserIsToldSo(t *testing.T) {
	f := newFixture(t)
	if err := f.user.Deactivate(loginAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	// The PIN is right, so the person has already proved who they are. Telling
	// them to keep retrying a correct PIN would be worse than telling them to
	// speak to the owner.
	_, err := f.service.Login(f.ctx, f.request())
	if !errors.Is(err, authn.ErrAccountSuspended) {
		t.Errorf("got %v, want ErrAccountSuspended", err)
	}
	if errors.Is(err, authn.ErrInvalidCredentials) {
		t.Error("a suspended account was reported as bad credentials")
	}
}

// TestASuspendedUserWithAWrongPINRevealsNothing checks the ordering: the PIN is
// verified before the account is consulted, so someone who does not know the
// PIN learns nothing about the account either.
func TestASuspendedUserWithAWrongPINRevealsNothing(t *testing.T) {
	f := newFixture(t)
	if err := f.user.Deactivate(loginAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	request := f.request()
	request.PIN = wrongPIN

	if _, err := f.service.Login(f.ctx, request); !errors.Is(err, authn.ErrInvalidCredentials) {
		t.Errorf("got %v, want ErrInvalidCredentials", err)
	}
}

func TestLoginOnASuspendedDeviceIsRefused(t *testing.T) {
	f := newFixture(t)
	if err := f.device.Deactivate(loginAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	if _, err := f.service.Login(f.ctx, f.request()); !errors.Is(err, authn.ErrDeviceSuspended) {
		t.Errorf("got %v, want ErrDeviceSuspended", err)
	}
}

// TestFirstLoginRegistersTheDevice is what happens when someone logs in on a
// new phone or a new till.
func TestFirstLoginRegistersTheDevice(t *testing.T) {
	f := newFixture(t)

	request := f.request()
	request.Device = authn.DeviceRequest{Label: "Marie's phone", Platform: devices.PlatformAndroid}

	result, err := f.service.Login(f.ctx, request)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	if f.devices.registered != 1 {
		t.Errorf("registered %d devices, want 1", f.devices.registered)
	}
	if got := result.Device.Label(); got != "Marie's phone" {
		t.Errorf("Label() = %q", got)
	}
	if result.Device.ID() == f.device.ID() {
		t.Error("the new login reused the existing device")
	}
	if result.Device.BusinessID() != f.tenant {
		t.Errorf("the new device belongs to %s, want %s", result.Device.BusinessID(), f.tenant)
	}
}

func TestRegisteringADeviceRejectsBadDetails(t *testing.T) {
	f := newFixture(t)

	tests := []struct {
		name   string
		device authn.DeviceRequest
	}{
		{"no platform", authn.DeviceRequest{Label: "Phone"}},
		{"unknown platform", authn.DeviceRequest{Label: "Phone", Platform: "SYMBIAN"}},
		{"blank label", authn.DeviceRequest{Label: "   ", Platform: devices.PlatformAndroid}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request := f.request()
			request.Device = tc.device

			if _, err := f.service.Login(f.ctx, request); !errors.Is(err, authn.ErrInvalidRequest) {
				t.Errorf("got %v, want ErrInvalidRequest", err)
			}
		})
	}
}

func TestLoginOnAnUnknownDeviceIsRefused(t *testing.T) {
	f := newFixture(t)

	request := f.request()
	request.Device = authn.DeviceRequest{ID: devices.NewID()}

	if _, err := f.service.Login(f.ctx, request); !errors.Is(err, authn.ErrInvalidRequest) {
		t.Errorf("got %v, want ErrInvalidRequest", err)
	}
}

// TestLoggingInRecordsDeviceContact matters for an owner looking at which of
// their tills is still being used.
func TestLoggingInRecordsDeviceContact(t *testing.T) {
	f := newFixture(t)
	f.clock.Set(loginAt.Add(6 * time.Hour))

	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Fatalf("Login: %v", err)
	}

	if f.devices.seen == 0 {
		t.Error("the device's contact was not recorded")
	}
	if got := f.device.LastSeenAt(); !got.Equal(loginAt.Add(6 * time.Hour)) {
		t.Errorf("LastSeenAt() = %s, want the login time", got)
	}
}

func TestLoginRejectsAnIncompleteRequest(t *testing.T) {
	f := newFixture(t)

	tests := []struct {
		name   string
		mutate func(*authn.LoginRequest)
	}{
		{"no business", func(r *authn.LoginRequest) { r.BusinessID = business.ID{} }},
		{"no phone", func(r *authn.LoginRequest) { r.Phone = phone.Number{} }},
		{"no PIN", func(r *authn.LoginRequest) { r.PIN = "" }},
		{"no device at all", func(r *authn.LoginRequest) { r.Device = authn.DeviceRequest{} }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request := f.request()
			tc.mutate(&request)

			if _, err := f.service.Login(f.ctx, request); !errors.Is(err, authn.ErrInvalidRequest) {
				t.Errorf("got %v, want ErrInvalidRequest", err)
			}
		})
	}
}

// TestLoginCannotReachAnotherTenantsCredential is the boundary seen from the
// service: naming another business finds nothing, however right the PIN is.
func TestLoginCannotReachAnotherTenantsCredential(t *testing.T) {
	f := newFixture(t)

	request := f.request()
	request.BusinessID = business.NewID()

	if _, err := f.service.Login(f.ctx, request); !errors.Is(err, authn.ErrInvalidCredentials) {
		t.Errorf("got %v, want ErrInvalidCredentials", err)
	}
}

// TestLoginUpgradesAnOldHash covers the rehash-on-login path: a login is the
// only moment the plaintext PIN is available.
func TestLoginUpgradesAnOldHash(t *testing.T) {
	f := newFixture(t)

	stale := restoreCredentialAtLowCost(t, f.user.ID(), f.tenant, f.number, correctPIN)
	if !stale.NeedsRehash() {
		t.Fatal("the fixture credential does not need a rehash, so nothing is being tested")
	}
	f.credentials.put(stale)

	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Fatalf("Login: %v", err)
	}

	if f.credentials.updates != 1 {
		t.Errorf("stored %d credential updates, want 1", f.credentials.updates)
	}
	if stale.NeedsRehash() {
		t.Error("the credential still needs a rehash after logging in")
	}
	if !stale.Verify(correctPIN) {
		t.Error("the PIN stopped working after the upgrade")
	}
}

// TestAFailedRehashDoesNotFailTheLogin pins the priority: refusing someone with
// the right PIN because an optimisation did not work would be the worse
// outcome.
func TestAFailedRehashDoesNotFailTheLogin(t *testing.T) {
	f := newFixture(t)
	f.credentials.put(restoreCredentialAtLowCost(t, f.user.ID(), f.tenant, f.number, correctPIN))
	f.credentials.failUpdate = true

	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Errorf("a failed rehash also failed the login: %v", err)
	}
}

// TestACurrentHashIsNotRewritten keeps every login from doing needless work.
func TestACurrentHashIsNotRewritten(t *testing.T) {
	f := newFixture(t)

	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if f.credentials.updateCalls != 0 {
		t.Errorf("the credential was written %d times for a current hash, want none", f.credentials.updateCalls)
	}
}

func TestLoginReportsAStorageFailure(t *testing.T) {
	f := newFixture(t)
	f.sessions.failCreate = true

	_, err := f.service.Login(f.ctx, f.request())
	if err == nil {
		t.Fatal("Login succeeded although the session could not be stored")
	}
	// This one is not disguised: the credentials were right, and hiding a
	// server fault behind "wrong PIN" would send someone chasing their own
	// memory instead of the outage.
	if errors.Is(err, authn.ErrInvalidCredentials) {
		t.Error("a storage failure was reported as bad credentials")
	}
}

func TestAuthenticate(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	result, err := f.service.Authenticate(f.ctx, login.Token)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if result.User.ID() != f.user.ID() {
		t.Errorf("authenticated as %s, want %s", result.User.ID(), f.user.ID())
	}
	if result.Session.ID() != login.Session.ID() {
		t.Errorf("session = %s, want %s", result.Session.ID(), login.Session.ID())
	}
	// The tenant is discovered from the token, which is what bounds everything
	// downstream.
	if result.User.Scope().Business() != f.tenant {
		t.Errorf("scope business = %s, want %s", result.User.Scope().Business(), f.tenant)
	}
}

func TestAuthenticateRejectsBadTokens(t *testing.T) {
	f := newFixture(t)
	if _, err := f.service.Login(f.ctx, f.request()); err != nil {
		t.Fatalf("Login: %v", err)
	}

	tests := map[string]auth.Token{
		"the zero token":    {},
		"an unissued token": auth.NewToken(),
	}
	for name, token := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := f.service.Authenticate(f.ctx, token); !errors.Is(err, authn.ErrUnauthenticated) {
				t.Errorf("got %v, want ErrUnauthenticated", err)
			}
		})
	}
}

func TestAuthenticateRejectsAnExpiredSession(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	f.clock.Set(login.Session.ExpiresAt().Add(time.Hour))

	if _, err := f.service.Authenticate(f.ctx, login.Token); !errors.Is(err, authn.ErrUnauthenticated) {
		t.Errorf("got %v, want ErrUnauthenticated", err)
	}
}

// TestSuspendingAUserStopsTheirLiveSession is the server-side half of
// revocation: a session issued before the suspension must stop working on the
// next request that reaches the server.
func TestSuspendingAUserStopsTheirLiveSession(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if _, err := f.service.Authenticate(f.ctx, login.Token); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}

	if err := f.user.Deactivate(loginAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	if _, err := f.service.Authenticate(f.ctx, login.Token); !errors.Is(err, authn.ErrAccountSuspended) {
		t.Errorf("got %v, want ErrAccountSuspended", err)
	}
}

func TestSuspendingADeviceStopsItsSessions(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if err := f.device.Deactivate(loginAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	if _, err := f.service.Authenticate(f.ctx, login.Token); !errors.Is(err, authn.ErrDeviceSuspended) {
		t.Errorf("got %v, want ErrDeviceSuspended", err)
	}
}

func TestLogout(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	if err := f.service.Logout(f.ctx, login.Token); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if _, err := f.service.Authenticate(f.ctx, login.Token); !errors.Is(err, authn.ErrUnauthenticated) {
		t.Errorf("the token still authenticates after logging out: %v", err)
	}
}

// TestLogoutIsIdempotent matters for a client retrying a request it could not
// confirm: it must not be told the logout failed.
func TestLogoutIsIdempotent(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if err := f.service.Logout(f.ctx, login.Token); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if err := f.service.Logout(f.ctx, login.Token); err != nil {
		t.Errorf("logging out twice: %v", err)
	}
}

func TestLogoutRejectsBadTokens(t *testing.T) {
	f := newFixture(t)

	if err := f.service.Logout(f.ctx, auth.Token{}); !errors.Is(err, authn.ErrUnauthenticated) {
		t.Errorf("the zero token: got %v, want ErrUnauthenticated", err)
	}
	if err := f.service.Logout(f.ctx, auth.NewToken()); !errors.Is(err, authn.ErrUnauthenticated) {
		t.Errorf("an unissued token: got %v, want ErrUnauthenticated", err)
	}
}

func TestLogoutReportsAStorageFailure(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	f.sessions.failUpdate = true

	if err := f.service.Logout(f.ctx, login.Token); err == nil {
		t.Error("Logout succeeded although the revocation could not be stored")
	}
}

func TestServiceDefaultsAreUsable(t *testing.T) {
	f := newFixture(t)

	// A service built with no options must still work, drawing on the system
	// clock and the real identifier generator.
	service := authn.NewService(f.credentials, f.users, f.devices, f.sessions, authn.Options{})

	request := f.request()
	result, err := service.Login(f.ctx, request)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if result.Token.IsZero() {
		t.Error("no token was issued")
	}
	if want := auth.DefaultLifetime; result.Session.ExpiresAt().Sub(result.Session.IssuedAt()) != want {
		t.Errorf("session lifetime = %s, want the default %s",
			result.Session.ExpiresAt().Sub(result.Session.IssuedAt()), want)
	}
}

func TestAuthenticateReportsAStoreFailureBehindAValidSession(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	f.users.failGet = true
	if _, err := f.service.Authenticate(f.ctx, login.Token); err == nil {
		t.Error("Authenticate succeeded although the user could not be loaded")
	}

	f.users.failGet = false
	f.sessions.failFind = true
	if _, err := f.service.Authenticate(f.ctx, login.Token); !errors.Is(err, authn.ErrUnauthenticated) {
		t.Errorf("got %v, want ErrUnauthenticated", err)
	}
}

// restoreCredentialAtLowCost rebuilds a credential whose stored hash was made
// at a weaker work factor, which is what a record written by an older version
// looks like.
func restoreCredentialAtLowCost(
	t *testing.T, userID users.ID, tenant business.ID, number phone.Number, pin string,
) *auth.Credential {
	t.Helper()

	weak := lowCostHash(t, pin)
	credential, err := auth.RestoreCredential(auth.CredentialSnapshot{
		UserID:     userID,
		BusinessID: tenant,
		Phone:      number,
		PIN:        weak,
		CreatedAt:  loginAt,
		UpdatedAt:  loginAt,
	})
	if err != nil {
		t.Fatalf("auth.RestoreCredential: %v", err)
	}
	return credential
}
