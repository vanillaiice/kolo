// Package authz models what a user is allowed to do.
//
// Authorization is separate from authentication (who the user is) and from
// tenancy (which business's data they are reaching). All three must hold before
// an operation proceeds: a valid token, a permission, and a matching business
// scope. This package covers the middle one — see ADR-008.
//
// Permissions are granular and the matrix is configurable per business
// (SPECIFICATION.md §38). Roles are a convenience that resolves to a set of
// permissions; nothing in the system authorises against a role directly, so a
// business can grant or revoke individual permissions without inventing a role.
package authz

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

// ErrUnknownPermission means a permission string is not one this system
// defines.
var ErrUnknownPermission = errors.New("authz: unknown permission")

// Permission is a single granular capability, named "<domain>.<action>".
type Permission string

// The permissions this system defines, grouped by domain. The set is
// deliberately explicit: a permission that is not listed here cannot be granted,
// so a typo in stored data fails loudly instead of silently denying access
// forever.
const (
	// Products (SPECIFICATION.md §6).
	ProductsView    Permission = "products.view"
	ProductsCreate  Permission = "products.create"
	ProductsEdit    Permission = "products.edit"
	ProductsPrice   Permission = "products.price"
	ProductsArchive Permission = "products.archive"

	// Inventory (§7).
	InventoryView    Permission = "inventory.view"
	InventoryReceive Permission = "inventory.receive"
	InventoryAdjust  Permission = "inventory.adjust"
	InventoryCount   Permission = "inventory.count"

	// Sales and the point of sale (§9, §41).
	SalesCreate   Permission = "sales.create"
	SalesView     Permission = "sales.view"
	SalesViewOwn  Permission = "sales.view_own"
	SalesRefund   Permission = "sales.refund"
	SalesDiscount Permission = "sales.discount"

	// Customers and customer credit (§12, §13).
	CustomersView   Permission = "customers.view"
	CustomersManage Permission = "customers.manage"
	CustomersCredit Permission = "customers.credit"

	// Suppliers (§14).
	SuppliersView   Permission = "suppliers.view"
	SuppliersManage Permission = "suppliers.manage"

	// Purchases and supplier payments (§15, §16).
	PurchasesView   Permission = "purchases.view"
	PurchasesCreate Permission = "purchases.create"
	PurchasesPay    Permission = "purchases.pay"

	// Expenses (§19).
	ExpensesView   Permission = "expenses.view"
	ExpensesCreate Permission = "expenses.create"

	// Financial accounts and cash management (§17, §18).
	FinanceAccountsView   Permission = "finance.accounts.view"
	FinanceAccountsManage Permission = "finance.accounts.manage"
	CashView              Permission = "cash.view"
	CashCount             Permission = "cash.count"
	CashReconcile         Permission = "cash.reconcile"

	// Reports (§21).
	ReportsSales     Permission = "reports.sales"
	ReportsInventory Permission = "reports.inventory"
	ReportsCustomers Permission = "reports.customers"
	ReportsSuppliers Permission = "reports.suppliers"
	ReportsFinancial Permission = "reports.financial"

	// Users, business settings, and audit (§37, §38, §39).
	UsersView        Permission = "users.view"
	UsersManage      Permission = "users.manage"
	BusinessSettings Permission = "business.settings"
	AuditView        Permission = "audit.view"
)

// all lists every defined permission, in the canonical order used by All.
var all = []Permission{
	ProductsView, ProductsCreate, ProductsEdit, ProductsPrice, ProductsArchive,

	InventoryView, InventoryReceive, InventoryAdjust, InventoryCount,

	SalesCreate, SalesView, SalesViewOwn, SalesRefund, SalesDiscount,

	CustomersView, CustomersManage, CustomersCredit,

	SuppliersView, SuppliersManage,

	PurchasesView, PurchasesCreate, PurchasesPay,

	ExpensesView, ExpensesCreate,

	FinanceAccountsView, FinanceAccountsManage,
	CashView, CashCount, CashReconcile,

	ReportsSales, ReportsInventory, ReportsCustomers, ReportsSuppliers, ReportsFinancial,

	UsersView, UsersManage, BusinessSettings, AuditView,
}

// defined indexes all for lookup.
var defined = func() map[Permission]struct{} {
	index := make(map[Permission]struct{}, len(all))
	for _, permission := range all {
		index[permission] = struct{}{}
	}
	return index
}()

// sensitive lists the operations that must write an audit record when performed
// (SPECIFICATION.md §39).
var sensitive = map[Permission]struct{}{
	ProductsPrice:         {}, // product price changed
	InventoryAdjust:       {}, // stock manually adjusted
	SalesRefund:           {}, // sale refunded
	ExpensesCreate:        {}, // expense created
	CustomersCredit:       {}, // customer debt modified
	UsersManage:           {}, // user permission changed
	CashReconcile:         {}, // cash reconciliation performed
	FinanceAccountsManage: {}, // financial accounts altered
}

// All returns every defined permission, in a stable order.
func All() []Permission {
	return slices.Clone(all)
}

// Defined reports whether p is a permission this system knows.
func (p Permission) Defined() bool {
	_, ok := defined[p]
	return ok
}

// IsSensitive reports whether exercising p requires an audit record.
//
// Tying the audit list to permissions keeps SPECIFICATION.md §39 and §38 in one
// place: a new sensitive capability cannot be added without deciding whether it
// is audited.
func (p Permission) IsSensitive() bool {
	_, ok := sensitive[p]
	return ok
}

// Domain returns the part of the permission name before the first dot, which is
// the business domain it belongs to.
func (p Permission) Domain() string {
	domain, _, _ := strings.Cut(string(p), ".")
	return domain
}

// String implements fmt.Stringer.
func (p Permission) String() string { return string(p) }

// ParsePermission converts stored or transmitted text into a Permission,
// rejecting anything this system does not define.
func ParsePermission(text string) (Permission, error) {
	candidate := Permission(text)
	if !candidate.Defined() {
		return "", fmt.Errorf("%w: %q", ErrUnknownPermission, text)
	}
	return candidate, nil
}
