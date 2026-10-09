package devices

import (
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Errors reported when a device would be invalid.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("devices: identifier is unset")
	// ErrInvalidPlatform means a platform is not one this system knows.
	ErrInvalidPlatform = errors.New("devices: invalid platform")

	// ErrInvalidName means a label is empty, too long, or contains characters
	// that would not be visible to the person reading it.
	ErrInvalidName = validate.ErrInvalidName
	// ErrInvalidTime means a timestamp is unset or inconsistent.
	ErrInvalidTime = validate.ErrInvalidTime
)

// Platform is the kind of installation a device is.
type Platform string

// The platforms this system runs on (SPECIFICATION.md §32, §52). Android is
// first because of the target market's hardware; the others follow later.
const (
	PlatformAndroid Platform = "ANDROID"
	PlatformIOS     Platform = "IOS"
	PlatformWeb     Platform = "WEB"
	PlatformDesktop Platform = "DESKTOP"
)

var platforms = []Platform{PlatformAndroid, PlatformIOS, PlatformWeb, PlatformDesktop}

// Platforms returns every known platform, in a stable order.
func Platforms() []Platform { return slices.Clone(platforms) }

// Defined reports whether p is a platform this system knows.
func (p Platform) Defined() bool { return slices.Contains(platforms, p) }

// String implements fmt.Stringer.
func (p Platform) String() string { return string(p) }

// ParsePlatform converts stored or transmitted text into a Platform.
func ParsePlatform(text string) (Platform, error) {
	candidate := Platform(text)
	if !candidate.Defined() {
		return "", fmt.Errorf("%w: %q", ErrInvalidPlatform, text)
	}
	return candidate, nil
}

// Device is one installation of the application.
//
// It exists so that a session can be bound to the thing holding it (ADR-012),
// so an audit record can say where an action happened (§39), and so
// synchronization can tell devices apart (§28). Its sync-specific state — when
// it last pushed, what it has seen — arrives with the sync phase; what is here
// is what authentication and audit need now.
//
// A device belongs to a business, and may belong to a branch: a till stays at
// one shop, while an owner's phone follows them across all of them.
type Device struct {
	id         ID
	businessID business.ID
	branchID   business.BranchID
	label      string
	platform   Platform
	active     bool
	createdAt  time.Time
	updatedAt  time.Time
	lastSeenAt time.Time
}

// Snapshot is the flat representation of a Device, used to persist it and to
// rebuild it from storage.
type Snapshot struct {
	ID         ID
	BusinessID business.ID
	BranchID   business.BranchID
	Label      string
	Platform   Platform
	Active     bool
	CreatedAt  time.Time
	UpdatedAt  time.Time
	LastSeenAt time.Time
}

// Register creates a device, active from the given moment.
//
// The label is what a person calls it — "Till 1", "Marie's phone" — so that a
// list of devices, or an audit entry naming one, means something to the owner
// rather than showing an identifier.
func Register(
	deviceID ID,
	businessID business.ID,
	label string,
	platform Platform,
	now time.Time,
) (*Device, error) {
	if deviceID.IsZero() {
		return nil, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if businessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validate.Name(label)
	if err != nil {
		return nil, err
	}
	if !platform.Defined() {
		return nil, fmt.Errorf("%w: %q", ErrInvalidPlatform, platform)
	}
	if err := validate.Moment(now, "registration time"); err != nil {
		return nil, err
	}

	moment := now.UTC()
	return &Device{
		id:         deviceID,
		businessID: businessID,
		label:      cleaned,
		platform:   platform,
		active:     true,
		createdAt:  moment,
		updatedAt:  moment,
		lastSeenAt: moment,
	}, nil
}

// Restore rebuilds a device from storage, validating it on the way in.
func Restore(snapshot Snapshot) (*Device, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: device", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validate.Name(snapshot.Label)
	if err != nil {
		return nil, err
	}
	if !snapshot.Platform.Defined() {
		return nil, fmt.Errorf("%w: %q", ErrInvalidPlatform, snapshot.Platform)
	}
	if err := validate.Timestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}
	if err := validate.Moment(snapshot.LastSeenAt, "last seen time"); err != nil {
		return nil, err
	}
	if snapshot.LastSeenAt.Before(snapshot.CreatedAt) {
		return nil, fmt.Errorf("%w: last seen at %s, before it was registered at %s",
			ErrInvalidTime, snapshot.LastSeenAt, snapshot.CreatedAt)
	}

	return &Device{
		id:         snapshot.ID,
		businessID: snapshot.BusinessID,
		branchID:   snapshot.BranchID,
		label:      cleaned,
		platform:   snapshot.Platform,
		active:     snapshot.Active,
		createdAt:  snapshot.CreatedAt.UTC(),
		updatedAt:  snapshot.UpdatedAt.UTC(),
		lastSeenAt: snapshot.LastSeenAt.UTC(),
	}, nil
}

