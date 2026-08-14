// Package authn is the application service for logging in and out.
//
// It sits between the HTTP layer and the domain (ADR-005): it orchestrates the
// several records a login touches — credential, user, device, session — and
// owns the rules about what a failure reveals. It knows nothing about HTTP, and
// the domain knows nothing about it.
package authn

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/auth"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/domain/users"
	"github.com/vanillaiice/kolo/backend/internal/kernel/clock"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
	"github.com/vanillaiice/kolo/backend/internal/kernel/phone"
)

// Errors reported to a caller attempting to log in.
var (
	// ErrInvalidCredentials means the phone number or the PIN was wrong.
	//
	// It deliberately does not say which. Telling a caller that a number is
	// registered but the PIN is wrong turns the login endpoint into a way to
	// discover who works for a business.
	ErrInvalidCredentials = errors.New("authn: phone number or PIN is incorrect")

	// ErrAccountSuspended means the credentials were right but the user may not
	// use the system. This is distinguished from a wrong PIN because the person
	// has already proved who they are, and being told to keep retrying a
	// correct PIN would be worse than being told to speak to the owner.
	ErrAccountSuspended = errors.New("authn: account is suspended")

	// ErrDeviceSuspended means the device has been taken out of service.
	ErrDeviceSuspended = errors.New("authn: device is not in service")

	// ErrInvalidRequest means the request was missing something required.
	ErrInvalidRequest = errors.New("authn: invalid request")

	// ErrUnauthenticated means a presented token does not identify a live
	// session.
	ErrUnauthenticated = errors.New("authn: not authenticated")
)

// Repository interfaces are declared here, by the code that uses them, rather
// than beside their implementations (ADR-005). The service depends on what it
// needs; the driver-facing package supplies it.

// CredentialStore reads and writes login credentials.
type CredentialStore interface {
	FindByPhone(ctx context.Context, scope business.Scope, number phone.Number) (*auth.Credential, error)
	Update(ctx context.Context, scope business.Scope, credential *auth.Credential) error
}

// UserStore reads users.
type UserStore interface {
	Get(ctx context.Context, scope business.Scope, userID users.ID) (*users.User, error)
}

// DeviceStore reads and writes devices.
type DeviceStore interface {
	Get(ctx context.Context, scope business.Scope, deviceID devices.ID) (*devices.Device, error)
	Create(ctx context.Context, scope business.Scope, device *devices.Device) error
	Update(ctx context.Context, scope business.Scope, device *devices.Device) error
}

// SessionStore reads and writes sessions.
type SessionStore interface {
	Create(ctx context.Context, scope business.Scope, session *auth.Session) error
	FindByToken(ctx context.Context, token auth.Token) (*auth.Session, error)
	Update(ctx context.Context, scope business.Scope, session *auth.Session) error
}

// Service performs authentication.
type Service struct {
	credentials CredentialStore
	users       UserStore
	devices     DeviceStore
	sessions    SessionStore
	clock       clock.Clock
	ids         id.Generator
	lifetime    time.Duration
	logger      *slog.Logger
	limiter     AttemptLimiter
}

// Options configures a Service. Every field has a working default.
type Options struct {
	// Clock supplies the current time. Defaults to the system clock.
	Clock clock.Clock
	// IDs generates identifiers. Defaults to UUIDv7.
	IDs id.Generator
	// SessionLifetime is how long an issued session lasts. Defaults to
	// auth.DefaultLifetime.
	SessionLifetime time.Duration
	// Logger receives notices about things that did not stop a login but that
	// someone should know about. Defaults to the standard logger.
	Logger *slog.Logger
	// Limiter throttles repeated failed logins. Defaults to an in-memory
	// limiter, because a PIN is only safe if guessing is slow (ADR-012) and a
	// service assembled without one would silently drop that protection.
	Limiter AttemptLimiter
}

// NewService returns a service using the given stores.
func NewService(
	credentials CredentialStore,
	userStore UserStore,
	deviceStore DeviceStore,
	sessions SessionStore,
	options Options,
) *Service {
	service := &Service{
		credentials: credentials,
		users:       userStore,
		devices:     deviceStore,
		sessions:    sessions,
		clock:       options.Clock,
		ids:         options.IDs,
		lifetime:    options.SessionLifetime,
		logger:      options.Logger,
		limiter:     options.Limiter,
	}
	if service.clock == nil {
		service.clock = clock.System{}
	}
	if service.ids == nil {
		service.ids = id.V7{}
	}
	if service.lifetime <= 0 {
		service.lifetime = auth.DefaultLifetime
	}
	if service.logger == nil {
		service.logger = slog.Default()
	}
	if service.limiter == nil {
		service.limiter = NewInMemoryLimiter(LimiterOptions{})
	}
	return service
}

