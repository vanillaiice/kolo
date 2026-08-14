package devices_test

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
)

var registeredAt = time.Date(2026, 8, 14, 9, 30, 0, 0, time.UTC)

func newTestDevice(t *testing.T) (*devices.Device, business.ID) {
	t.Helper()
	tenant := business.NewID()
	device, err := devices.Register(devices.NewID(), tenant, "Till 1", devices.PlatformAndroid, registeredAt)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return device, tenant
}

func TestRegister(t *testing.T) {
	deviceID, tenant := devices.NewID(), business.NewID()

	device, err := devices.Register(deviceID, tenant, "  Till 1  ", devices.PlatformAndroid, registeredAt)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	if got := device.ID(); got != deviceID {
		t.Errorf("ID() = %s, want %s", got, deviceID)
	}
	if got := device.BusinessID(); got != tenant {
		t.Errorf("BusinessID() = %s, want %s", got, tenant)
	}
	if got := device.Label(); got != "Till 1" {
		t.Errorf("Label() = %q, want it trimmed", got)
	}
	if got := device.Platform(); got != devices.PlatformAndroid {
		t.Errorf("Platform() = %s, want ANDROID", got)
	}
	if !device.IsActive() {
		t.Error("a newly registered device is not active")
	}
	if _, stationed := device.BranchID(); stationed {
		t.Error("a newly registered device is stationed at a branch")
	}
	for name, moment := range map[string]time.Time{
		"CreatedAt":  device.CreatedAt(),
		"UpdatedAt":  device.UpdatedAt(),
		"LastSeenAt": device.LastSeenAt(),
	} {
		if !moment.Equal(registeredAt) {
			t.Errorf("%s = %s, want %s", name, moment, registeredAt)
		}
	}
}

func TestRegisterRejectsInvalidInput(t *testing.T) {
	deviceID, tenant := devices.NewID(), business.NewID()

	tests := []struct {
		name     string
		deviceID devices.ID
		tenant   business.ID
		label    string
		platform devices.Platform
		now      time.Time
		want     error
	}{
		{"zero device", devices.ID{}, tenant, "Till 1", devices.PlatformAndroid, registeredAt, devices.ErrInvalidID},
		{"zero business", deviceID, business.ID{}, "Till 1", devices.PlatformAndroid, registeredAt, devices.ErrInvalidID},
		{"empty label", deviceID, tenant, "", devices.PlatformAndroid, registeredAt, devices.ErrInvalidName},
		{"whitespace label", deviceID, tenant, "   ", devices.PlatformAndroid, registeredAt, devices.ErrInvalidName},
		{"invisible in label", deviceID, tenant, "Till​1", devices.PlatformAndroid, registeredAt, devices.ErrInvalidName},
		{"overlong label", deviceID, tenant, strings.Repeat("a", 121), devices.PlatformAndroid, registeredAt, devices.ErrInvalidName},
		{"unknown platform", deviceID, tenant, "Till 1", "SYMBIAN", registeredAt, devices.ErrInvalidPlatform},
		{"empty platform", deviceID, tenant, "Till 1", "", registeredAt, devices.ErrInvalidPlatform},
		{"lower-case platform", deviceID, tenant, "Till 1", "android", registeredAt, devices.ErrInvalidPlatform},
		{"zero timestamp", deviceID, tenant, "Till 1", devices.PlatformAndroid, time.Time{}, devices.ErrInvalidTime},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			device, err := devices.Register(tc.deviceID, tc.tenant, tc.label, tc.platform, tc.now)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if device != nil {
				t.Error("returned a device alongside an error")
			}
		})
	}
}

func TestPlatforms(t *testing.T) {
	known := devices.Platforms()
	want := []devices.Platform{
		devices.PlatformAndroid, devices.PlatformIOS,
		devices.PlatformWeb, devices.PlatformDesktop,
	}
	if !slices.Equal(known, want) {
		t.Errorf("Platforms() = %v, want %v", known, want)
	}

	for _, platform := range known {
		parsed, err := devices.ParsePlatform(string(platform))
		if err != nil {
			t.Errorf("ParsePlatform(%q): %v", platform, err)
		}
		if parsed != platform {
			t.Errorf("round trip of %s gave %s", platform, parsed)
		}
		if got := platform.String(); got != string(platform) {
			t.Errorf("String() = %q, want %q", got, platform)
		}
	}

	for _, input := range []string{"", "android", "SYMBIAN", " ANDROID"} {
		if _, err := devices.ParsePlatform(input); !errors.Is(err, devices.ErrInvalidPlatform) {
			t.Errorf("ParsePlatform(%q): got %v, want ErrInvalidPlatform", input, err)
		}
	}
}

