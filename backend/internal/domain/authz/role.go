package authz

import (
	"errors"
	"fmt"
	"slices"
)

// ErrUnknownRole means a role string is not one this system defines.
var ErrUnknownRole = errors.New("authz: unknown role")

// Role is a named starting point for a user's permissions
// (SPECIFICATION.md §38).
//
// A role is a convenience, not the authority. Authorization always asks a
// permission Set, because a business may add or remove individual permissions
// for a user without changing their role.
type Role string

// The roles this system defines.
const (
	// RoleOwner has full access, including users and business settings.
	RoleOwner Role = "OWNER"
	// RoleManager runs day-to-day operations and reads reports.
	RoleManager Role = "MANAGER"
	// RoleCashier operates the point of sale.
	RoleCashier Role = "CASHIER"
	// RoleInventory manages products and stock.
	RoleInventory Role = "INVENTORY"
	// RoleAccountant reads financial information and records expenses.
	RoleAccountant Role = "ACCOUNTANT"
)

// roles lists every defined role, in a stable order.
var roles = []Role{RoleOwner, RoleManager, RoleCashier, RoleInventory, RoleAccountant}

// Roles returns every defined role, in a stable order.
func Roles() []Role { return slices.Clone(roles) }

// Defined reports whether r is a role this system knows.
func (r Role) Defined() bool { return slices.Contains(roles, r) }

// String implements fmt.Stringer.
func (r Role) String() string { return string(r) }

// ParseRole converts stored or transmitted text into a Role.
func ParseRole(text string) (Role, error) {
	candidate := Role(text)
	if !candidate.Defined() {
		return "", fmt.Errorf("%w: %q", ErrUnknownRole, text)
	}
	return candidate, nil
}

// defaultPermissions holds the starting permission set for each role.
//
// These are defaults, not policy: SPECIFICATION.md §38 requires the matrix to
// be configurable, so a business may depart from any of this. They are chosen
// to be the least surprising starting point for the roles described in §3.
var defaultPermissions = map[Role]Set{
	// The owner needs visibility into the entire business (§3), so the owner
	// gets everything. This is resolved from the full list rather than
	// enumerated, so a newly defined permission is never accidentally withheld
	// from the one role that must always have it.
	RoleOwner: MustNewSet(all...),

	// The manager operates the business on the owner's behalf (§3): all
	// operations and all reports, but not user administration, business
	// settings, or the audit trail — those stay with the owner unless granted.
	RoleManager: MustNewSet(
		ProductsView, ProductsCreate, ProductsEdit, ProductsPrice, ProductsArchive,
		InventoryView, InventoryReceive, InventoryAdjust, InventoryCount,
		SalesCreate, SalesView, SalesViewOwn, SalesRefund, SalesDiscount,
		CustomersView, CustomersManage, CustomersCredit,
		SuppliersView, SuppliersManage,
		PurchasesView, PurchasesCreate, PurchasesPay,
		ExpensesView, ExpensesCreate,
		FinanceAccountsView, CashView, CashCount, CashReconcile,
		ReportsSales, ReportsInventory, ReportsCustomers, ReportsSuppliers, ReportsFinancial,
		UsersView,
	),

	// The cashier operates the till (§3): create sales, take payments, look up
	// products and customers, and see their own transactions. Refunds are
	// "if authorized" and so are not a default. §3 is explicit that the cashier
	// does not automatically get sensitive financial reports.
	RoleCashier: MustNewSet(
		ProductsView,
		InventoryView,
		SalesCreate, SalesViewOwn,
		CustomersView,
	),

	// Inventory staff manage products and stock (§3), and may not need sales or
	// financial information. Suppliers are readable because stock arrives from
	// them. Price changes are a commercial decision and are withheld by default.
	RoleInventory: MustNewSet(
		ProductsView, ProductsCreate, ProductsEdit, ProductsArchive,
		InventoryView, InventoryReceive, InventoryAdjust, InventoryCount,
		SuppliersView,
		PurchasesView,
		ReportsInventory,
	),

	// The accountant reads financial information (§38) and records expenses.
	// They observe operations rather than performing them: no sales, no stock
	// movements.
	RoleAccountant: MustNewSet(
		ProductsView,
		InventoryView,
		SalesView,
		CustomersView,
		SuppliersView,
		PurchasesView,
		ExpensesView, ExpensesCreate,
		FinanceAccountsView, CashView,
		ReportsSales, ReportsInventory, ReportsCustomers, ReportsSuppliers, ReportsFinancial,
		AuditView,
	),
}

// DefaultPermissions returns the starting permission set for a role.
//
// An undefined role yields an empty set and false, so an unrecognised value
// read from storage denies access rather than granting something arbitrary.
func DefaultPermissions(r Role) (Set, bool) {
	permissions, ok := defaultPermissions[r]
	if !ok {
		return Set{}, false
	}
	return permissions, true
}

// Effective returns the permissions a role resolves to once per-user grants and
// revocations are applied.
//
// Revocation is applied last, so an explicit revocation always wins over both
// the role default and a grant. That ordering makes "this user must not be able
// to do X" a statement that holds regardless of what else is configured.
//
// The function is total: an unrecognised role contributes no defaults, so the
// result is whatever was explicitly granted. Callers that hold an already
// validated role use this; callers validating untrusted input use Resolve,
// which reports the bad role instead of quietly resolving around it.
func Effective(r Role, granted, revoked Set) Set {
	base, _ := DefaultPermissions(r)
	return base.Union(granted).Without(revoked.All()...)
}

// Resolve is Effective with the role checked first, reporting an unrecognised
// role rather than treating it as one that grants nothing.
func Resolve(r Role, granted, revoked Set) (Set, error) {
	if !r.Defined() {
		return Set{}, fmt.Errorf("%w: %q", ErrUnknownRole, r)
	}
	return Effective(r, granted, revoked), nil
}