// LoginRequest is an attempt to log in.
//
// The business is named explicitly because a phone number identifies a person
// within one business rather than globally (ADR-012). How a client comes to
// know which business it is logging into — a code the owner shares, a device
// already bound to one — is a question for onboarding, above this layer.
type LoginRequest struct {
	BusinessID business.ID
	Phone      phone.Number
	PIN        string

	// Device identifies the installation. An existing device is named by its
	// identifier; a new one is registered, which is what happens the first time
	// someone logs in on a phone or a till.
	Device DeviceRequest
}

// DeviceRequest names the installation a login is happening on.
type DeviceRequest struct {
	// ID names an installation already registered. Leave it unset to register a
	// new one, in which case Label and Platform are required.
	ID       devices.ID
	Label    string
	Platform devices.Platform
}

// LoginResult is what a successful login yields.
//
// The token is returned here and never again; only its hash is stored.
type LoginResult struct {
	Token   auth.Token
	Session *auth.Session
	User    *users.User
	Device  *devices.Device
}

// Login authenticates a phone number and PIN and issues a session.
//
// The sequence is deliberate. A missing credential still costs a PIN
// verification, so an unknown number and a wrong PIN take the same time and
// return the same error. Only once the PIN is right does the answer start
// depending on the account.
func (s *Service) Login(ctx context.Context, request LoginRequest) (LoginResult, error) {
	scope, err := s.validate(request)
	if err != nil {
		return LoginResult{}, err
	}
	now := s.clock.Now()

	// Throttling comes first, before any work is done, so a locked-out caller
	// cannot keep the server hashing on their behalf.
	key := attemptKey(request)
	if retryAfter, allowed := s.limiter.Allow(key, now); !allowed {
		return LoginResult{}, retryAfterError{after: retryAfter}
	}

	credential, err := s.credentials.FindByPhone(ctx, scope, request.Phone)
	if err != nil {
		// Anything at all — not found, or the database being unreachable — is
		// answered the same way, after spending the same time. Only a genuine
		// fault is worth distinguishing, and it is not worth distinguishing to
		// the caller.
		auth.VerifyDecoy(request.PIN)
		s.limiter.RecordFailure(key, now)
		return LoginResult{}, ErrInvalidCredentials
	}
	if !credential.Verify(request.PIN) {
		s.limiter.RecordFailure(key, now)
		return LoginResult{}, ErrInvalidCredentials
	}

	// The PIN was right, so this is no longer a guessing attempt whatever
	// happens next. Clearing here rather than at the end means someone whose
	// account is suspended, or whose device is refused, is not also locked out
	// and left unable to log in once that is sorted.
	s.limiter.RecordSuccess(key)

	user, err := s.users.Get(ctx, scope, credential.UserID())
	if err != nil {
		return LoginResult{}, fmt.Errorf("authn: loading the user behind a valid credential: %w", err)
	}
	if !user.IsActive() {
		return LoginResult{}, ErrAccountSuspended
	}

	device, err := s.resolveDevice(ctx, scope, request.Device, now)
	if err != nil {
		return LoginResult{}, err
	}

	sessionID := auth.SessionIDFrom(s.mustGenerate())
	session, token, err := auth.Issue(sessionID, user.ID(), scope.Business(), device.ID(), now, s.lifetime)
	if err != nil {
		return LoginResult{}, fmt.Errorf("authn: issuing the session: %w", err)
	}
	if err := s.sessions.Create(ctx, scope, session); err != nil {
		return LoginResult{}, fmt.Errorf("authn: storing the session: %w", err)
	}

	s.upgradeStoredHash(ctx, scope, credential, request.PIN, now)

	return LoginResult{Token: token, Session: session, User: user, Device: device}, nil
}

// Authenticate resolves a token to the session, user, and device behind it.
//
// This is what an authenticated request runs. It is given no scope: a request
// carries only a token, so the tenant is what this discovers. Everything the
// caller then does is bounded by the returned user's scope.
func (s *Service) Authenticate(ctx context.Context, token auth.Token) (LoginResult, error) {
	if token.IsZero() {
		return LoginResult{}, ErrUnauthenticated
	}
	now := s.clock.Now()

	session, err := s.sessions.FindByToken(ctx, token)
	if err != nil {
		return LoginResult{}, ErrUnauthenticated
	}
	if err := session.Authenticate(token, now); err != nil {
		// Expired and revoked are both simply "not authenticated" to the
		// caller; the distinction is in the session and in the logs.
		return LoginResult{}, fmt.Errorf("%w: %w", ErrUnauthenticated, err)
	}

	// A session cannot exist without a business — both Issue and RestoreSession
	// refuse one — so the total form is right here. If it ever were unset, the
	// resulting scope permits nothing and every store call below refuses it,
	// which fails closed.
	scope := business.ScopeOf(session.BusinessID(), business.BranchID{})

	user, err := s.users.Get(ctx, scope, session.UserID())
	if err != nil {
		return LoginResult{}, fmt.Errorf("authn: loading the session's user: %w", err)
	}
	// A user suspended since the session was issued must not keep working. The
	// session is not revoked here: that is a decision for whoever suspended
	// them, and doing it on a read would hide who ended it.
	if !user.IsActive() {
		return LoginResult{}, ErrAccountSuspended
	}

	device, err := s.devices.Get(ctx, scope, session.DeviceID())
	if err != nil {
		return LoginResult{}, fmt.Errorf("authn: loading the session's device: %w", err)
	}
	if !device.IsActive() {
		return LoginResult{}, ErrDeviceSuspended
	}

	return LoginResult{Session: session, User: user, Device: device}, nil
}

