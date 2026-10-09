package authn_test

import (
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/app/authn"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/kernel/clock"
	"github.com/vanillaiice/kolo/backend/internal/kernel/id"
)

// The paths here are the awkward ones: a store that fails partway through, a
// record that is valid on its own but wrong for the operation, an identifier
// generator that cannot generate. They matter because a login half-completing
// is worse than one that fails cleanly.

func TestLoginReportsAFailureLoadingTheUserBehindAValidCredential(t *testing.T) {
	f := newFixture(t)
	f.users.failGet = true

	_, err := f.service.Login(f.ctx, f.request())
	if err == nil {
		t.Fatal("Login succeeded although the user could not be loaded")
	}
	// The PIN was right, so this is a server fault and is not disguised as a
	// credential problem.
	if errors.Is(err, authn.ErrInvalidCredentials) {
		t.Error("a store failure was reported as bad credentials")
	}
}

func TestLoginReportsAFailureRegisteringANewDevice(t *testing.T) {
	f := newFixture(t)
	f.devices.failCreate = true

	request := f.request()
	request.Device = authn.DeviceRequest{Label: "New phone", Platform: devices.PlatformAndroid}

	if _, err := f.service.Login(f.ctx, request); err == nil {
		t.Error("Login succeeded although the device could not be registered")
	}
}

// TestLoginReportsAFailureRecordingDeviceContact covers the update that happens
// on every login with a known device.
func TestLoginReportsAFailureRecordingDeviceContact(t *testing.T) {
	f := newFixture(t)
	f.devices.failUpdate = true

	if _, err := f.service.Login(f.ctx, f.request()); err == nil {
		t.Error("Login succeeded although device contact could not be recorded")
	}
}

// TestAuthenticateReportsAFailureLoadingTheDevice covers the last store call in
// the authentication path.
func TestAuthenticateReportsAFailureLoadingTheDevice(t *testing.T) {
	f := newFixture(t)

	login, err := f.service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	// Remove the device from the store, as a deletion or a partial restore
	// would.
	f.devices.mu.Lock()
	delete(f.devices.byID, f.device.ID())
	f.devices.mu.Unlock()

	if _, err := f.service.Authenticate(f.ctx, login.Token); err == nil {
		t.Error("Authenticate succeeded although the device could not be loaded")
	}
}

// TestLoginPanicsIfIdentifiersCannotBeGenerated pins the documented behaviour:
// continuing without randomness would mint a session with a predictable
// identifier, which is worse than stopping.
func TestLoginPanicsIfIdentifiersCannotBeGenerated(t *testing.T) {
	f := newFixture(t)

	service := authn.NewService(f.businesses, f.credentials, f.users, f.devices, f.sessions, authn.Options{
		Clock:  clock.NewFixed(loginAt),
		IDs:    brokenGenerator{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	defer func() {
		if recover() == nil {
			t.Error("Login did not panic with a broken identifier generator")
		}
	}()
	_, _ = service.Login(f.ctx, f.request())
}

// TestRegisteringADevicePanicsIfIdentifiersCannotBeGenerated covers the same
// guard on the other path that draws an identifier.
func TestRegisteringADevicePanicsIfIdentifiersCannotBeGenerated(t *testing.T) {
	f := newFixture(t)

	service := authn.NewService(f.businesses, f.credentials, f.users, f.devices, f.sessions, authn.Options{
		Clock:  clock.NewFixed(loginAt),
		IDs:    brokenGenerator{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	request := f.request()
	request.Device = authn.DeviceRequest{Label: "New phone", Platform: devices.PlatformAndroid}

	defer func() {
		if recover() == nil {
			t.Error("registering a device did not panic with a broken generator")
		}
	}()
	_, _ = service.Login(f.ctx, request)
}

// TestASessionLifetimeCanBeShortened checks the option is honoured, which is
// how a deployment with different risk tolerance would configure it.
func TestASessionLifetimeCanBeShortened(t *testing.T) {
	f := newFixture(t)

	const short = 2 * time.Hour
	service := authn.NewService(f.businesses, f.credentials, f.users, f.devices, f.sessions, authn.Options{
		Clock:           f.clock,
		SessionLifetime: short,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	result, err := service.Login(f.ctx, f.request())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if got := result.Session.ExpiresAt().Sub(result.Session.IssuedAt()); got != short {
		t.Errorf("session lifetime = %s, want %s", got, short)
	}
}

type brokenGenerator struct{}

func (brokenGenerator) New() (id.ID, error) {
	return id.Nil, errors.New("no entropy")
}