// Snapshot returns the flat representation of the device.
func (d *Device) Snapshot() Snapshot {
	return Snapshot{
		ID:         d.id,
		BusinessID: d.businessID,
		BranchID:   d.branchID,
		Label:      d.label,
		Platform:   d.platform,
		Active:     d.active,
		CreatedAt:  d.createdAt,
		UpdatedAt:  d.updatedAt,
		LastSeenAt: d.lastSeenAt,
	}
}

// ID returns the immutable identifier.
func (d *Device) ID() ID { return d.id }

// BusinessID returns the business the device belongs to.
func (d *Device) BusinessID() business.ID { return d.businessID }

// BranchID returns the branch the device is stationed at, and whether it is
// stationed at one.
func (d *Device) BranchID() (business.BranchID, bool) {
	return d.branchID, !d.branchID.IsZero()
}

// Label returns the name a person gave the device.
func (d *Device) Label() string { return d.label }

// Platform returns the kind of installation.
func (d *Device) Platform() Platform { return d.platform }

// IsActive reports whether the device may still be used.
func (d *Device) IsActive() bool { return d.active }

// CreatedAt returns when the device was registered, in UTC.
func (d *Device) CreatedAt() time.Time { return d.createdAt }

// UpdatedAt returns when its record last changed, in UTC.
func (d *Device) UpdatedAt() time.Time { return d.updatedAt }

// LastSeenAt returns when the device was last heard from, in UTC.
func (d *Device) LastSeenAt() time.Time { return d.lastSeenAt }

// Scope returns the tenant scope the device operates within.
func (d *Device) Scope() business.Scope {
	return business.ScopeOf(d.businessID, d.branchID)
}

// Rename changes the label.
func (d *Device) Rename(label string, at time.Time) error {
	cleaned, err := validate.Name(label)
	if err != nil {
		return err
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}

	d.label = cleaned
	d.updatedAt = at.UTC()
	return nil
}

// StationAt fixes the device to a branch.
func (d *Device) StationAt(branchID business.BranchID, at time.Time) error {
	if branchID.IsZero() {
		return fmt.Errorf("%w: branch", ErrInvalidID)
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if d.branchID == branchID {
		return nil
	}

	d.branchID = branchID
	d.updatedAt = at.UTC()
	return nil
}

// Unstation frees the device to work across the whole business. It is
// idempotent.
func (d *Device) Unstation(at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if d.branchID.IsZero() {
		return nil
	}

	d.branchID = business.BranchID{}
	d.updatedAt = at.UTC()
	return nil
}

// Seen records that the device made contact.
//
// It never moves the time backwards. Devices report their own clocks, and one
// running behind must not make a device look less recently active than it is.
// It also leaves UpdatedAt alone: being seen is not a change to the record, and
// treating it as one would make every contact look like an edit in an audit.
func (d *Device) Seen(at time.Time) error {
	if err := validate.Moment(at, "contact time"); err != nil {
		return err
	}
	if moment := at.UTC(); moment.After(d.lastSeenAt) {
		d.lastSeenAt = moment
	}
	return nil
}

// Deactivate takes the device out of service. It is idempotent.
//
// This is how a lost or stolen device is cut off. Sessions held on it are
// revoked separately: this record says the device may not be used, and the
// sessions are what a request actually presents.
func (d *Device) Deactivate(at time.Time) error {
	return d.setActive(false, at)
}

// Activate returns the device to service. It is idempotent.
func (d *Device) Activate(at time.Time) error {
	return d.setActive(true, at)
}

func (d *Device) setActive(active bool, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if d.active == active {
		return nil
	}
	d.active = active
	d.updatedAt = at.UTC()
	return nil
}
