package auth_test

import (
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
)

var issuedAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

func issueTestSession(t *testing.T) (*auth.Session, auth.Token) {
	t.Helper()
	session, token, err := auth.Issue(
		auth.NewSessionID(), users.NewID(), business.NewID(), devices.NewID(),
		issuedAt, auth.DefaultLifetime,
	)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	return session, token
}

func TestIssue(t *testing.T) {
	sessionID, userID := auth.NewSessionID(), users.NewID()
	tenant, deviceID := business.NewID(), devices.NewID()

	session, token, err := auth.Issue(sessionID, userID, tenant, deviceID, issuedAt, auth.DefaultLifetime)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if got := session.ID(); got != sessionID {
		t.Errorf("ID() = %s, want %s", got, sessionID)
	}
	if got := session.UserID(); got != userID {
		t.Errorf("UserID() = %s, want %s", got, userID)
	}
	if got := session.BusinessID(); got != tenant {
		t.Errorf("BusinessID() = %s, want %s", got, tenant)
	}
	if got := session.DeviceID(); got != deviceID {
		t.Errorf("DeviceID() = %s, want %s", got, deviceID)
	}
	if !session.IssuedAt().Equal(issuedAt) {
		t.Errorf("IssuedAt() = %s, want %s", session.IssuedAt(), issuedAt)
	}
	if want := issuedAt.Add(auth.DefaultLifetime); !session.ExpiresAt().Equal(want) {
		t.Errorf("ExpiresAt() = %s, want %s", session.ExpiresAt(), want)
	}
	if !session.LastSeenAt().Equal(issuedAt) {
		t.Errorf("LastSeenAt() = %s, want %s", session.LastSeenAt(), issuedAt)
	}
	if session.IsRevoked() {
		t.Error("a new session is revoked")
	}
	if !session.IsValid(issuedAt) {
		t.Error("a new session is not valid at the moment it was issued")
	}
	if token.IsZero() {
		t.Error("Issue returned no token")
	}
}

// TestIssueReturnsTheTokenOnlyOnce is the property that keeps a disclosure of
// the session table from yielding credentials: the session retains a hash, and
// there is no way back to the secret.
func TestIssueReturnsTheTokenOnlyOnce(t *testing.T) {
	session, token := issueTestSession(t)

	if err := session.Authenticate(token, issuedAt); err != nil {
		t.Fatalf("the returned token does not authenticate: %v", err)
	}

	stored := session.Snapshot().TokenHash
	if stored.IsZero() {
		t.Fatal("the session retained no token hash")
	}
	if stored.String() == token.Secret() {
		t.Error("the session stored the token rather than its hash")
	}
	// The hash matches the token but cannot produce it.
	if !stored.Matches(token) {
		t.Error("the stored hash does not match the issued token")
	}
}

func TestIssueGivesEachSessionADistinctToken(t *testing.T) {
	first, firstToken := issueTestSession(t)
	second, secondToken := issueTestSession(t)

	if firstToken.Secret() == secondToken.Secret() {
		t.Fatal("two sessions were issued the same token")
	}
	if err := first.Authenticate(secondToken, issuedAt); !errors.Is(err, auth.ErrTokenMismatch) {
		t.Errorf("one session accepted another's token: %v", err)
	}
	if err := second.Authenticate(firstToken, issuedAt); !errors.Is(err, auth.ErrTokenMismatch) {
		t.Errorf("one session accepted another's token: %v", err)
	}
}