// Logout revokes a session. It is idempotent: logging out twice is not an
// error, because a client retrying a request it could not confirm should not be
// told it failed.
func (s *Service) Logout(ctx context.Context, token auth.Token) error {
	if token.IsZero() {
		return ErrUnauthenticated
	}

	session, err := s.sessions.FindByToken(ctx, token)
	if err != nil {
		return ErrUnauthenticated
	}
	scope := business.ScopeOf(session.BusinessID(), business.BranchID{})

	if err := session.Revoke(s.clock.Now()); err != nil {
		return fmt.Errorf("authn: revoking the session: %w", err)
	}
	if err := s.sessions.Update(ctx, scope, session); err != nil {
		return fmt.Errorf("authn: storing the revocation: %w", err)
	}
	return nil
}

func (s *Service) validate(request LoginRequest) (business.Scope, error) {
	if request.BusinessID.IsZero() {
		return business.Scope{}, fmt.Errorf("%w: no business given", ErrInvalidRequest)
	}
	if request.Phone.IsZero() {
		return business.Scope{}, fmt.Errorf("%w: no phone number given", ErrInvalidRequest)
	}
	if request.PIN == "" {
		return business.Scope{}, fmt.Errorf("%w: no PIN given", ErrInvalidRequest)
	}
	if request.Device.ID.IsZero() && request.Device.Label == "" {
		return business.Scope{}, fmt.Errorf("%w: no device given", ErrInvalidRequest)
	}

	scope, err := business.NewScope(request.BusinessID)
	if err != nil {
		return business.Scope{}, fmt.Errorf("%w: %w", ErrInvalidRequest, err)
	}
	return scope, nil
}

// resolveDevice finds the installation the login is happening on, registering
// it if this is its first time.
func (s *Service) resolveDevice(
	ctx context.Context, scope business.Scope, request DeviceRequest, now time.Time,
) (*devices.Device, error) {
	if request.ID.IsZero() {
		device, err := devices.Register(
			devices.IDFrom(s.mustGenerate()), scope.Business(), request.Label, request.Platform, now,
		)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInvalidRequest, err)
		}
		if err := s.devices.Create(ctx, scope, device); err != nil {
			return nil, fmt.Errorf("authn: registering the device: %w", err)
		}
		return device, nil
	}

	device, err := s.devices.Get(ctx, scope, request.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: unknown device: %w", ErrInvalidRequest, err)
	}
	if !device.IsActive() {
		return nil, ErrDeviceSuspended
	}

	// Contact is recorded even though nothing else about the device changed.
	if err := device.Seen(now); err != nil {
		return nil, fmt.Errorf("authn: recording device contact: %w", err)
	}
	if err := s.devices.Update(ctx, scope, device); err != nil {
		return nil, fmt.Errorf("authn: storing device contact: %w", err)
	}
	return device, nil
}

// upgradeStoredHash re-hashes a credential whose stored form was made at a
// weaker work factor.
//
// A login is the only moment the plaintext PIN is available, so it is the only
// chance to do this. A failure here is reported but does not fail the login:
// refusing someone with the right PIN because an optimisation did not work
// would be a worse outcome than leaving the hash as it was.
func (s *Service) upgradeStoredHash(
	ctx context.Context, scope business.Scope, credential *auth.Credential, pin string, now time.Time,
) {
	if !credential.NeedsRehash() {
		return
	}

	if err := credential.Rehash(pin, now); err != nil {
		s.logger.WarnContext(ctx, "could not rehash a PIN at login",
			"user", credential.UserID().String(), "error", err)
		return
	}
	if err := s.credentials.Update(ctx, scope, credential); err != nil {
		s.logger.WarnContext(ctx, "could not store a rehashed PIN",
			"user", credential.UserID().String(), "error", err)
	}
}

// mustGenerate draws an identifier, falling back to the package generator if
// the injected one fails.
//
// The only way the generator fails is a broken entropy source, which id.New
// treats as fatal. Doing the same here keeps a login from producing a session
// with a predictable identifier.
func (s *Service) mustGenerate() id.ID {
	generated, err := s.ids.New()
	if err != nil {
		panic(fmt.Errorf("authn: generating an identifier: %w", err))
	}
	return generated
}