func TestPlatformsReturnsACopy(t *testing.T) {
	original := devices.Platforms()

	mutated := devices.Platforms()
	slices.Reverse(mutated)
	mutated[0] = "tampered"

	if !slices.Equal(devices.Platforms(), original) {
		t.Error("mutating the result of Platforms changed the registry")
	}
}

func TestDeviceScope(t *testing.T) {
	device, tenant := newTestDevice(t)

	scope := device.Scope()
	if got := scope.Business(); got != tenant {
		t.Errorf("Business() = %s, want %s", got, tenant)
	}
	if scope.IsBranchScoped() {
		t.Error("an unstationed device produced a branch-scoped scope")
	}
	if scope.Permits(business.NewID(), business.BranchID{}) {
		t.Error("the device's scope permitted another tenant")
	}

	branch := business.NewBranchID()
	if err := device.StationAt(branch, registeredAt.Add(time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	if got, stationed := device.BranchID(); !stationed || got != branch {
		t.Errorf("BranchID() = %s, %v; want %s, true", got, stationed, branch)
	}
	if !device.Scope().IsBranchScoped() {
		t.Error("a stationed device produced a business-wide scope")
	}
}

func TestStationAndUnstation(t *testing.T) {
	device, _ := newTestDevice(t)
	branch := business.NewBranchID()
	stationedAt := registeredAt.Add(time.Hour)

	if err := device.StationAt(branch, stationedAt); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	if !device.UpdatedAt().Equal(stationedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", device.UpdatedAt(), stationedAt)
	}

	// Stationing at the same branch is not a change.
	if err := device.StationAt(branch, stationedAt.Add(time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	if !device.UpdatedAt().Equal(stationedAt) {
		t.Errorf("a repeated StationAt moved UpdatedAt to %s", device.UpdatedAt())
	}

	unstationedAt := stationedAt.Add(2 * time.Hour)
	if err := device.Unstation(unstationedAt); err != nil {
		t.Fatalf("Unstation: %v", err)
	}
	if _, stationed := device.BranchID(); stationed {
		t.Error("still stationed after Unstation")
	}
	if err := device.Unstation(unstationedAt.Add(time.Hour)); err != nil {
		t.Fatalf("Unstation: %v", err)
	}
	if !device.UpdatedAt().Equal(unstationedAt) {
		t.Errorf("a repeated Unstation moved UpdatedAt to %s", device.UpdatedAt())
	}

	if err := device.StationAt(business.BranchID{}, registeredAt); !errors.Is(err, devices.ErrInvalidID) {
		t.Errorf("got %v, want ErrInvalidID", err)
	}
	if err := device.StationAt(branch, time.Time{}); !errors.Is(err, devices.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := device.Unstation(time.Time{}); !errors.Is(err, devices.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestRename(t *testing.T) {
	device, _ := newTestDevice(t)
	renamedAt := registeredAt.Add(time.Hour)

	if err := device.Rename("  Till 2  ", renamedAt); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if got := device.Label(); got != "Till 2" {
		t.Errorf("Label() = %q", got)
	}
	if !device.UpdatedAt().Equal(renamedAt) {
		t.Errorf("UpdatedAt() = %s, want %s", device.UpdatedAt(), renamedAt)
	}

	if err := device.Rename("", renamedAt); !errors.Is(err, devices.ErrInvalidName) {
		t.Errorf("got %v, want ErrInvalidName", err)
	}
	if err := device.Rename("Valid", time.Time{}); !errors.Is(err, devices.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if got := device.Label(); got != "Till 2" {
		t.Errorf("a failed rename changed the label to %q", got)
	}
}

// TestSeenDoesNotCountAsAnEdit keeps ordinary contact from looking like a
// change to the record in an audit.
func TestSeenDoesNotCountAsAnEdit(t *testing.T) {
	device, _ := newTestDevice(t)
	contactAt := registeredAt.Add(6 * time.Hour)

	if err := device.Seen(contactAt); err != nil {
		t.Fatalf("Seen: %v", err)
	}

	if !device.LastSeenAt().Equal(contactAt) {
		t.Errorf("LastSeenAt() = %s, want %s", device.LastSeenAt(), contactAt)
	}
	if !device.UpdatedAt().Equal(registeredAt) {
		t.Errorf("being seen moved UpdatedAt to %s, want it left at %s", device.UpdatedAt(), registeredAt)
	}
}

// TestSeenNeverMovesBackwards guards against a device whose clock runs behind
// making itself look less recently active than it is.
func TestSeenNeverMovesBackwards(t *testing.T) {
	device, _ := newTestDevice(t)

	later := registeredAt.Add(5 * time.Hour)
	if err := device.Seen(later); err != nil {
		t.Fatalf("Seen: %v", err)
	}
	if err := device.Seen(registeredAt.Add(time.Hour)); err != nil {
		t.Fatalf("Seen: %v", err)
	}

	if !device.LastSeenAt().Equal(later) {
		t.Errorf("LastSeenAt() moved back to %s, want it left at %s", device.LastSeenAt(), later)
	}

	if err := device.Seen(time.Time{}); !errors.Is(err, devices.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestDeactivateAndActivate(t *testing.T) {
	device, _ := newTestDevice(t)
	lostAt := registeredAt.Add(24 * time.Hour)

	if err := device.Deactivate(lostAt); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if device.IsActive() {
		t.Error("still active after Deactivate")
	}
	if err := device.Deactivate(lostAt.Add(time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if !device.UpdatedAt().Equal(lostAt) {
		t.Errorf("a repeated Deactivate moved UpdatedAt to %s", device.UpdatedAt())
	}

	recoveredAt := lostAt.Add(48 * time.Hour)
	if err := device.Activate(recoveredAt); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if !device.IsActive() {
		t.Error("not active after Activate")
	}
	if !device.UpdatedAt().Equal(recoveredAt) {
		t.Errorf("UpdatedAt() = %s, want %s", device.UpdatedAt(), recoveredAt)
	}

	if err := device.Deactivate(time.Time{}); !errors.Is(err, devices.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
	if err := device.Activate(time.Time{}); !errors.Is(err, devices.ErrInvalidTime) {
		t.Errorf("got %v, want ErrInvalidTime", err)
	}
}

func TestRegisterNormalisesTheTimestampToUTC(t *testing.T) {
	wat := time.FixedZone("WAT", int((1 * time.Hour).Seconds()))
	local := time.Date(2026, 8, 14, 10, 30, 0, 0, wat)

	device, err := devices.Register(devices.NewID(), business.NewID(), "Till 1", devices.PlatformAndroid, local)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if got := device.CreatedAt().Location(); got != time.UTC {
		t.Errorf("CreatedAt() location = %s, want UTC", got)
	}
	if !device.CreatedAt().Equal(local) {
		t.Errorf("CreatedAt() = %s, want the same instant as %s", device.CreatedAt(), local)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	device, _ := newTestDevice(t)
	if err := device.StationAt(business.NewBranchID(), registeredAt.Add(time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	if err := device.Seen(registeredAt.Add(2 * time.Hour)); err != nil {
		t.Fatalf("Seen: %v", err)
	}
	if err := device.Deactivate(registeredAt.Add(3 * time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}

	restored, err := devices.Restore(device.Snapshot())
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Snapshot() != device.Snapshot() {
		t.Errorf("round trip gave %+v, want %+v", restored.Snapshot(), device.Snapshot())
	}
}

func TestRestoreValidatesStoredData(t *testing.T) {
	device, _ := newTestDevice(t)
	valid := device.Snapshot()

	if _, err := devices.Restore(valid); err != nil {
		t.Fatalf("Restore rejected a valid snapshot: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*devices.Snapshot)
		want   error
	}{
		{"zero device", func(s *devices.Snapshot) { s.ID = devices.ID{} }, devices.ErrInvalidID},
		{"zero business", func(s *devices.Snapshot) { s.BusinessID = business.ID{} }, devices.ErrInvalidID},
		{"empty label", func(s *devices.Snapshot) { s.Label = "  " }, devices.ErrInvalidName},
		{"unknown platform", func(s *devices.Snapshot) { s.Platform = "SYMBIAN" }, devices.ErrInvalidPlatform},
		{"zero creation", func(s *devices.Snapshot) { s.CreatedAt = time.Time{} }, devices.ErrInvalidTime},
		{"zero update", func(s *devices.Snapshot) { s.UpdatedAt = time.Time{} }, devices.ErrInvalidTime},
		{"zero last seen", func(s *devices.Snapshot) { s.LastSeenAt = time.Time{} }, devices.ErrInvalidTime},
		{
			"updated before created",
			func(s *devices.Snapshot) { s.UpdatedAt = s.CreatedAt.Add(-time.Hour) },
			devices.ErrInvalidTime,
		},
		{
			"seen before it was registered",
			func(s *devices.Snapshot) { s.LastSeenAt = s.CreatedAt.Add(-time.Hour) },
			devices.ErrInvalidTime,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := valid
			tc.mutate(&snapshot)

			restored, err := devices.Restore(snapshot)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
			if restored != nil {
				t.Error("returned a device alongside an error")
			}
		})
	}
}
