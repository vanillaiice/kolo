package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres"
	"github.com/vanillaiice/kolo/backend/internal/platform/postgres/pgtest"
)

func newDeviceRepository(t *testing.T) (*postgres.DeviceRepository, *postgres.BusinessRepository, context.Context) {
	t.Helper()
	pool := pgtest.Pool(t)
	return postgres.NewDeviceRepository(pool), postgres.NewBusinessRepository(pool), context.Background()
}

func newDevice(t *testing.T, tenant business.ID, label string) *devices.Device {
	t.Helper()
	device, err := devices.Register(devices.NewID(), tenant, label, devices.PlatformAndroid, createdAt)
	if err != nil {
		t.Fatalf("devices.Register: %v", err)
	}
	return device
}

func TestCreateAndGetDevice(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	created := newDevice(t, tenant.ID(), "Till 1")
	if err := repo.Create(ctx, scope, created); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, created.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.Snapshot() != created.Snapshot() {
		t.Errorf("loaded %+v, want %+v", loaded.Snapshot(), created.Snapshot())
	}
}

// TestLastSeenIsStoredSeparatelyFromUpdatedAt checks the distinction the schema
// keeps: contact is not an edit.
func TestLastSeenIsStoredSeparatelyFromUpdatedAt(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	device := newDevice(t, tenant.ID(), "Till 1")
	if err := repo.Create(ctx, scope, device); err != nil {
		t.Fatalf("Create: %v", err)
	}

	contactAt := createdAt.Add(6 * time.Hour)
	if err := device.Seen(contactAt); err != nil {
		t.Fatalf("Seen: %v", err)
	}
	if err := repo.Update(ctx, scope, device); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, device.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !loaded.LastSeenAt().Equal(contactAt) {
		t.Errorf("LastSeenAt() = %s, want %s", loaded.LastSeenAt(), contactAt)
	}
	if !loaded.UpdatedAt().Equal(createdAt) {
		t.Errorf("UpdatedAt() = %s, want it left at %s", loaded.UpdatedAt(), createdAt)
	}
}

