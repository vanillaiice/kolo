package business

import (
	"fmt"
	"time"

	"github.com/vanillaiice/kolo/backend/internal/kernel/validate"
)

// Branch is a place a business operates from: a shop, a depot, a stall.
//
// The MVP ships single-branch, so a small business simply has one. The entity
// exists from the start because devices, users, and inventory hang off it
// (SPECIFICATION.md §42), and retrofitting that relationship later would mean
// migrating every table that owns stock.
type Branch struct {
	id         BranchID
	businessID ID
	name       string
	active     bool
	createdAt  time.Time
	updatedAt  time.Time
}

// BranchSnapshot is the flat representation of a Branch, used to persist it and
// to rebuild it from storage.
type BranchSnapshot struct {
	ID         BranchID
	BusinessID ID
	Name       string
	Active     bool
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// NewBranch creates a branch of a business, active from the given moment.
func NewBranch(branchID BranchID, businessID ID, name string, now time.Time) (*Branch, error) {
	if branchID.IsZero() {
		return nil, fmt.Errorf("%w: branch", ErrInvalidID)
	}
	if businessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validateName(name)
	if err != nil {
		return nil, err
	}
	if err := validate.Moment(now, "creation time"); err != nil {
		return nil, err
	}

	moment := now.UTC()
	return &Branch{
		id:         branchID,
		businessID: businessID,
		name:       cleaned,
		active:     true,
		createdAt:  moment,
		updatedAt:  moment,
	}, nil
}

// RestoreBranch rebuilds a branch from storage, validating it on the way in.
func RestoreBranch(snapshot BranchSnapshot) (*Branch, error) {
	if snapshot.ID.IsZero() {
		return nil, fmt.Errorf("%w: branch", ErrInvalidID)
	}
	if snapshot.BusinessID.IsZero() {
		return nil, fmt.Errorf("%w: business", ErrInvalidID)
	}
	cleaned, err := validateName(snapshot.Name)
	if err != nil {
		return nil, err
	}
	if err := validateTimestamps(snapshot.CreatedAt, snapshot.UpdatedAt); err != nil {
		return nil, err
	}

	return &Branch{
		id:         snapshot.ID,
		businessID: snapshot.BusinessID,
		name:       cleaned,
		active:     snapshot.Active,
		createdAt:  snapshot.CreatedAt.UTC(),
		updatedAt:  snapshot.UpdatedAt.UTC(),
	}, nil
}

// Snapshot returns the flat representation of the branch.
func (b *Branch) Snapshot() BranchSnapshot {
	return BranchSnapshot{
		ID:         b.id,
		BusinessID: b.businessID,
		Name:       b.name,
		Active:     b.active,
		CreatedAt:  b.createdAt,
		UpdatedAt:  b.updatedAt,
	}
}

// ID returns the immutable identifier.
func (b *Branch) ID() BranchID { return b.id }

// BusinessID returns the business the branch belongs to.
func (b *Branch) BusinessID() ID { return b.businessID }

// Name returns the branch name.
func (b *Branch) Name() string { return b.name }

// IsActive reports whether the branch is in service.
func (b *Branch) IsActive() bool { return b.active }

// CreatedAt returns when the branch was created, in UTC.
func (b *Branch) CreatedAt() time.Time { return b.createdAt }

// UpdatedAt returns when the branch last changed, in UTC.
func (b *Branch) UpdatedAt() time.Time { return b.updatedAt }

// Scope returns a scope narrowed to this branch, which is what operations over
// its stock and devices need.
func (b *Branch) Scope() Scope {
	return Scope{business: b.businessID, branch: b.id}
}

// Rename changes the branch name.
func (b *Branch) Rename(name string, at time.Time) error {
	cleaned, err := validateName(name)
	if err != nil {
		return err
	}
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}

	b.name = cleaned
	b.updatedAt = at.UTC()
	return nil
}

// Deactivate closes the branch. It is idempotent.
//
// Closing a branch does not remove its history: the sales, movements, and
// balances recorded there remain (§40, ADR-007).
func (b *Branch) Deactivate(at time.Time) error {
	return b.setActive(false, at)
}

// Activate reopens the branch. It is idempotent.
func (b *Branch) Activate(at time.Time) error {
	return b.setActive(true, at)
}

func (b *Branch) setActive(active bool, at time.Time) error {
	if err := validate.Moment(at, "update time"); err != nil {
		return err
	}
	if b.active == active {
		return nil
	}
	b.active = active
	b.updatedAt = at.UTC()
	return nil
}
