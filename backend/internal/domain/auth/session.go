package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Errors reported when a session cannot be used.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("auth: identifier is unset")
	// ErrInvalidTime means a timestamp is unset or inconsistent.
	ErrInvalidTime = validate.ErrInvalidTime
	// ErrInvalidLifetime means a session was asked to last no time at all.
	ErrInvalidLifetime = errors.New("auth: invalid session lifetime")

	// ErrSessionExpired means the session's lifetime has run out.
	ErrSessionExpired = errors.New("auth: session has expired")
	// ErrSessionRevoked means the session was ended deliberately.
	ErrSessionRevoked = errors.New("auth: session has been revoked")
	// ErrTokenMismatch means the presented token does not belong to the session.
	ErrTokenMismatch = errors.New("auth: token does not match the session")
)

type sessionTag struct{}

// SessionID identifies a session. It is immutable once assigned.
type SessionID = id.Typed[sessionTag]

// NewSessionID returns a new session identifier.
func NewSessionID() SessionID { return id.NewTyped[sessionTag]() }

// SessionIDFrom tags an identifier drawn from a generator as a session
// identifier.
func SessionIDFrom(value id.ID) SessionID { return id.TypedFrom[sessionTag](value) }

// ParseSessionID reads a session identifier from its text form.
func ParseSessionID(text string) (SessionID, error) { return id.ParseTyped[sessionTag](text) }

// DefaultLifetime is how long a session lasts without being renewed.
//
// It is long on purpose. A session that lapsed mid-trading would lock a shop
// out of its own till, which is the failure ADR-001 exists to prevent, and §45
// says synchronization may be delayed for days. Renewal happens on every
// successful sync, so a device that reaches the network even occasionally never
// approaches this bound; the bound only governs a device that has been away for
// a whole quarter.
const DefaultLifetime = 90 * 24 * time.Hour

// Session is a device's standing proof that a user authenticated.
//
// It is bound to one user, one business, and one device (§28, ADR-012). Binding
// to a device means a stolen token is useless on another installation, and it
// gives the audit trail the device it needs to record (§39).
type Session struct {
	id         SessionID
	userID     users.ID
	businessID business.ID
	deviceID   devices.ID
	tokenHash  TokenHash
	issuedAt   time.Time
	expiresAt  time.Time
	lastSeenAt time.Time
	revokedAt  time.Time
}

// SessionSnapshot is the flat representation of a Session, used to persist it
// and to rebuild it from storage.
//
// RevokedAt is zero for a live session.
type SessionSnapshot struct {
	ID         SessionID
	UserID     users.ID
	BusinessID business.ID
	DeviceID   devices.ID
	TokenHash  TokenHash
	IssuedAt   time.Time
	ExpiresAt  time.Time
	LastSeenAt time.Time
	RevokedAt  time.Time
}