func TestIssueRejectsInvalidInput(t *testing.T) {
	sessionID, userID := auth.NewSessionID(), users.NewID()
	tenant, deviceID := business.NewID(), devices.NewID()

	tests := []struct {
		name      string
		sessionID auth.SessionID
		userID    users.ID
		tenant    business.ID
		deviceID  devices.ID
		now       time.Time
		lifetime  time.Duration
		want      error
	}{
		{"zero session", auth.SessionID{}, userID, tenant, deviceID, issuedAt, auth.DefaultLifetime, auth.ErrInvalidID},
		{"zero user", sessionID, users.ID{}, tenant, deviceID, issuedAt, auth.DefaultLifetime, auth.ErrInvalidID},
		{"zero business", sessionID, userID, business.ID{}, deviceID, issuedAt, auth.DefaultLifetime, auth.ErrInvalidID},
		{"zero device", sessionID, userID, tenant, devices.ID{}, issuedAt, auth.DefaultLifetime, auth.ErrInvalidID},
		{"zero timestamp", sessionID, userID, tenant, deviceID, time.Time{}, auth.DefaultLifetime, auth.ErrInvalidTime},
		{"zero lifetime", sessionID, userID, tenant, deviceID, issuedAt, 0, auth.ErrInvalidLifetime},
		{"negative lifetime", sessionID, userID, tenant, deviceID, issuedAt, -time.Hour, auth.ErrInvalidLifetime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			session, token, err := auth.Issue(tc.sessionID, tc.userID, tc.tenant, tc.deviceID, tc.now, tc.lifetime)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if session != nil {
				t.Error("returned a session alongside an error")
			}
			if !token.IsZero() {
				t.Error("returned a token alongside an error")
			}
		})
	}
}

// TestSessionIsBoundToOneDevice is why a stolen token is useless elsewhere: the
// session names the installation it belongs to, and the audit trail needs it
// too (§39).
func TestSessionIsBoundToOneDevice(t *testing.T) {
	deviceID := devices.NewID()
	session, _, err := auth.Issue(
		auth.NewSessionID(), users.NewID(), business.NewID(), deviceID,
		issuedAt, auth.DefaultLifetime,
	)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if got := session.DeviceID(); got != deviceID {
		t.Errorf("DeviceID() = %s, want %s", got, deviceID)
	}
	if session.DeviceID() == devices.NewID() {
		t.Error("the session's device matched a freshly generated one")
	}
}

func TestExpiry(t *testing.T) {
	session, token := issueTestSession(t)
	expiresAt := issuedAt.Add(auth.DefaultLifetime)

	tests := []struct {
		name    string
		at      time.Time
		expired bool
	}{
		{"at issue", issuedAt, false},
		{"a day later", issuedAt.Add(24 * time.Hour), false},
		{"a moment before expiry", expiresAt.Add(-time.Nanosecond), false},
		{"exactly at expiry", expiresAt, false},
		{"a moment after expiry", expiresAt.Add(time.Nanosecond), true},
		{"long after", expiresAt.Add(365 * 24 * time.Hour), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := session.IsExpired(tc.at); got != tc.expired {
				t.Errorf("IsExpired(%s) = %v, want %v", tc.at, got, tc.expired)
			}
			if got := session.IsValid(tc.at); got != !tc.expired {
				t.Errorf("IsValid(%s) = %v, want %v", tc.at, got, !tc.expired)
			}

			err := session.Authenticate(token, tc.at)
			if tc.expired && !errors.Is(err, auth.ErrSessionExpired) {
				t.Errorf("Authenticate = %v, want ErrSessionExpired", err)
			}
			if !tc.expired && err != nil {
				t.Errorf("Authenticate = %v, want nil", err)
			}
		})
	}
}

// TestDefaultLifetimeSurvivesALongSyncGap is the reason it is set where it is:
// §45 expects delays of days, and a session lapsing mid-trading would lock a
// shop out of its own till.
func TestDefaultLifetimeSurvivesALongSyncGap(t *testing.T) {
	session, _ := issueTestSession(t)

	if got := auth.DefaultLifetime; got < 30*24*time.Hour {
		t.Errorf("DefaultLifetime = %s, which is too short for a multi-day sync gap", got)
	}
	if !session.IsValid(issuedAt.Add(30 * 24 * time.Hour)) {
		t.Error("a session lapsed within a month of being issued")
	}
}

func TestAuthenticateRejectsAWrongToken(t *testing.T) {
	session, _ := issueTestSession(t)

	other := auth.NewToken()

	if err := session.Authenticate(other, issuedAt); !errors.Is(err, auth.ErrTokenMismatch) {
		t.Errorf("got %v, want ErrTokenMismatch", err)
	}
	if err := session.Authenticate(auth.Token{}, issuedAt); !errors.Is(err, auth.ErrTokenMismatch) {
		t.Errorf("the zero Token: got %v, want ErrTokenMismatch", err)
	}
}

