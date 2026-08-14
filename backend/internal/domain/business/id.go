// Package business models the tenant: the organization that owns every other
// record in the system, and the branches it operates from.
//
// Tenant isolation is the system's most consequential security boundary. A user
// in Business A must never reach Business B's data, and that is enforced here
// and in the data layer rather than by UI checks (SPECIFICATION.md §37, §43;
// ADR-008). Scope is the mechanism: it is a required argument to repository and
// service operations, so a query cannot be written without saying which tenant
// it belongs to.
//
// The hierarchy is Organization → Branch → {Devices, Users, Inventory} (§42).
// The MVP ships single-branch, but the model carries Branch from the start so
// that multi-branch support is later a feature rather than a migration of every
// table.
package business

import "github.com/vanillaiice/kolo/backend/internal/kernel/id"

type (
	businessTag struct{}
	branchTag   struct{}
)

// ID identifies a business. It is immutable once assigned.
type ID = id.Typed[businessTag]

// BranchID identifies a branch of a business. It is immutable once assigned.
type BranchID = id.Typed[branchTag]

// NewID returns a new business identifier.
func NewID() ID { return id.NewTyped[businessTag]() }

// NewBranchID returns a new branch identifier.
func NewBranchID() BranchID { return id.NewTyped[branchTag]() }

// IDFrom tags an identifier drawn from a generator as a business identifier.
func IDFrom(value id.ID) ID { return id.TypedFrom[businessTag](value) }

// BranchIDFrom tags an identifier drawn from a generator as a branch
// identifier.
func BranchIDFrom(value id.ID) BranchID { return id.TypedFrom[branchTag](value) }

// ParseID reads a business identifier from its text form.
func ParseID(text string) (ID, error) { return id.ParseTyped[businessTag](text) }

// ParseBranchID reads a branch identifier from its text form.
func ParseBranchID(text string) (BranchID, error) { return id.ParseTyped[branchTag](text) }
