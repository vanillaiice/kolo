package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

type sessionFixture struct {
	sessions   *postgres.SessionRepository
	deviceRepo *postgres.DeviceRepository
	users      *postgres.UserRepository
	businesses *postgres.BusinessRepository
	ctx        context.Context
}

func newSessionFixture(t *testing.T) sessionFixture {
	t.Helper()
	pool := pgtest.Pool(t)
	return sessionFixture{
		sessions:   postgres.NewSessionRepository(pool),
		deviceRepo: postgres.NewDeviceRepository(pool),
		users:      postgres.NewUserRepository(pool),
		businesses: postgres.NewBusinessRepository(pool),
		ctx:        context.Background(),
	}
}

func (f sessionFixture) storedUser(t *testing.T, tenant business.ID, scope business.Scope, name string) *users.User {
	t.Helper()
	record := newUser(t, tenant, name, authz.RoleCashier)
	if err := f.users.Create(f.ctx, scope, record); err != nil {
		t.Fatalf("creating the user: %v", err)
	}
	return record
}

func (f sessionFixture) storedDevice(t *testing.T, tenant business.ID, scope business.Scope, label string) *devices.Device {
	t.Helper()
	device, err := devices.Register(devices.NewID(), tenant, label, devices.PlatformAndroid, createdAt)
	if err != nil {
		t.Fatalf("devices.Register: %v", err)
	}
	if err := f.deviceRepo.Create(f.ctx, scope, device); err != nil {
		t.Fatalf("creating the device: %v", err)
	}
	return device
}

// tenantWithLogin sets up the whole chain a real login needs.
func (f sessionFixture) tenantWithLogin(t *testing.T) (business.Scope, *users.User, *devices.Device) {
	t.Helper()
	tenant, scope := newTenant(t, f.businesses, f.ctx)
	return scope, f.storedUser(t, tenant.ID(), scope, "Jean Mbarga"), f.storedDevice(t, tenant.ID(), scope, "Till 1")
}

func (f sessionFixture) issue(
	t *testing.T, scope business.Scope, user *users.User, device *devices.Device,
) (*auth.Session, auth.Token) {
	t.Helper()
	session, token, err := auth.Issue(
		auth.NewSessionID(), user.ID(), scope.Business(), device.ID(), createdAt, auth.DefaultLifetime,
	)
	if err != nil {
		t.Fatalf("auth.Issue: %v", err)
	}
	if err := f.sessions.Create(f.ctx, scope, session); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return session, token
}

