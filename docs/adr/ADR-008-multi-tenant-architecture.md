# ADR-008: Multi-tenant architecture

**Status:** Accepted
**Source:** SPECIFICATION.md §37, §38, §42, §43, §40

## Context

One platform serves many independent businesses. A user in Business A must never
be able to reach Business B's data. This is the system's most consequential
security boundary.

## Decision

Every business-owned record is associated with a business/organization, and
**tenant isolation is enforced at the data/service layer, not by UI checks**.

The data model accommodates the hierarchy even though the MVP ships single-branch:

```
Organization → Branch → {Devices, Users, Inventory}
```

Authorization is separate from tenancy and equally explicit. Roles (OWNER,
MANAGER, CASHIER, INVENTORY, ACCOUNTANT) resolve to granular, configurable
permissions such as `sales.create`, `sales.refund`, `inventory.adjust`,
`products.edit`, `reports.financial`, `customers.credit`, `expenses.create`,
`users.manage`. Cashiers do not get financial reports by default.

## Consequences

* Business scope is a required parameter of repository and service operations, not
  an optional filter that a caller may forget. A query that can be written without
  a tenant scope is a defect.
* Tenant isolation is a mandatory test subject for every data-access path, not
  only for those that look security-sensitive.
* Sync is tenant-scoped: events carry `business_id`, and the server verifies it
  against the authenticated device and user rather than trusting the payload.
* Because branch exists in the model from the start, later multi-branch support is
  a feature, not a migration of every table.
