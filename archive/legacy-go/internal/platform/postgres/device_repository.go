package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/domain/devices"
)

// DeviceRepository stores the installations belonging to a business.
type DeviceRepository struct {
	pool *pgxpool.Pool
}

// NewDeviceRepository returns a repository backed by the given pool.
func NewDeviceRepository(pool *pgxpool.Pool) *DeviceRepository {
	return &DeviceRepository{pool: pool}
}

const deviceColumns = `id, business_id, branch_id, label, platform, active, created_at, updated_at, last_seen_at`

// Create registers a device within the scope's business.
func (r *DeviceRepository) Create(ctx context.Context, scope business.Scope, record *devices.Device) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
		return err
	}

	_, err := r.pool.Exec(ctx, `
		INSERT INTO devices (`+deviceColumns+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		snapshot.Label, string(snapshot.Platform), snapshot.Active,
		snapshot.CreatedAt, snapshot.UpdatedAt, snapshot.LastSeenAt)
	if err != nil {
		return wrapWrite("registering device", err)
	}
	return nil
}

// Get returns a device within the scope.
func (r *DeviceRepository) Get(
	ctx context.Context, scope business.Scope, deviceID devices.ID,
) (*devices.Device, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}
	if deviceID.IsZero() {
		return nil, fmt.Errorf("%w: no device identifier given", ErrNotFound)
	}

	row := r.pool.QueryRow(ctx, `
		SELECT `+deviceColumns+`
		FROM devices
		WHERE id = $1 AND business_id = $2`,
		deviceID.ID(), scope.Business().ID())

	return scanDevice(row)
}

// List returns the devices of the scope's business, ordered by label.
//
// A branch-scoped caller sees the devices stationed there plus those that roam
// the whole business, matching how users are listed.
func (r *DeviceRepository) List(ctx context.Context, scope business.Scope) ([]*devices.Device, error) {
	if err := requireScope(scope); err != nil {
		return nil, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT `+deviceColumns+`
		FROM devices
		WHERE business_id = $1
		  AND ($2::uuid IS NULL OR branch_id IS NULL OR branch_id = $2)
		ORDER BY label, id`,
		scope.Business().ID(), optionalScopeBranch(scope))
	if err != nil {
		return nil, fmt.Errorf("%w: listing devices: %w", ErrQuery, err)
	}
	defer rows.Close()

	found := make([]*devices.Device, 0)
	for rows.Next() {
		record, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		found = append(found, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: listing devices: %w", ErrQuery, err)
	}
	return found, nil
}

// Update writes a device's current state, within the scope.
func (r *DeviceRepository) Update(ctx context.Context, scope business.Scope, record *devices.Device) error {
	if err := requireScope(scope); err != nil {
		return err
	}
	snapshot := record.Snapshot()
	if err := scope.Guard(snapshot.BusinessID, snapshot.BranchID); err != nil {
		return err
	}

	tag, err := r.pool.Exec(ctx, `
		UPDATE devices
		SET branch_id = $3, label = $4, platform = $5, active = $6,
		    updated_at = $7, last_seen_at = $8
		WHERE id = $1 AND business_id = $2`,
		snapshot.ID.ID(), snapshot.BusinessID.ID(), optionalBranch(snapshot.BranchID),
		snapshot.Label, string(snapshot.Platform), snapshot.Active,
		snapshot.UpdatedAt, snapshot.LastSeenAt)
	if err != nil {
		return wrapWrite("updating device", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: device %s", ErrNotFound, snapshot.ID)
	}
	return nil
}

func scanDevice(row pgx.Row) (*devices.Device, error) {
	var (
		snapshot        devices.Snapshot
		rawID, rawOwner uuid.UUID
		rawBranch       *uuid.UUID
		platform        string
	)
	err := row.Scan(&rawID, &rawOwner, &rawBranch, &snapshot.Label, &platform,
		&snapshot.Active, &snapshot.CreatedAt, &snapshot.UpdatedAt, &snapshot.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: reading device: %w", ErrQuery, err)
	}

	snapshot.ID = devices.IDFrom(rawID)
	snapshot.BusinessID = business.IDFrom(rawOwner)
	if rawBranch != nil {
		snapshot.BranchID = business.BranchIDFrom(*rawBranch)
	}
	snapshot.Platform = devices.Platform(platform)

	return devices.Restore(snapshot)
}