func TestUpdateDevice(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	branch := newBranch(t, tenant.ID(), "Marché Central")
	if err := businesses.CreateBranch(ctx, scope, branch); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	device := newDevice(t, tenant.ID(), "Till 1")
	if err := repo.Create(ctx, scope, device); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := device.Rename("Till 2", createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := device.StationAt(branch.ID(), createdAt.Add(2*time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	if err := device.Deactivate(createdAt.Add(3 * time.Hour)); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	if err := repo.Update(ctx, scope, device); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := repo.Get(ctx, scope, device.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := loaded.Label(); got != "Till 2" {
		t.Errorf("Label() = %q", got)
	}
	if got, stationed := loaded.BranchID(); !stationed || got != branch.ID() {
		t.Errorf("BranchID() = %s, %v; want %s, true", got, stationed, branch.ID())
	}
	if loaded.IsActive() {
		t.Error("the device is still active after being deactivated")
	}

	// Unstationing must store NULL rather than a zero UUID.
	if err := device.Unstation(createdAt.Add(4 * time.Hour)); err != nil {
		t.Fatalf("Unstation: %v", err)
	}
	if err := repo.Update(ctx, scope, device); err != nil {
		t.Fatalf("Update: %v", err)
	}
	reloaded, err := repo.Get(ctx, scope, device.ID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, stationed := reloaded.BranchID(); stationed {
		t.Error("the device is still stationed after being unstationed")
	}
}

func TestListDevices(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	for _, label := range []string{"Till 3", "Till 1", "Till 2"} {
		if err := repo.Create(ctx, scope, newDevice(t, tenant.ID(), label)); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	found, err := repo.List(ctx, scope)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(found) != 3 {
		t.Fatalf("got %d devices, want 3", len(found))
	}
	for i, want := range []string{"Till 1", "Till 2", "Till 3"} {
		if got := found[i].Label(); got != want {
			t.Errorf("device %d = %q, want %q", i, got, want)
		}
	}
}

// TestListingDevicesUnderABranchScopeExcludesOtherBranches mirrors how users
// are listed: the branch's own tills plus the devices that roam.
func TestListingDevicesUnderABranchScopeExcludesOtherBranches(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	mine := newBranch(t, tenant.ID(), "Mine")
	theirs := newBranch(t, tenant.ID(), "Theirs")
	for _, branch := range []*business.Branch{mine, theirs} {
		if err := businesses.CreateBranch(ctx, scope, branch); err != nil {
			t.Fatalf("CreateBranch: %v", err)
		}
	}

	roaming := newDevice(t, tenant.ID(), "Owner phone")
	atMine := newDevice(t, tenant.ID(), "Mine till")
	atTheirs := newDevice(t, tenant.ID(), "Theirs till")
	if err := atMine.StationAt(mine.ID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	if err := atTheirs.StationAt(theirs.ID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	for _, device := range []*devices.Device{roaming, atMine, atTheirs} {
		if err := repo.Create(ctx, scope, device); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	narrowed, err := scope.WithBranch(mine.ID())
	if err != nil {
		t.Fatalf("WithBranch: %v", err)
	}
	found, err := repo.List(ctx, narrowed)
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	seen := make(map[devices.ID]bool, len(found))
	for _, device := range found {
		seen[device.ID()] = true
	}
	if !seen[atMine.ID()] {
		t.Error("the branch's own device is missing")
	}
	if !seen[roaming.ID()] {
		t.Error("the roaming device is missing")
	}
	if seen[atTheirs.ID()] {
		t.Error("another branch's device appeared")
	}
}

func TestOneTenantCannotReachAnothersDevices(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)

	tenantA, scopeA := newTenant(t, businesses, ctx)
	_, scopeB := newTenant(t, businesses, ctx)

	deviceOfA := newDevice(t, tenantA.ID(), "Till 1")
	if err := repo.Create(ctx, scopeA, deviceOfA); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := repo.Get(ctx, scopeB, deviceOfA.ID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("reading across tenants: got %v, want ErrNotFound", err)
	}

	found, err := repo.List(ctx, scopeB)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, device := range found {
		if device.ID() == deviceOfA.ID() {
			t.Error("another tenant's device appeared in the listing")
		}
	}

	if err := repo.Update(ctx, scopeB, deviceOfA); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("updating across tenants: got %v, want ErrCrossTenant", err)
	}
	planted := newDevice(t, tenantA.ID(), "Planted")
	if err := repo.Create(ctx, scopeB, planted); !errors.Is(err, business.ErrCrossTenant) {
		t.Errorf("creating across tenants: got %v, want ErrCrossTenant", err)
	}
}

func TestEveryDeviceOperationRefusesAnUnsetScope(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, _ := newTenant(t, businesses, ctx)
	device := newDevice(t, tenant.ID(), "Till 1")

	var unset business.Scope

	operations := map[string]func() error{
		"Create": func() error { return repo.Create(ctx, unset, device) },
		"Get":    func() error { _, err := repo.Get(ctx, unset, device.ID()); return err },
		"List":   func() error { _, err := repo.List(ctx, unset); return err },
		"Update": func() error { return repo.Update(ctx, unset, device) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, business.ErrNoTenant) {
				t.Errorf("got %v, want ErrNoTenant", err)
			}
		})
	}
}

func TestGetAndUpdateMissingDevice(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	if _, err := repo.Get(ctx, scope, devices.NewID()); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
	if _, err := repo.Get(ctx, scope, devices.ID{}); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("the zero identifier: got %v, want ErrNotFound", err)
	}

	absent := newDevice(t, tenant.ID(), "Never Stored")
	if err := repo.Update(ctx, scope, absent); !errors.Is(err, postgres.ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestCreateDeviceTwiceConflicts(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)
	tenant, scope := newTenant(t, businesses, ctx)

	device := newDevice(t, tenant.ID(), "Till 1")
	if err := repo.Create(ctx, scope, device); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.Create(ctx, scope, device); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict", err)
	}
}

// TestADeviceCannotBeStationedAtAnotherTenantsBranch checks the composite key
// from migration 3, which the scope guard cannot see.
func TestADeviceCannotBeStationedAtAnotherTenantsBranch(t *testing.T) {
	repo, businesses, ctx := newDeviceRepository(t)

	tenantA, scopeA := newTenant(t, businesses, ctx)
	tenantB, scopeB := newTenant(t, businesses, ctx)

	branchOfB := newBranch(t, tenantB.ID(), "Theirs")
	if err := businesses.CreateBranch(ctx, scopeB, branchOfB); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}

	intruder := newDevice(t, tenantA.ID(), "Till 1")
	if err := intruder.StationAt(branchOfB.ID(), createdAt.Add(time.Hour)); err != nil {
		t.Fatalf("StationAt: %v", err)
	}
	if err := repo.Create(ctx, scopeA, intruder); !errors.Is(err, postgres.ErrConflict) {
		t.Errorf("got %v, want ErrConflict from the composite foreign key", err)
	}
}

func TestDeviceOperationsReportAnUnavailableDatabase(t *testing.T) {
	pool := closedPool(t)
	repo := postgres.NewDeviceRepository(pool)
	ctx := context.Background()

	tenant := business.NewID()
	scope := business.MustNewScope(tenant)
	device := newDevice(t, tenant, "Till 1")

	operations := map[string]func() error{
		"Create": func() error { return repo.Create(ctx, scope, device) },
		"Get":    func() error { _, err := repo.Get(ctx, scope, device.ID()); return err },
		"List":   func() error { _, err := repo.List(ctx, scope); return err },
		"Update": func() error { return repo.Update(ctx, scope, device) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Error("succeeded against a closed pool, want an error")
			}
		})
	}

	found, err := repo.List(ctx, scope)
	if err == nil {
		t.Fatalf("List succeeded against a closed pool, returning %d devices", len(found))
	}
	if found != nil {
		t.Errorf("returned %d devices alongside an error, want none", len(found))
	}
}

// TestReadingADeviceWithAnUnknownPlatformFails covers a platform the schema
// permitted at write time but a later version no longer defines.
func TestReadingADeviceWithAnUnknownPlatformFails(t *testing.T) {
	pool := pgtest.FreshPool(t)
	repo := postgres.NewDeviceRepository(pool)
	businesses := postgres.NewBusinessRepository(pool)
	ctx := context.Background()

	tenant, scope := newTenant(t, businesses, ctx)
	device := newDevice(t, tenant.ID(), "Till 1")
	if err := repo.Create(ctx, scope, device); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := pool.Exec(ctx,
		`ALTER TABLE devices DROP CONSTRAINT devices_platform_known`); err != nil {
		t.Fatalf("dropping the constraint: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE devices SET platform = 'SYMBIAN' WHERE id = $1`, device.ID().ID()); err != nil {
		t.Fatalf("planting the unknown platform: %v", err)
	}

	if _, err := repo.Get(ctx, scope, device.ID()); !errors.Is(err, devices.ErrInvalidPlatform) {
		t.Errorf("got %v, want ErrInvalidPlatform", err)
	}
	if _, err := repo.List(ctx, scope); !errors.Is(err, devices.ErrInvalidPlatform) {
		t.Errorf("listing: got %v, want ErrInvalidPlatform", err)
	}
}