func TestCreateAndGetSession(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	created, token := f.issue(t, scope, user, device)

	loaded, err := f.sessions.Get(f.ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
	if err := loaded.Authenticate(token, createdAt); err != nil {
		t.Errorf("a session read back from storage rejected its token: %v", err)
	}
}

// TestFindByTokenIsTheAuthenticationPath covers the lookup every authenticated
// request makes. It is unscoped on purpose: a request arrives carrying only a
// token, so the tenant is what this discovers.
func TestFindByTokenIsTheAuthenticationPath(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	created, token := f.issue(t, scope, user, device)

	found, err := f.sessions.FindByToken(f.ctx, token)
	if err != nil {
		t.Fatalf("FindByToken: %v", err)
	}
	if found.ID() != created.ID() {
		t.Errorf("found session %s, want %s", found.ID(), created.ID())
	}
	// And it discovers the tenant, which is what bounds everything downstream.
	if found.BusinessID() != scope.Business() {
		t.Errorf("BusinessID() = %s, want %s", found.BusinessID(), scope.Business())
	}
	if err := found.Authenticate(token, createdAt); err != nil {
		t.Errorf("the found session rejected the token that found it: %v", err)
	}
}

// TestOneSessionsTokenDoesNotFindAnother is what the unique index on the token
// hash guarantees: no token can ever authenticate the wrong user.
func TestOneSessionsTokenDoesNotFindAnother(t *testing.T) {
	f := newSessionFixture(t)

	scopeA, userA, deviceA := f.tenantWithLogin(t)
	scopeB, userB, deviceB := f.tenantWithLogin(t)

	sessionA, tokenA := f.issue(t, scopeA, userA, deviceA)
	sessionB, tokenB := f.issue(t, scopeB, userB, deviceB)

	foundA, err := f.sessions.FindByToken(f.ctx, tokenA)
	if err != nil {
		t.Fatalf("FindByToken: %v", err)
	}
	foundB, err := f.sessions.FindByToken(f.ctx, tokenB)
	if err != nil {
		t.Fatalf("FindByToken: %v", err)
	}

	if foundA.ID() != sessionA.ID() || foundB.ID() != sessionB.ID() {
		t.Error("a token found the wrong session")
	}
	if foundA.BusinessID() == foundB.BusinessID() {
		t.Error("two tenants' sessions resolved to one business")
	}
	// A token from one tenant must not authenticate the other's session.
	if err := sessionA.Authenticate(tokenB, createdAt); !errors.Is(err, auth.ErrTokenMismatch) {
		t.Errorf("got %v, want ErrTokenMismatch", err)
	}
}

func TestFindByTokenMissesAnUnknownToken(t *testing.T) {
	f := newSessionFixture(t)

	unknown := auth.NewToken()
	if _, err := f.sessions.FindByToken(f.ctx, unknown); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := f.sessions.FindByToken(f.ctx, auth.Token{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero Token: got %v, want ErrNotFound", err)
	}
}

func TestUpdateSession(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	session, token := f.issue(t, scope, user, device)
	originalExpiry := session.ExpiresAt()

	renewedAt := createdAt.Add(24 * time.Hour)
	if err := session.Renew(renewedAt, auth.DefaultLifetime); err != nil {
		t.Fatalf("Renew: %v", err)
	}
	if err := f.sessions.Update(f.ctx, scope, session); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := f.sessions.Get(f.ctx, scope, session.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !loaded.ExpiresAt().After(originalExpiry) {
		t.Error("the renewal did not extend the stored session")
	}
	// Renewal does not reissue: the device keeps the token it already holds.
	if err := loaded.Authenticate(token, renewedAt); err != nil {
		t.Errorf("the token stopped working after a stored renewal: %v", err)
	}
}

func TestRevocationSurvivesARoundTrip(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	session, token := f.issue(t, scope, user, device)

	revokedAt := createdAt.Add(time.Hour)
	if err := session.Revoke(revokedAt); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := f.sessions.Update(f.ctx, scope, session); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := f.sessions.Get(f.ctx, scope, session.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !loaded.IsRevoked() {
		t.Fatal("the session came back live after being revoked")
	}
	at, _ := loaded.RevokedAt()
	if !at.Equal(revokedAt) {
		t.Errorf("RevokedAt() = %s, want %s", at, revokedAt)
	}
	if err := loaded.Authenticate(token, revokedAt); !errors.Is(err, auth.ErrSessionRevoked) {
		t.Errorf("got %v, want ErrSessionRevoked", err)
	}
}

// TestALiveSessionStoresNoRevocationTime pins that "never revoked" is SQL NULL
// rather than a date at the beginning of time.
func TestALiveSessionStoresNoRevocationTime(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	session, _ := f.issue(t, scope, user, device)

	loaded, err := f.sessions.Get(f.ctx, scope, session.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.IsRevoked() {
		t.Error("a live session came back revoked")
	}
	if at, revoked := loaded.RevokedAt(); revoked || !at.IsZero() {
		t.Errorf("RevokedAt() = %s, %v; want the zero time and false", at, revoked)
	}
}

// TestRevokeAllForUser is what suspending someone does server-side.
func TestRevokeAllForUser(t *testing.T) {
	f := newSessionFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)

	suspended := f.storedUser(t, tenant.ID(), scope, "Jean Mbarga")
	other := f.storedUser(t, tenant.ID(), scope, "Marie Ngo")
	till := f.storedDevice(t, tenant.ID(), scope, "Till 1")
	phone := f.storedDevice(t, tenant.ID(), scope, "Phone")

	// The suspended user is logged in on two devices; the other user on one.
	_, firstToken := f.issue(t, scope, suspended, till)
	_, secondToken := f.issue(t, scope, suspended, phone)
	_, otherToken := f.issue(t, scope, other, till)

	revokedAt := createdAt.Add(time.Hour)
	count, err := f.sessions.RevokeAllForUser(f.ctx, scope, suspended.ID(), revokedAt)
	if err != nil {
		t.Fatalf("RevokeAllForUser: %v", err)
	}
	if count != 2 {
		t.Errorf("revoked %d sessions, want 2", count)
	}

	for name, token := range map[string]auth.Token{"first": firstToken, "second": secondToken} {
		found, err := f.sessions.FindByToken(f.ctx, token)
		if err != nil {
			t.Fatalf("FindByToken: %v", err)
		}
		if !found.IsRevoked() {
			t.Errorf("the %s session is still live", name)
		}
	}

	// The other user is untouched.
	untouched, err := f.sessions.FindByToken(f.ctx, otherToken)
	if err != nil {
		t.Fatalf("FindByToken: %v", err)
	}
	if untouched.IsRevoked() {
		t.Error("another user's session was revoked")
	}

	// Revoking again finds nothing left to revoke, and does not rewrite when
	// the sessions actually ended.
	again, err := f.sessions.RevokeAllForUser(f.ctx, scope, suspended.ID(), revokedAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("RevokeAllForUser: %v", err)
	}
	if again != 0 {
		t.Errorf("a second revocation touched %d sessions, want none", again)
	}
	reloaded, err := f.sessions.FindByToken(f.ctx, firstToken)
	if err != nil {
		t.Fatalf("FindByToken: %v", err)
	}
	at, _ := reloaded.RevokedAt()
	if !at.Equal(revokedAt) {
		t.Errorf("the recorded revocation moved to %s, want %s", at, revokedAt)
	}
}

// TestRevokeAllForDevice is what happens when a device is reported lost.
func TestRevokeAllForDevice(t *testing.T) {
	f := newSessionFixture(t)
	tenant, scope := newTenant(t, f.businesses, f.ctx)

	jean := f.storedUser(t, tenant.ID(), scope, "Jean Mbarga")
	marie := f.storedUser(t, tenant.ID(), scope, "Marie Ngo")
	lost := f.storedDevice(t, tenant.ID(), scope, "Lost Till")
	kept := f.storedDevice(t, tenant.ID(), scope, "Kept Till")

	_, jeanOnLost := f.issue(t, scope, jean, lost)
	_, marieOnLost := f.issue(t, scope, marie, lost)
	_, jeanOnKept := f.issue(t, scope, jean, kept)

	count, err := f.sessions.RevokeAllForDevice(f.ctx, scope, lost.ID(), createdAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("RevokeAllForDevice: %v", err)
	}
	if count != 2 {
		t.Errorf("revoked %d sessions, want 2", count)
	}

	for name, token := range map[string]auth.Token{"Jean's": jeanOnLost, "Marie's": marieOnLost} {
		found, err := f.sessions.FindByToken(f.ctx, token)
		if err != nil {
			t.Fatalf("FindByToken: %v", err)
		}
		if !found.IsRevoked() {
			t.Errorf("%s session on the lost device is still live", name)
		}
	}

	survivor, err := f.sessions.FindByToken(f.ctx, jeanOnKept)
	if err != nil {
		t.Fatalf("FindByToken: %v", err)
	}
	if survivor.IsRevoked() {
		t.Error("a session on another device was revoked")
	}
}

// TestBulkRevocationCannotReachAnotherTenant keeps a revocation from becoming a
// way to log another business's staff out.
func TestBulkRevocationCannotReachAnotherTenant(t *testing.T) {
	f := newSessionFixture(t)

	scopeA, userA, deviceA := f.tenantWithLogin(t)
	scopeB, userB, deviceB := f.tenantWithLogin(t)

	_, tokenB := f.issue(t, scopeB, userB, deviceB)
	f.issue(t, scopeA, userA, deviceA)

	// Business A tries to revoke business B's user and device.
	count, err := f.sessions.RevokeAllForUser(f.ctx, scopeA, userB.ID(), createdAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("RevokeAllForUser: %v", err)
	}
	if count != 0 {
		t.Errorf("revoked %d of another tenant's sessions, want none", count)
	}

	count, err = f.sessions.RevokeAllForDevice(f.ctx, scopeA, deviceB.ID(), createdAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("RevokeAllForDevice: %v", err)
	}
	if count != 0 {
		t.Errorf("revoked %d of another tenant's sessions, want none", count)
	}

	survivor, err := f.sessions.FindByToken(f.ctx, tokenB)
	if err != nil {
		t.Fatalf("FindByToken: %v", err)
	}
	if survivor.IsRevoked() {
		t.Error("another tenant revoked this session")
	}
}

func TestBulkRevocationRejectsBadInput(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	var unset business.Scope

	if _, err := f.sessions.RevokeAllForUser(f.ctx, unset, user.ID(), createdAt); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("got %v, want ErrNoTenant", err)
	}
	if _, err := f.sessions.RevokeAllForDevice(f.ctx, unset, device.ID(), createdAt); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("got %v, want ErrNoTenant", err)
	}
	if _, err := f.sessions.RevokeAllForUser(f.ctx, scope, user.ID(), time.Time{}); !errors.Is(err, auth.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if _, err := f.sessions.RevokeAllForUser(f.ctx, scope, users.ID{}, createdAt); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero user: got %v, want ErrNotFound", err)
	}
	if _, err := f.sessions.RevokeAllForDevice(f.ctx, scope, devices.ID{}, createdAt); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero device: got %v, want ErrNotFound", err)
	}
}

// TestDeleteExpiredKeepsRevokedSessionsUntilTheyLapse checks the retention rule
// the method documents: a revoked session survives long enough to be audited.
func TestDeleteExpiredKeepsRevokedSessionsUntilTheyLapse(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	live, liveToken := f.issue(t, scope, user, device)

	revoked, revokedToken := f.issue(t, scope, user, device)
	if err := revoked.Revoke(createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := f.sessions.Update(f.ctx, scope, revoked); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// A cutoff before either session's expiry removes neither.
	removed, err := f.sessions.DeleteExpired(f.ctx, createdAt.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
	if removed != 0 {
		t.Errorf("removed %d sessions before any had lapsed, want none", removed)
	}
	for name, token := range map[string]auth.Token{"live": liveToken, "revoked": revokedToken} {
		if _, err := f.sessions.FindByToken(f.ctx, token); err != nil {
			t.Errorf("the %s session was removed early: %v", name, err)
		}
	}

	// Past their expiry, both go.
	pastExpiry := live.ExpiresAt().Add(time.Hour)
	removed, err = f.sessions.DeleteExpired(f.ctx, pastExpiry)
	if err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
	if removed < 2 {
		t.Errorf("removed %d sessions, want at least the 2 belonging to this test", removed)
	}
	for name, token := range map[string]auth.Token{"live": liveToken, "revoked": revokedToken} {
		if _, err := f.sessions.FindByToken(f.ctx, token); !errors.Is(err, postgres.ErrNotFound) {
			t.Errorf("the %s session survived the cutoff: %v", name, err)
		}
	}

	if _, err := f.sessions.DeleteExpired(f.ctx, time.Time{}); !errors.Is(err, auth.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestSessionScopedOperationsRefuseAnUnsetScopeOrOtherTenant(t *testing.T) {
	f := newSessionFixture(t)
	scopeA, userA, deviceA := f.tenantWithLogin(t)
	_, scopeB := newTenant(t, f.businesses, f.ctx)

	session, _ := f.issue(t, scopeA, userA, deviceA)

	var unset business.Scope

	if err := f.sessions.Create(f.ctx, unset, session); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("Create: got %v, want ErrNoTenant", err)
	}
	if _, err := f.sessions.Get(f.ctx, unset, session.ID()); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("Get: got %v, want ErrNoTenant", err)
	}
	if err := f.sessions.Update(f.ctx, unset, session); !errors.Is(err, business.ErrNoTenant) {
		t.Errorf("Update: got %v, want ErrNoTenant", err)
	}

	if err := f.sessions.Create(f.ctx, scopeB, session); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("cross-tenant Create: got %v, want ErrCrossTenant", err)
	}
	if err := f.sessions.Update(f.ctx, scopeB, session); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("cross-tenant Update: got %v, want ErrCrossTenant", err)
	}
	if _, err := f.sessions.Get(f.ctx, scopeB, session.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("cross-tenant Get: got %v, want ErrNotFound", err)
	}
}

func TestGetAndUpdateMissingSession(t *testing.T) {
	f := newSessionFixture(t)
	scope, user, device := f.tenantWithLogin(t)

	if _, err := f.sessions.Get(f.ctx, scope, auth.NewSessionID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := f.sessions.Get(f.ctx, scope, auth.SessionID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero identifier: got %v, want ErrNotFound", err)
	}

	absent, _, err := auth.Issue(
		auth.NewSessionID(), user.ID(), scope.Business(), device.ID(), createdAt, auth.DefaultLifetime,
	)
	if err != nil {
		t.Fatalf("auth.Issue: %v", err)
	}
	if err := f.sessions.Update(f.ctx, scope, absent); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

// TestASessionCannotSpanTwoTenants checks the composite keys from migration 3:
// the user and the device must both belong to the session's business. The scope
// guard cannot see this, so the database is the only thing that catches it.
func TestASessionCannotSpanTwoTenants(t *testing.T) {
	f := newSessionFixture(t)

	tenantA, scopeA := newTenant(t, f.businesses, f.ctx)
	tenantB, scopeB := newTenant(t, f.businesses, f.ctx)

	userOfA := f.storedUser(t, tenantA.ID(), scopeA, "Jean")
	deviceOfA := f.storedDevice(t, tenantA.ID(), scopeA, "Till A")
	userOfB := f.storedUser(t, tenantB.ID(), scopeB, "Marie")
	deviceOfB := f.storedDevice(t, tenantB.ID(), scopeB, "Till B")

	t.Run("another tenant's user", func(t *testing.T) {
		session, _, err := auth.Issue(
			auth.NewSessionID(), userOfB.ID(), tenantA.ID(), deviceOfA.ID(), createdAt, auth.DefaultLifetime,
		)
		if err != nil {
			t.Fatalf("auth.Issue: %v", err)
		}
		if err := f.sessions.Create(f.ctx, scopeA, session); !errors.Is(err, postgres.ErrConflict) {
			t.Errorf("got %v, want ErrConflict", err)
		}
	})

	t.Run("another tenant's device", func(t *testing.T) {
		session, _, err := auth.Issue(
			auth.NewSessionID(), userOfA.ID(), tenantA.ID(), deviceOfB.ID(), createdAt, auth.DefaultLifetime,
		)
		if err != nil {
			t.Fatalf("auth.Issue: %v", err)
		}
		if err := f.sessions.Create(f.ctx, scopeA, session); !errors.Is(err, postgres.ErrConflict) {
			t.Errorf("got %v, want ErrConflict", err)
		}
	})
}