// TestADeadSessionSaysSoRatherThanReportingAMismatch matters for the client: an
// expired session should prompt a fresh login, while a mismatch means the
// caller is not who they claim.
func TestADeadSessionSaysSoRatherThanReportingAMismatch(t *testing.T) {
	session, token := issueTestSession(t)
	wrong := auth.NewToken()

	afterExpiry := issuedAt.Add(auth.DefaultLifetime + time.Hour)

	// Expired, correct token.
	if err := session.Authenticate(token, afterExpiry); !errors.Is(err, auth.ErrSessionExpired) {
		t.Errorf("got %v, want ErrSessionExpired", err)
	}
	// Expired, wrong token: still reported as expired.
	if err := session.Authenticate(wrong, afterExpiry); !errors.Is(err, auth.ErrSessionExpired) {
		t.Errorf("got %v, want ErrSessionExpired", err)
	}

	if err := session.Revoke(issuedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	// Revocation outranks expiry, because it is the more specific fact.
	if err := session.Authenticate(token, issuedAt.Add(2*time.Hour)); !errors.Is(err, auth.ErrSessionRevoked) {
		t.Errorf("got %v, want ErrSessionRevoked", err)
	}
}

func TestRenew(t *testing.T) {
	session, token := issueTestSession(t)
	originalExpiry := session.ExpiresAt()

	renewedAt := issuedAt.Add(24 * time.Hour)
	if err := session.Renew(renewedAt, auth.DefaultLifetime); err != nil {
		t.Fatalf("Renew: %v", err)
	}

	if want := renewedAt.Add(auth.DefaultLifetime); !session.ExpiresAt().Equal(want) {
		t.Errorf("ExpiresAt() = %s, want %s", session.ExpiresAt(), want)
	}
	if !session.ExpiresAt().After(originalExpiry) {
		t.Error("renewal did not extend the session")
	}
	if !session.LastSeenAt().Equal(renewedAt) {
		t.Errorf("LastSeenAt() = %s, want %s", session.LastSeenAt(), renewedAt)
	}
	// The device keeps the credential it already holds.
	if err := session.Authenticate(token, renewedAt); err != nil {
		t.Errorf("the token stopped working after renewal: %v", err)
	}
}

// TestRenewNeverShortensASession guards against a device whose clock is behind
// pulling its own expiry closer.
func TestRenewNeverShortensASession(t *testing.T) {
	session, _ := issueTestSession(t)
	originalExpiry := session.ExpiresAt()

	// A renewal from a device reporting a much earlier time, with a short
	// lifetime, would otherwise bring the expiry forward.
	if err := session.Renew(issuedAt.Add(time.Hour), time.Minute); err != nil {
		t.Fatalf("Renew: %v", err)
	}

	if !session.ExpiresAt().Equal(originalExpiry) {
		t.Errorf("ExpiresAt() moved to %s, want it left at %s", session.ExpiresAt(), originalExpiry)
	}
}

// TestRenewCannotReviveADeadSession keeps expiry meaningful.
func TestRenewCannotReviveADeadSession(t *testing.T) {
	expired, _ := issueTestSession(t)
	afterExpiry := issuedAt.Add(auth.DefaultLifetime + time.Hour)

	if err := expired.Renew(afterExpiry, auth.DefaultLifetime); !errors.Is(err, auth.ErrSessionExpired) {
		t.Errorf("got %v, want ErrSessionExpired", err)
	}
	if expired.IsValid(afterExpiry) {
		t.Error("a lapsed session was revived")
	}

	revoked, _ := issueTestSession(t)
	if err := revoked.Revoke(issuedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := revoked.Renew(issuedAt.Add(2*time.Hour), auth.DefaultLifetime); !errors.Is(err, auth.ErrSessionRevoked) {
		t.Errorf("got %v, want ErrSessionRevoked", err)
	}
	if revoked.IsValid(issuedAt.Add(2 * time.Hour)) {
		t.Error("a revoked session was revived")
	}
}

func TestRenewRejectsInvalidInput(t *testing.T) {
	session, _ := issueTestSession(t)

	if err := session.Renew(time.Time{}, auth.DefaultLifetime); !errors.Is(err, auth.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := session.Renew(issuedAt, 0); !errors.Is(err, auth.ErrInvalidLifetime) {
		t.Errorf("got %v, want ErrInvalidLifetime", err)
	}
	if err := session.Renew(issuedAt, -time.Hour); !errors.Is(err, auth.ErrInvalidLifetime) {
		t.Errorf("got %v, want ErrInvalidLifetime", err)
	}
}

func TestTouch(t *testing.T) {
	session, _ := issueTestSession(t)

	usedAt := issuedAt.Add(2 * time.Hour)
	if err := session.Touch(usedAt); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	if !session.LastSeenAt().Equal(usedAt) {
		t.Errorf("LastSeenAt() = %s, want %s", session.LastSeenAt(), usedAt)
	}

	if err := session.Touch(time.Time{}); !errors.Is(err, auth.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

// TestTouchNeverMovesLastSeenBackwards matters because devices report their own
// clocks, and a stale one must not rewrite history.
func TestTouchNeverMovesLastSeenBackwards(t *testing.T) {
	session, _ := issueTestSession(t)

	later := issuedAt.Add(5 * time.Hour)
	if err := session.Touch(later); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	if err := session.Touch(issuedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Touch: %v", err)
	}

	if !session.LastSeenAt().Equal(later) {
		t.Errorf("LastSeenAt() moved back to %s, want it left at %s", session.LastSeenAt(), later)
	}
}

func TestRevoke(t *testing.T) {
	session, token := issueTestSession(t)
	revokedAt := issuedAt.Add(time.Hour)

	if err := session.Revoke(revokedAt); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	if !session.IsRevoked() {
		t.Error("the session is not revoked")
	}
	at, revoked := session.RevokedAt()
	if !revoked || !at.Equal(revokedAt) {
		t.Errorf("RevokedAt() = %s, %v; want %s, true", at, revoked, revokedAt)
	}
	if session.IsValid(revokedAt) {
		t.Error("a revoked session reported valid")
	}
	if err := session.Authenticate(token, revokedAt); !errors.Is(err, auth.ErrSessionRevoked) {
		t.Errorf("got %v, want ErrSessionRevoked", err)
	}

	if err := session.Revoke(time.Time{}); !errors.Is(err, auth.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

// TestRevocationIsIdempotent keeps a replayed instruction from rewriting when
// the session actually ended.
func TestRevocationIsIdempotent(t *testing.T) {
	session, _ := issueTestSession(t)
	revokedAt := issuedAt.Add(time.Hour)

	if err := session.Revoke(revokedAt); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := session.Revoke(revokedAt.Add(24 * time.Hour)); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	at, _ := session.RevokedAt()
	if !at.Equal(revokedAt) {
		t.Errorf("a repeated revocation moved the time to %s, want %s", at, revokedAt)
	}
}

func TestIssueNormalisesTheTimestampToUTC(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	local := time.Date(2026, 8, 14, 10, 30, 0, 0, wat)

	session, _, err := auth.Issue(
		auth.NewSessionID(), users.NewID(), business.NewID(), devices.NewID(),
		local, auth.DefaultLifetime,
	)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	for name, moment := range map[string]time.Time{
		"IssuedAt":   session.IssuedAt(),
		"ExpiresAt":  session.ExpiresAt(),
		"LastSeenAt": session.LastSeenAt(),
	} {
		if got := moment.Location(); got != time.UTC {
			t.Errorf("%s location = %s, want UTC", name, got)
		}
	}
	if !session.IssuedAt().Equal(local) {
		t.Errorf("IssuedAt() = %s, want the same instant as %s", session.IssuedAt(), local)
	}
}

func TestSessionSnapshotRoundTrip(t *testing.T) {
	session, token := issueTestSession(t)
	if err := session.Touch(issuedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	if err := session.Renew(issuedAt.Add(2*time.Hour), auth.DefaultLifetime); err != nil {
		t.Fatalf("Renew: %v", err)
	}
	if err := session.Revoke(issuedAt.Add(3 * time.Hour)); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	restored, err := auth.RestoreSession(session.Snapshot())
	if err != nil {
		t.Fatalf("RestoreSession: %v", err)
	}
	if restored.Snapshot() != session.Snapshot() {
		t.Errorf("round trip gave %+v, want %+v", restored.Snapshot(), session.Snapshot())
	}

	// A restored session still recognises its own token.
	live, liveToken := issueTestSession(t)
	revived, err := auth.RestoreSession(live.Snapshot())
	if err != nil {
		t.Fatalf("RestoreSession: %v", err)
	}
	if err := revived.Authenticate(liveToken, issuedAt); err != nil {
		t.Errorf("a restored session rejected its token: %v", err)
	}
	if revived.Authenticate(token, issuedAt) == nil {
		t.Error("a restored session accepted another session's token")
	}
}

func TestRestoreSessionValidatesStoredData(t *testing.T) {
	session, _ := issueTestSession(t)
	valid := session.Snapshot()

	if _, err := auth.RestoreSession(valid); err != nil {
		t.Fatalf("RestoreSession rejected a valid snapshot: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*auth.SessionSnapshot)
		want   error
	}{
		{"zero session", func(s *auth.SessionSnapshot) { s.ID = auth.SessionID{} }, auth.ErrInvalidID},
		{"zero user", func(s *auth.SessionSnapshot) { s.UserID = users.ID{} }, auth.ErrInvalidID},
		{"zero business", func(s *auth.SessionSnapshot) { s.BusinessID = business.ID{} }, auth.ErrInvalidID},
		{"zero device", func(s *auth.SessionSnapshot) { s.DeviceID = devices.ID{} }, auth.ErrInvalidID},
		{"no token hash", func(s *auth.SessionSnapshot) { s.TokenHash = auth.TokenHash{} }, auth.ErrInvalidToken},
		{"zero issue time", func(s *auth.SessionSnapshot) { s.IssuedAt = time.Time{} }, auth.ErrInvalidTime},
		{"zero expiry", func(s *auth.SessionSnapshot) { s.ExpiresAt = time.Time{} }, auth.ErrInvalidTime},
		{"zero last seen", func(s *auth.SessionSnapshot) { s.LastSeenAt = time.Time{} }, auth.ErrInvalidTime},
		{
			"expires before it was issued",
			func(s *auth.SessionSnapshot) { s.ExpiresAt = s.IssuedAt.Add(-time.Hour) },
			auth.ErrInvalidTime,
		},
		{
			"last seen before it was issued",
			func(s *auth.SessionSnapshot) { s.LastSeenAt = s.IssuedAt.Add(-time.Hour) },
			auth.ErrInvalidTime,
		},
		{
			"revoked before it was issued",
			func(s *auth.SessionSnapshot) { s.RevokedAt = s.IssuedAt.Add(-time.Hour) },
			auth.ErrInvalidTime,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := valid
			tc.mutate(&snapshot)

			restored, err := auth.RestoreSession(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if restored != nil {
				t.Error("returned a session alongside an error")
			}
		})
	}
}

// TestRestoreSessionAcceptsAnUnrevokedSession pins that a zero revocation time
// means "still live" rather than "revoked at the epoch".
func TestRestoreSessionAcceptsAnUnrevokedSession(t *testing.T) {
	session, _ := issueTestSession(t)
	snapshot := session.Snapshot()

	if !snapshot.RevokedAt.IsZero() {
		t.Fatal("a fresh session carries a revocation time")
	}

	restored, err := auth.RestoreSession(snapshot)
	if err != nil {
		t.Fatalf("RestoreSession: %v", err)
	}
	if restored.IsRevoked() {
		t.Error("an unrevoked session was restored as revoked")
	}
	if !restored.IsValid(issuedAt) {
		t.Error("an unrevoked session was restored as invalid")
	}
}

func TestSessionIDHelpers(t *testing.T) {
	sessionID := auth.NewSessionID()
	if sessionID.IsZero() {
		t.Fatal("NewSessionID produced a zero identifier")
	}

	parsed, err := auth.ParseSessionID(sessionID.String())
	if err != nil {
		t.Fatalf("ParseSessionID: %v", err)
	}
	if parsed != sessionID {
		t.Errorf("round trip gave %s, want %s", parsed, sessionID)
	}

	if _, err := auth.ParseSessionID("nonsense"); err == nil {
		t.Error("ParseSessionID accepted malformed input")
	}

	// Session identifiers must not interchange with the others they sit beside.
	underlying := sessionID.ID()
	if any(auth.SessionIDFrom(underlying)) == any(users.IDFrom(underlying)) {
		t.Error("session and user identifiers are the same type")
	}
}
