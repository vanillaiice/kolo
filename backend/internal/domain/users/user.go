package users

import (
	"errors"
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/domain/authz"
	"github.com/vanillaiice/kolo/backend/internal/domain/business"
	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Errors reported by this package.
var (
	// ErrInvalidID means an identifier is unset.
	ErrInvalidID = errors.New("users: identifier is unset")
	// ErrInvalidRole means a role is not one the system defines.
	ErrInvalidRole = errors.New("users: invalid role")
	// ErrInactive means the user's account is not in service.
	ErrInactive = errors.New("users: account is not active")
	// ErrForbidden means the user does not hold the permission required.
	ErrForbidden = errors.New("users: permission denied")

	// ErrInvalidName means a name is empty, too long, or contains characters
	// that would not be visible to the person reading it.
	ErrInvalidName = validate.ErrInvalidName
	// ErrInvalidTime means a timestamp is unset or inconsistent.
	ErrInvalidTime = validate.ErrInvalidTime
)

// User is a person who operates a business.
//
// Every user belongs to exactly one business. They may additionally be assigned
// to a branch, which narrows the data they reach; a user with no branch works
// across the whole business, which is the normal case for an owner and the only
// case while the MVP ships single-branch (§42).
//
// Permissions come from the user's role, adjusted by grants and revocations
// recorded against this user. The role is a starting point, never the authority
// — §38 requires the matrix to be configurable per business.
type User struct {
	id         ID
	businessID business.ID
	branchID   business.BranchID
	name       string
	role       authz.Role
	granted    authz.Set
	revoked    authz.Set
	active     bool
	createdAt  time.Time
	updatedAt  time.Time
}

// Snapshot is the flat representation of a User, used to persist it and to
// rebuild it from storage. It is the only way the entity's internals cross the
// package boundary, so a repository cannot construct one that skipped
// validation.
type Snapshot struct {
	ID         ID
	BusinessID business.ID
	BranchID   business.BranchID
	Name       string
	Role       authz.Role
	Granted    authz.Set
	Revoked    authz.Set
	Active     bool
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// New creates a user of a business, active from the given moment and holding
// their role's default permissions.
func New(userID ID, businessID business.ID, name string, role authz.Role, now time.Time) (*User, error) {
	if userID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if businessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validate.Name(name)
	if err != nil {
		return nil, err
	}
	if !role.Defined() {
		return nil, fmt.Errorf("%w: %q", ErrInvalidRole, role)
	}
	if err := validate.Moment(now, "creation time"); err != nil {
		return nil, err
	}

	moment := now.UTC()
	return &User{
		id:         userID,
		businessID: businessID,
		name:       cleaned,
		role:       role,
		active:     true,
		createdAt:  moment,
		updatedAt:  moment,
	}, nil
}

// Restore rebuilds a user from storage, validating it on the way in.
//
// Stored data is not trusted: a record written by an older version, or synced
// from another device, is checked against the same rules as a new one. An
// unrecognised role is rejected rather than silently granting nothing, because
// a user who mysteriously cannot do their job is harder to diagnose than a
// record that refuses to load.
func Restore(snapshot Snapshot) (*User, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: user", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validate.Name(snapshot.Name)
	if err != nil {
		return nil, err
	}
	if !snapshot.Role.Defined() {
		return nil, fmt.Errorf("%w: %q", ErrInvalidRole, snapshot.Role)
	}
	if err := validate.Timestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	return &User{
		id:         snapshot.ID,
		businessID: snapshot.BusinessID,
		branchID:   snapshot.BranchID,
		name:       cleaned,
		role:       snapshot.Role,
		granted:    snapshot.Granted,
		revoked:    snapshot.Revoked,
		active:     snapshot.Active,
		createdAt:  snapshot.CreatedAt.UTC(),
		updatedAt:  snapshot.UpdatedAt.UTC(),
	}, nil
}

// Snapshot returns the flat representation of the user.
func (u *User) Snapshot() Snapshot {
	return Snapshot{
		ID:         u.id,
		BusinessID: u.businessID,
		BranchID:   u.branchID,
		Name:       u.name,
		Role:       u.role,
		Granted:    u.granted,
		Revoked:    u.revoked,
		Active:     u.active,
		CreatedAt:  u.createdAt,
		UpdatedAt:  u.updatedAt,
	}
}

// ID returns the immutable identifier.
func (u *User) ID() ID { return u.id }

// BusinessID returns the business the user belongs to.
func (u *User) BusinessID() business.ID { return u.businessID }

// BranchID returns the branch the user is assigned to, and whether they are
// assigned to one at all.
func (u *User) BranchID() (business.BranchID, bool) {
	return u.branchID, !u.branchID.IsZero()
}

// Name returns the user's name.
func (u *User) Name() string { return u.name }

// Role returns the user's role.
func (u *User) Role() authz.Role { return u.role }

// IsActive reports whether the account is in service.
func (u *User) IsActive() bool { return u.active }

// CreatedAt returns when the user was created, in UTC.
func (u *User) CreatedAt() time.Time { return u.createdAt }

// UpdatedAt returns when the user last changed, in UTC.
func (u *User) UpdatedAt() time.Time { return u.updatedAt }

// Scope returns the tenant scope this user operates within: their branch if
// they are assigned to one, otherwise their whole business.
//
// Every repository call made on this user's behalf is bounded by this scope, so
// a user cannot reach another tenant's data even if they present an identifier
// belonging to one (ADR-008).
func (u *User) Scope() business.Scope {
	return business.ScopeOf(u.businessID, u.branchID)
}

// Permissions returns what the user may currently do.
//
// An inactive user holds nothing. Returning the empty set rather than their
// configured permissions means a caller reaching for Permissions().Has(...)
// cannot accidentally bypass the account's status. Use ConfiguredPermissions to
// show an administrator what a suspended account would regain.
func (u *User) Permissions() authz.Set {
	if !u.active {
		return authz.Set{}
	}
	return u.ConfiguredPermissions()
}

// ConfiguredPermissions returns the permissions the user's role and overrides
// resolve to, ignoring whether the account is active.
//
// This is for administration screens. Authorization decisions use Permissions
// or Can.
func (u *User) ConfiguredPermissions() authz.Set {
	// The role is validated on construction and on every change, so the total
	// form is the right one here: there is no bad-role case left to report.
	return authz.Effective(u.role, u.granted, u.revoked)
}

// Overrides returns the permissions granted to and revoked from this user on
// top of their role.
func (u *User) Overrides() (granted, revoked authz.Set) {
	return u.granted, u.revoked
}

// Can reports whether the user may perform an operation.
func (u *User) Can(permission authz.Permission) bool {
	return u.Permissions().Has(permission)
}

// Authorize returns nil if the user may perform an operation, and otherwise an
// error explaining which of the two reasons applies.
//
// Services call this rather than Can when the distinction matters to the
// person: "your account is suspended" and "you are not allowed to do this" call
// for different responses.
func (u *User) Authorize(permission authz.Permission) error {
	if !u.active {
		return fmt.Errorf("%w: %s", ErrInactive, u.id)
	}
	if !u.ConfiguredPermissions().Has(permission) {
		return fmt.Errorf("%w: %s lacks %s", ErrForbidden, u.id, permission)
	}
	return nil
}

// Rename changes the user's name.
func (u *User) Rename(name string, at time.Time) error {
	cleaned, err := validate.Name(name)
	if err != nil {
		return err
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}

	u.name = cleaned
	u.updatedAt = at.UTC()
	return nil
}

// ChangeRole moves the user to a different role, keeping their overrides.
//
// Overrides survive deliberately: a cashier authorised to refund who is
// promoted to manager should not quietly lose that authorisation, and a
// revocation applied for a reason still applies. ResetPermissions clears them.
func (u *User) ChangeRole(role authz.Role, at time.Time) error {
	if !role.Defined() {
		return fmt.Errorf("%w: %q", ErrInvalidRole, role)
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if u.role == role {
		return nil
	}

	u.role = role
	u.updatedAt = at.UTC()
	return nil
}

// Grant gives the user permissions beyond their role.
//
// Granting a permission also lifts any revocation of it, so that granting is
// never silently defeated by an earlier revocation.
func (u *User) Grant(at time.Time, permissions ...authz.Permission) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if len(permissions) == 0 {
		return nil
	}

	granted, err := u.granted.With(permissions...)
	if err != nil {
		return err
	}
	revoked := u.revoked.Without(permissions...)

	if granted.Equal(u.granted) && revoked.Equal(u.revoked) {
		return nil
	}
	u.granted, u.revoked = granted, revoked
	u.updatedAt = at.UTC()
	return nil
}

// Revoke withholds permissions from the user, including ones their role would
// otherwise grant.
//
// Revoking a permission also withdraws any grant of it, so the two overrides
// stay mutually exclusive and the resulting state is unambiguous.
func (u *User) Revoke(at time.Time, permissions ...authz.Permission) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if len(permissions) == 0 {
		return nil
	}

	revoked, err := u.revoked.With(permissions...)
	if err != nil {
		return err
	}
	granted := u.granted.Without(permissions...)

	if revoked.Equal(u.revoked) && granted.Equal(u.granted) {
		return nil
	}
	u.granted, u.revoked = granted, revoked
	u.updatedAt = at.UTC()
	return nil
}

// ResetPermissions discards every override, returning the user to their role's
// defaults. It is idempotent.
func (u *User) ResetPermissions(at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if u.granted.IsEmpty() && u.revoked.IsEmpty() {
		return nil
	}

	u.granted, u.revoked = authz.Set{}, authz.Set{}
	u.updatedAt = at.UTC()
	return nil
}

// AssignToBranch confines the user to a branch.
func (u *User) AssignToBranch(branchID business.BranchID, at time.Time) error {
	if branchID.IsZero() {
		return fmt.Errorf("%w: branch", ErrInvalidID)
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if u.branchID == branchID {
		return nil
	}

	u.branchID = branchID
	u.updatedAt = at.UTC()
	return nil
}

// UnassignBranch widens the user back to the whole business. It is idempotent.
func (u *User) UnassignBranch(at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if u.branchID.IsZero() {
		return nil
	}

	u.branchID = business.BranchID{}
	u.updatedAt = at.UTC()
	return nil
}

// Deactivate suspends the account. It is idempotent.
//
// Suspension is not deletion: the sales, movements, and audit records the user
// created remain attributed to them (§39, §40).
func (u *User) Deactivate(at time.Time) error {
	return u.setActive(false, at)
}

// Activate returns the account to service. It is idempotent.
func (u *User) Activate(at time.Time) error {
	return u.setActive(true, at)
}

func (u *User) setActive(active bool, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if u.active == active {
		return nil
	}
	u.active = active
	u.updatedAt = at.UTC()
	return nil
}