// Issue creates a session and returns the token that unlocks it.
//
// The token is returned here and never again: only its hash is retained, so a
// disclosure of the session table does not yield credentials. A caller that
// loses the returned token must issue a new session.
func Issue(
	sessionID SessionID,
	userID users.ID,
	businessID business.ID,
	deviceID devices.ID,
	now time.Time,
	lifetime time.Duration,
) (*Session, Token, error) {
	if sessionID.IsZero() {
		return nil, Token{}, fmt.Errorf("%w: session", ErrInvalidID)
	}
	if userID.IsZero() {
		return nil, Token{}, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if businessID.IsZero() {
		return nil, Token{}, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if deviceID.IsZero() {
		return nil, Token{}, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if err := validate.Moment(now, "issue time"); err != nil {
		return nil, Token{}, err
	}
	if lifetime <= 0 {
		return nil, Token{}, fmt.Errorf("%w: %s", ErrInvalidLifetime, lifetime)
	}

	token := NewToken()
	issuedAt := now.UTC()
	return &Session{
		id:         sessionID,
		userID:     userID,
		businessID: businessID,
		deviceID:   deviceID,
		tokenHash:  token.Hash(),
		issuedAt:   issuedAt,
		expiresAt:  issuedAt.Add(lifetime),
		lastSeenAt: issuedAt,
	}, token, nil
}

// RestoreSession rebuilds a session from storage, validating it on the way in.
func RestoreSession(snapshot SessionSnapshot) (*Session, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: session", ErrInvalidID)
	}
	if snapshot.UserID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	if snapshot.DeviceID.IsZero() {
		return nil, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if snapshot.TokenHash.IsZero() {
		return nil, fmt.Errorf("%w: stored session has no token hash", ErrInvalidToken)
	}
	if err := validate.Moment(snapshot.IssuedAt, "issue time"); err != nil {
		return nil, err
	}
	if err := validate.Moment(snapshot.ExpiresAt, "expiry time"); err != nil {
		return nil, err
	}
	if snapshot.ExpiresAt.Before(snapshot.IssuedAt) {
		return nil, fmt.Errorf("%w: expires at %s, before it was issued at %s",
			ErrInvalidTime, snapshot.ExpiresAt, snapshot.IssuedAt)
	}
	if err := validate.Moment(snapshot.LastSeenAt, "last seen time"); err != nil {
		return nil, err
	}
	if snapshot.LastSeenAt.Before(snapshot.IssuedAt) {
		return nil, fmt.Errorf("%w: last seen at %s, before it was issued at %s",
			ErrInvalidTime, snapshot.LastSeenAt, snapshot.IssuedAt)
	}
	if !snapshot.RevokedAt.IsZero() && snapshot.RevokedAt.Before(snapshot.IssuedAt) {
		return nil, fmt.Errorf("%w: revoked at %s, before it was issued at %s",
			ErrInvalidTime, snapshot.RevokedAt, snapshot.IssuedAt)
	}

	return &Session{
		id:         snapshot.ID,
		userID:     snapshot.UserID,
		businessID: snapshot.BusinessID,
		deviceID:   snapshot.DeviceID,
		tokenHash:  snapshot.TokenHash,
		issuedAt:   snapshot.IssuedAt.UTC(),
		expiresAt:  snapshot.ExpiresAt.UTC(),
		lastSeenAt: snapshot.LastSeenAt.UTC(),
		revokedAt:  normaliseOptional(snapshot.RevokedAt),
	}, nil
}

func normaliseOptional(at time.Time) time.Time {
	if at.IsZero() {
		return time.Time{}
	}
	return at.UTC()
}

// Snapshot returns the flat representation of the session.
func (s *Session) Snapshot() SessionSnapshot {
	return SessionSnapshot{
		ID:         s.id,
		UserID:     s.userID,
		BusinessID: s.businessID,
		DeviceID:   s.deviceID,
		TokenHash:  s.tokenHash,
		IssuedAt:   s.issuedAt,
		ExpiresAt:  s.expiresAt,
		LastSeenAt: s.lastSeenAt,
		RevokedAt:  s.revokedAt,
	}
}

// ID returns the immutable identifier.
func (s *Session) ID() SessionID { return s.id }

// UserID returns the user the session authenticates.
func (s *Session) UserID() users.ID { return s.userID }

// BusinessID returns the business the session belongs to.
func (s *Session) BusinessID() business.ID { return s.businessID }

// DeviceID returns the installation the session is bound to.
func (s *Session) DeviceID() devices.ID { return s.deviceID }

// IssuedAt returns when the session began, in UTC.
func (s *Session) IssuedAt() time.Time { return s.issuedAt }

// ExpiresAt returns when the session lapses, in UTC.
func (s *Session) ExpiresAt() time.Time { return s.expiresAt }

// LastSeenAt returns when the session was last used, in UTC.
func (s *Session) LastSeenAt() time.Time { return s.lastSeenAt }

// RevokedAt returns when the session was revoked, and whether it was.
func (s *Session) RevokedAt() (time.Time, bool) {
	return s.revokedAt, !s.revokedAt.IsZero()
}

// IsRevoked reports whether the session was ended deliberately.
func (s *Session) IsRevoked() bool { return !s.revokedAt.IsZero() }

// IsExpired reports whether the session has lapsed by the given moment.
//
// Expiry is exclusive of the boundary: a session is still live at the exact
// instant it expires, and lapses immediately after.
func (s *Session) IsExpired(at time.Time) bool { return at.After(s.expiresAt) }

// IsValid reports whether the session can be used at the given moment.
func (s *Session) IsValid(at time.Time) bool {
	return !s.IsRevoked() && !s.IsExpired(at)
}

// Authenticate checks a presented token against the session.
//
// It reports why it failed, because the reasons call for different responses: a
// device holding an expired session should log in again, while a mismatched
// token means the caller is not who they claim.
func (s *Session) Authenticate(token Token, at time.Time) error {
	// Revocation and expiry are checked before the token so that a dead session
	// says so plainly rather than reporting a mismatch.
	if s.IsRevoked() {
		return fmt.Errorf("%w: %s", ErrSessionRevoked, s.id)
	}
	if s.IsExpired(at) {
		return fmt.Errorf("%w: %s lapsed at %s", ErrSessionExpired, s.id, s.expiresAt)
	}
	if !s.tokenHash.Matches(token) {
		return fmt.Errorf("%w: %s", ErrTokenMismatch, s.id)
	}
	return nil
}

// Renew extends the session so that it lasts the given duration from now.
//
// This is called on every successful sync (ADR-012), which is what keeps a
// device that reaches the network from ever meeting its expiry. Renewing does
// not change the token: the device keeps the credential it already holds.
//
// A revoked session cannot be renewed, and neither can an expired one — letting
// a lapsed session be revived would make expiry meaningless.
func (s *Session) Renew(at time.Time, lifetime time.Duration) error {
	if err := validate.Moment(at, "renewal time"); err != nil {
		return err
	}
	if lifetime <= 0 {
		return fmt.Errorf("%w: %s", ErrInvalidLifetime, lifetime)
	}
	if s.IsRevoked() {
		return fmt.Errorf("%w: %s", ErrSessionRevoked, s.id)
	}
	if s.IsExpired(at) {
		return fmt.Errorf("%w: %s lapsed at %s", ErrSessionExpired, s.id, s.expiresAt)
	}

	moment := at.UTC()
	// Renewal never shortens a session. A renewal arriving from a device whose
	// clock is behind must not bring an expiry closer than it already is.
	if extended := moment.Add(lifetime); extended.After(s.expiresAt) {
		s.expiresAt = extended
	}
	s.touch(moment)
	return nil
}

// Touch records that the session was used.
func (s *Session) Touch(at time.Time) error {
	if err := validate.Moment(at, "use time"); err != nil {
		return err
	}
	s.touch(at.UTC())
	return nil
}

// touch advances the last-seen time, never moving it backwards. Devices report
// their own clocks, and a stale one must not rewrite history.
func (s *Session) touch(at time.Time) {
	if at.After(s.lastSeenAt) {
		s.lastSeenAt = at
	}
}

// Revoke ends the session deliberately. It is idempotent: the first revocation
// is the one that stands, so a replayed instruction does not rewrite when the
// session actually ended.
//
// Revocation is recorded rather than deleted, so an audit can still show the
// session existed and when it was ended (§39, §40).
func (s *Session) Revoke(at time.Time) error {
	if err := validate.Moment(at, "revocation time"); err != nil {
		return err
	}
	if s.IsRevoked() {
		return nil
	}
	s.revokedAt = at.UTC()
	return nil
}
