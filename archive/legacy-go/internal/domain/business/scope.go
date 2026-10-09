package business

import (
	"errors"
	"fmt"
)

// Errors reported when a scope is misused.
var (
	// ErrNoTenant means a scope was constructed without a business.
	ErrNoTenant = errors.New("business: scope has no business")
	// ErrCrossTenant means a record belongs to a tenant the scope does not cover.
	ErrCrossTenant = errors.New("business: record belongs to another tenant")
)

// Scope names the tenant an operation is confined to.
//
// Every repository and service operation over business-owned data takes a
// Scope. Passing it is not optional and it cannot be constructed empty, so
// "which business is this for?" is a question the caller must answer rather
// than a filter that can be forgotten (ADR-008).
//
// A scope always names a business. It may additionally name a branch, in which
// case it is narrowed to that branch. A scope with no branch covers the whole
// business.
//
// The zero Scope is invalid and permits nothing, so a struct field that was
// never assigned denies access rather than granting it.
type Scope struct {
	business ID
	branch   BranchID
}

// NewScope returns a scope covering an entire business.
func NewScope(business ID) (Scope, error) {
	if business.IsZero() {
		return Scope{}, ErrNoTenant
	}
	return Scope{business: business}, nil
}

// ScopeOf builds a scope from a business and an optional branch, without
// reporting an error.
//
// It is for callers holding identifiers already validated elsewhere — an entity
// exposing its own scope, typically. A zero business yields the zero Scope,
// which permits nothing, so the total form still fails closed. Callers handling
// untrusted input use NewScope, which says what was wrong.
func ScopeOf(businessID ID, branchID BranchID) Scope {
	if businessID.IsZero() {
		return Scope{}
	}
	return Scope{business: businessID, branch: branchID}
}

// MustNewScope is NewScope for use in tests and fixtures. It panics on a zero
// business identifier.
func MustNewScope(business ID) Scope {
	scope, err := NewScope(business)
	if err != nil {
		panic(err)
	}
	return scope
}

// WithBranch returns a copy of the scope narrowed to a branch.
//
// Narrowing an already narrowed scope replaces the branch rather than
// intersecting: a scope names one branch at most.
func (s Scope) WithBranch(branch BranchID) (Scope, error) {
	if !s.Valid() {
		return Scope{}, ErrNoTenant
	}
	if branch.IsZero() {
		return Scope{}, fmt.Errorf("%w: branch identifier is unset", ErrNoTenant)
	}
	s.branch = branch
	return s, nil
}

// WithoutBranch returns a copy of the scope widened to the whole business.
func (s Scope) WithoutBranch() Scope {
	s.branch = BranchID{}
	return s
}

// Business returns the business the scope covers.
func (s Scope) Business() ID { return s.business }

// Branch returns the branch the scope is narrowed to, and whether it is
// narrowed at all.
func (s Scope) Branch() (BranchID, bool) {
	return s.branch, !s.branch.IsZero()
}

// Valid reports whether the scope names a business.
func (s Scope) Valid() bool { return !s.business.IsZero() }

// IsBranchScoped reports whether the scope is narrowed to a single branch.
func (s Scope) IsBranchScoped() bool { return !s.branch.IsZero() }

// Permits reports whether a record owned by the given business and branch is
// visible in this scope.
//
// A record with no branch belongs to the business as a whole and is visible
// from any scope of that business. An invalid scope permits nothing.
func (s Scope) Permits(business ID, branch BranchID) bool {
	if !s.Valid() || business.IsZero() || s.business != business {
		return false
	}
	if s.branch.IsZero() || branch.IsZero() {
		return true
	}
	return s.branch == branch
}

// Guard returns nil if the record is visible in this scope, and an error
// wrapping ErrCrossTenant otherwise.
//
// Services call this before acting on a record they did not load through the
// scope, so that an identifier supplied by a client cannot be used to reach
// another tenant's data.
func (s Scope) Guard(business ID, branch BranchID) error {
	if s.Permits(business, branch) {
		return nil
	}
	if !s.Valid() {
		return ErrNoTenant
	}
	return fmt.Errorf("%w: scope covers %s but the record belongs to %s", ErrCrossTenant, s, describe(business, branch))
}

// Equal reports whether both scopes cover exactly the same tenant.
func (s Scope) Equal(other Scope) bool { return s == other }

// String implements fmt.Stringer, for logs and error messages.
func (s Scope) String() string {
	if !s.Valid() {
		return "business.Scope{invalid}"
	}
	return "business.Scope{" + describe(s.business, s.branch) + "}"
}

func describe(business ID, branch BranchID) string {
	if business.IsZero() {
		return "no business"
	}
	if branch.IsZero() {
		return "business " + business.String()
	}
	return "business " + business.String() + ", branch " + branch.String()
}
