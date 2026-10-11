# KOLO - Business Management Platform

## Product, Architecture & Engineering Specification

**Project status:** Active implementation; standalone editions and TypeScript architecture accepted 2026-10-05
**Target market:** Small and medium-sized businesses in Africa, starting with Cameroon
**Primary platforms:** Android / Desktop (Windows first)
**Secondary platforms:** iOS / Optional web management
**Client:** React Native/Expo mobile + Electron/React desktop; shared TypeScript core
**Backend:** Optional Fastify + TypeScript (Go implementation archived as reference)
**Local database:** SQLite
**Server database:** PostgreSQL
**Architecture:** Standalone-first; optional file/Bluetooth/hosted/self-hosted event exchange

Architecture decisions: [ADR-017](docs/adr/ADR-017-typescript-workspaces-and-optional-server.md),
[ADR-018](docs/adr/ADR-018-standalone-editions-and-local-authority.md),
[ADR-019](docs/adr/ADR-019-event-exchange-and-destination-delivery.md).
Detailed implementation sequence: [implementation plan](docs/implementation/plan.md).
These supersede the prior Go/server-required setup decisions; domain integrity rules remain binding.

---

# 1. Product Overview

The product is an offline-first business management platform designed primarily for shops, supermarkets, boutiques, pharmacies, wholesalers, and other small and medium-sized businesses in Cameroon.

The system combines:

* Inventory management
* Point of sale
* Sales tracking
* Customer management
* Customer credit/debt
* Supplier management
* Purchases
* Cash management
* Mobile Money and other payment accounts
* Expenses
* Financial transaction tracking
* Business reports
* Multi-user management
* Multi-device synchronization

The central design principle is:

> **The business must remain operational when the internet is unavailable.**

Internet connectivity is treated as an enhancement for synchronization, backups, multi-device operation, remote management, and other online functionality, not as a prerequisite for basic business operations.

The initial product should focus on operational business management rather than attempting to become a complete accounting or ERP system.

---

# 2. Product Vision

The long-term vision is to build a digital operating system for small and medium-sized businesses across Africa.

The initial entry point is inventory and sales.

The product can eventually expand into:

```text
Inventory
    ↓
Point of Sale
    ↓
Cash Management
    ↓
Customer Credit
    ↓
Supplier Management
    ↓
Business Analytics
    ↓
Accounting
    ↓
Purchasing
    ↓
Payroll
    ↓
Multi-Branch Management
```

The product should therefore be architected so that additional business domains can be added without rewriting the core system.

---

# 3. Target Users

## Business Owner

The owner needs visibility into the entire business.

Primary needs:

* Revenue
* Profitability
* Cash position
* Inventory
* Customer debt
* Supplier debt
* Expenses
* Product performance
* Employee activity
* Business trends

The owner may access the system from a phone, tablet, web browser, or desktop.

## Manager

The manager operates the business on behalf of the owner.

Typical permissions:

* Inventory management
* Purchases
* Sales
* Customers
* Suppliers
* Reports
* Staff management, depending on permissions

## Cashier

The cashier primarily operates the POS.

Typical permissions:

* Create sales
* Accept payments
* Process returns, if authorized
* View relevant product information
* View their own transactions

The cashier should not automatically have access to sensitive financial reports.

## Inventory Staff

Inventory employees may need:

* Product management
* Stock receiving
* Stock counting
* Stock adjustments
* Inventory reports

They should not necessarily have access to sales or financial information.

---

# 4. Core Product Principles

## Offline First

Every essential operation must work without an internet connection.

The following operations must be available offline:

* Product lookup
* Product creation
* Inventory changes
* Sales
* Returns
* Customer management
* Customer payments
* Supplier purchases
* Supplier payments
* Expenses
* Cash management
* Reports based on local data

When connectivity returns, data synchronizes automatically.

## Local First

The local database is not merely a cache.

It is the primary operational database for the device.

The application should not require an API request to perform a basic operation.

Bad architecture:

```text
User
 ↓
React Native
 ↓
API
 ↓
Server
 ↓
Database
```

Required architecture:

```text
User
 ↓
React Native
 ↓
Application/domain logic
 ↓
SQLite
 ↓
Sync engine
 ↓
API
 ↓
PostgreSQL
```

## Transaction Integrity

Financial and inventory operations must be represented as transactions or immutable movements.

The system should avoid directly overwriting important historical state.

For example, inventory should not simply be:

```text
product.stock = 47
```

Instead, inventory should be represented through movements such as:

```text
+100 Purchase
 -3 Sale
 -2 Damaged
+10 Adjustment
 -5 Return
```

Current stock can then be derived from these movements.

## Auditability

Important business actions must be traceable.

The system should be able to answer:

* Who performed the action?
* When?
* On which device?
* What changed?
* Why did it change?
* Was it later corrected?

Financial transactions should never be silently deleted or overwritten.

Corrections should generally be represented as reversal/correction transactions.

---

# 5. Core Business Domains

The application is divided into the following major domains:

```text
Authentication
Business / Organization
Users & Roles
Products
Inventory
Sales
Customers
Suppliers
Purchases
Payments
Cash & Financial Accounts
Expenses
Reports
Synchronization
Notifications
```

Each domain should have clearly defined responsibilities.

Avoid creating a single massive "business" module containing unrelated functionality.

---

# 6. Products

Products represent items that the business sells, purchases, or stores.

A product may contain:

```text
ID
Name
SKU
Barcode
Description
Category
Brand
Unit
Purchase Price
Selling Price
Tax configuration
Minimum Stock Level
Active/Inactive
Created At
Updated At
```

Additional fields can be introduced later.

Products should support barcode scanning.

The barcode itself should not necessarily be the primary identifier. Products should have an internal immutable ID.

---

# 7. Inventory

Inventory tracks physical stock.

Inventory should be based on **stock movements**.

Examples:

```text
Purchase       +100
Sale             -3
Sale Return      +1
Customer Return  +1
Damage           -2
Adjustment       +5
Stock Count      -3
Transfer         -10
```

A stock movement should contain information such as:

```text
Movement ID
Product ID
Quantity
Movement Type
Reference ID
Timestamp
User ID
Device ID
Reason
```

The system must distinguish between:

* Available stock
* Reserved stock, if introduced later
* Damaged stock, if separately tracked
* Stock at different locations

---

# 8. Inventory Valuation

The MVP should support basic inventory valuation.

The system should retain purchase cost information rather than assuming that selling price equals inventory value.

The initial implementation can support a simple valuation strategy.

The architecture should allow future support for:

* FIFO
* Weighted average
* Other valuation methods

Inventory valuation should not be tightly coupled to the UI.

---

# 9. Point of Sale

The POS should optimize for speed.

Typical workflow:

```text
Search / Scan Product
        ↓
Add to Cart
        ↓
Adjust Quantity
        ↓
Apply Discount
        ↓
Select Payment
        ↓
Complete Sale
        ↓
Receipt
```

A cashier should be able to complete a common sale with minimal interaction.

The POS must work completely offline.

A sale creates the appropriate business transactions.

Conceptually:

```text
Sale
 ├── Sale transaction
 ├── Sale items
 ├── Inventory movements
 ├── Payment transaction(s)
 ├── Customer transaction, if applicable
 └── Financial records
```

---

# 10. Payments

Payments should be represented independently from sales.

Supported payment methods should initially include:

```text
Cash
Mobile Money
Bank Transfer
Card
Credit
Other
```

Mobile Money should be configurable rather than hard-coded into the core architecture.

The system may initially support:

```text
MTN Mobile Money
Orange Money
```

but the underlying model should simply represent a financial account/payment method.

This allows additional providers to be added later.

---

# 11. Split Payments

The system should support multiple payment methods for one sale.

Example:

```text
Sale Total: 18,500 FCFA

Cash:        10,000
Mobile Money: 8,500

Total Paid:  18,500
Balance:          0
```

A sale should therefore not have a simplistic:

```text
payment_method
```

field as its only payment representation.

Instead:

```text
Sale
 └── Payments
      ├── Cash
      └── Mobile Money
```

---

# 12. Customers

Customers should be optional for normal cash sales.

A customer record may contain:

```text
Customer ID
Name
Phone
Address
Notes
Credit Limit
Created At
Updated At
```

The system should support:

* Customer purchase history
* Payments
* Outstanding balance
* Credit sales
* Returns
* Account statements

---

# 13. Customer Credit

Customer credit is an important business feature.

Example:

```text
Customer: Jean

Purchase:       25,000
Payment:       -10,000
------------------------
Outstanding:    15,000 FCFA
```

Customer balances should be derived from financial/customer transactions rather than manually edited.

The system should support:

* Credit sales
* Partial payments
* Full payments
* Returns
* Account statements
* Outstanding balances
* Credit limits
* Payment history

---

# 14. Suppliers

Suppliers represent businesses or individuals from whom products are purchased.

Supplier information may include:

```text
Supplier ID
Name
Phone
Address
Contact person
Notes
```

The system should maintain:

* Purchase history
* Amount owed
* Payments
* Product relationships
* Supplier statements

---

# 15. Purchases

Purchases increase inventory and may create supplier liabilities.

Example:

```text
Purchase

20 × Product A @ 400
10 × Product B @ 250

Total = 10,500 FCFA
```

If paid immediately:

```text
Inventory ↑
Cash ↓
Supplier balance unchanged
```

If purchased on credit:

```text
Inventory ↑
Supplier payable ↑
Cash unchanged
```

A purchase should therefore not simply be an inventory operation.

It is a business transaction affecting multiple domains.

---

# 16. Supplier Payments

Supplier payments decrease the outstanding supplier balance and decrease the relevant financial account.

Example:

```text
Supplier payable: -50,000
MTN MoMo:         -50,000
```

Supplier balances should be derived from purchase and payment transactions.

---

# 17. Financial Accounts

The application should represent the business's money through financial accounts.

Examples:

```text
Cash Register
Petty Cash
MTN Mobile Money
Orange Money
Bank Account
Other
```

Accounts represent where money currently exists.

Transactions move money between these accounts or between the business and external parties.

---

# 18. Cash Management

Cash management should allow the owner to determine expected and actual cash.

Example:

```text
Expected Cash: 245,500 FCFA
Actual Cash:   240,500 FCFA

Difference:     -5,000 FCFA
```

The system should support:

* Opening balances
* Cash inflows
* Cash outflows
* Cash transfers
* Cash counting
* Reconciliation
* Adjustments
* Cash drawer/session management

---

# 19. Expenses

Expenses represent business costs that are not directly represented as inventory purchases.

Examples:

```text
Rent
Electricity
Transport
Salary
Packaging
Maintenance
Internet
Marketing
Other
```

Each expense should be associated with:

```text
Amount
Category
Financial Account
Date
Description
User
Reference
```

Expenses should affect reporting but should not be confused with inventory purchases.

---

# 20. Financial Model

The MVP does not need to implement full formal accounting.

However, the underlying architecture should be compatible with proper financial accounting later.

The application should maintain reliable transaction records.

Conceptually:

```text
Business Event
      ↓
Transaction
      ↓
Financial Effects
```

A sale may produce:

```text
Cash / Receivable       +
Revenue                 +
Inventory               -
Cost of Goods Sold      +
```

A purchase may produce:

```text
Inventory               +
Cash / Payable          -
```

An expense may produce:

```text
Expense                 +
Cash / Bank             -
```

The exact accounting implementation can evolve later.

---

# 21. Reports

Reports are a major product feature.

## Sales Reports

* Daily sales
* Weekly sales
* Monthly sales
* Sales by product
* Sales by category
* Sales by employee
* Sales by payment method

## Inventory Reports

* Current inventory
* Low-stock products
* Inventory valuation
* Stock movements
* Fast-moving products
* Slow-moving products
* Dead stock

## Customer Reports

* Outstanding debt
* Customer balances
* Payment history
* Customer purchase history

## Supplier Reports

* Supplier balances
* Purchase history
* Supplier payments

## Financial Reports

* Revenue
* Cost of goods sold
* Gross profit
* Expenses
* Net operating result
* Cash flow
* Cash balances

Reports should be generated from transaction data rather than duplicated manually maintained totals.

---

# 22. Dashboard

The dashboard should prioritize actionable information.

Example:

```text
TODAY

Sales              485,500 FCFA
Gross Profit       126,300 FCFA
Expenses            35,000 FCFA
Net Result          91,300 FCFA

Transactions              47
Items Sold                183

Customer Debt         285,000 FCFA
Supplier Debt         175,000 FCFA

Low Stock                  8
```

The dashboard should allow the user to change the reporting period.

---

# 23. Offline-First Architecture

This is a foundational architectural requirement.

Mobile and desktop each maintain a local SQLite database and perform all core
operations locally, including first shop setup and local user authentication.
The optional Fastify server maintains PostgreSQL for hosted or self-hosted exchange.
A standalone installation needs no server or online account. File exchange and
Bluetooth merge versioned events; snapshots are for bootstrap and backup/restore.

```text
React Native mobile ── Shared TypeScript core ── Local SQLite
Electron desktop    ── Shared TypeScript core ── Local SQLite
                              │
                   File / Bluetooth / HTTP exchange
                              │
                  Optional Fastify sync server
                              │
                          PostgreSQL
```

Hosted subscription expiry pauses hosted services, never local trading or access to
recorded data. Self-hosted and hosted servers use the same application.
Core operations must never block because synchronization failed.

---

# 24. Local Database

SQLite is the operational database on the client.

It stores:

* Business data
* Products
* Inventory
* Sales
* Customers
* Suppliers
* Purchases
* Payments
* Expenses
* Financial accounts
* Synchronization metadata

The local database should be treated as durable application state.

The application should remain useful for extended periods without internet connectivity.

---

# 25. Synchronization

Synchronization is a first-class subsystem.

It should not be implemented as a collection of random API calls.

The synchronization engine should track changes locally.

Conceptually:

```text
User action
    ↓
Local transaction
    ↓
SQLite commit
    ↓
Sync record created
    ↓
Application continues
    ↓
Internet becomes available
    ↓
Sync engine uploads changes
    ↓
Server acknowledges
    ↓
Remote changes downloaded
```

The user should generally not need to manually initiate synchronization.

---

# 26. Event / Transaction-Based Synchronization

Important business operations should be synchronized as transactions/events rather than blindly synchronizing final state.

Example:

Bad:

```json
{
  "product_id": "123",
  "stock": 47
}
```

Preferred:

```json
{
  "event_id": "evt_123",
  "type": "SALE_COMPLETED",
  "product_id": "123",
  "quantity": 3,
  "timestamp": "...",
  "device_id": "device_abc"
}
```

The server can then process the event.

This makes synchronization more reliable when multiple devices operate offline.

---

# 27. Event Identity

Every synchronized event should have a globally unique immutable identifier.

Example:

```text
event_id
device_id
business_id
user_id
created_at
event_type
payload
```

The server must be idempotent.

If the same event is uploaded twice, it must not be applied twice.

For example:

```text
Client → EVENT 123
Server → processed

Client retries EVENT 123
Server → recognizes EVENT 123
Server → does not apply it again
```

---

# 28. Device Identity

Each installation should have a unique device identity.

Example:

```text
Business
    └── Device
          ├── Device ID
          ├── User
          ├── Last Sync
          └── Device Metadata
```

Device identity is important for:

* Synchronization
* Audit logs
* Conflict resolution
* Security
* Troubleshooting

---

# 29. Conflict Resolution

Conflicts are expected in an offline-first multi-device system.

Example:

Two devices independently sell the last item.

```text
Device A:
Stock = 1
Sale -1

Device B:
Stock = 1
Sale -1
```

The system must not attempt to resolve this by arbitrarily choosing one device's stock value.

Inventory should be derived from accepted movements/events.

Financial records should never be silently overwritten.

Different data types may have different conflict strategies.

For example:

```text
Financial transactions → immutable
Inventory movements     → append-only
Product description     → last-write-wins may be acceptable
User permissions        → shop-owner authority, locally enforced and propagated; optional server enforces enrolled authority
```

Conflict policies must be explicit.

---

# 30. Server Architecture

The optional backend is implemented in Fastify + TypeScript (ADR-025). Shared pure rules and
contracts are reused from packages; PostgreSQL and SQLite repositories remain separate.
The old Go backend remains in repository history as a parity/migration reference; it is no longer published in the tree.

High-level structure:

```text
Fastify Backend

API
├── Authentication
├── Businesses
├── Users
├── Products
├── Inventory
├── Sales
├── Customers
├── Suppliers
├── Purchases
├── Payments
├── Finance
├── Expenses
├── Reports
└── Synchronization
```

The backend should separate:

```text
HTTP/API layer
        ↓
Application/service layer
        ↓
Domain layer
        ↓
Repository/data layer
```

The domain should not depend directly on HTTP.

---

# 31. Backend Storage

The central database should use PostgreSQL.

PostgreSQL is responsible for:

* Centralized business data
* Synchronization
* Multi-device coordination
* Server-side reporting
* Authentication-related state
* Audit data
* Backup
* Remote access

SQLite remains the local operational database.

---

# 32. React Native Client

The primary application client will use:

```text
React Native
TypeScript
```

The application should be mobile-first.

The initial priority should be Android because of the target market and expected hardware environment.

The architecture should nevertheless avoid Android-specific assumptions where unnecessary.

The UI should support:

* Phones
* Tablets
* Different screen sizes
* Touch-first interaction
* Barcode scanners/cameras
* Offline operation

---

# 33. Client Architecture

The React Native application should be divided into:

```text
src/

    app/
        navigation/
        providers/
        configuration/

    features/
        auth/
        dashboard/
        products/
        inventory/
        pos/
        customers/
        suppliers/
        purchases/
        payments/
        expenses/
        reports/

    domain/
        entities/
        valueObjects/
        businessRules/

    data/
        database/
        repositories/
        sync/

    services/
        authentication/
        synchronization/
        printing/
        barcode/

    components/
        ui/
        forms/
        lists/

    utils/
```

The exact structure may evolve, but domain boundaries should remain clear.

---

# 34. Client State Management

UI state and persistent business data should not be treated as the same thing.

Persistent business state belongs in SQLite.

Transient UI state may live in React state or an appropriate state-management library.

The architecture should avoid putting the entire business database into an in-memory global store.

The basic flow should be:

```text
UI
 ↓
Application action
 ↓
Repository
 ↓
SQLite transaction
 ↓
UI observes updated local data
```

---

# 35. API Design

The API should primarily serve:

* Authentication
* Synchronization
* Remote management
* Server-side operations
* Reports that require centralized data

The application should not depend on the API for basic offline operations.

Planned v2 API areas (these are not all implemented endpoints; see the current
[server API contract](docs/implementation/server-api.md)). Archived clients use v1
until explicit enrollment/protocol migration:

```text
/api/v2/auth
/api/v2/businesses
/api/v2/users
/api/v2/products
/api/v2/inventory
/api/v2/sales
/api/v2/customers
/api/v2/suppliers
/api/v2/purchases
/api/v2/payments
/api/v2/expenses
/api/v2/reports
/api/v2/sync
```

The API version should be explicit.

---

# 36. Synchronization API

Synchronization should have dedicated endpoints rather than pretending synchronization is normal CRUD.

Conceptually:

```text
POST /api/v2/sync/push
GET  /api/v2/sync/pull
```

The exact API contract should be defined separately.

A push request may contain multiple events.

A pull response may contain events that occurred on other devices.

The protocol must support:

* Batch synchronization
* Idempotency
* Acknowledgements
* Ordering information
* Retry
* Partial failures
* Authentication
* Conflict reporting

---

# 37. Security

Standalone local unlock/permissions are independent of optional network sessions.
Fresh shop setup must work offline; owner-approved authority propagates through
verified exchange. See the [identity contract](docs/implementation/identity.md).

The application contains sensitive business information.

Security requirements include:

* Secure authentication
* Encrypted network communication
* Secure token storage
* Authorization
* Business-level data isolation
* Audit logs
* Secure local storage where appropriate
* Database protection
* Server-side validation

A user belonging to Business A must never be able to access Business B.

Business ownership should therefore be enforced throughout the data layer, not only through UI checks.

---

# 38. Authorization

Permissions should be explicit.

Example:

```text
OWNER
    Full access

MANAGER
    Operations + selected reports

CASHIER
    POS + assigned operations

INVENTORY
    Inventory + products

ACCOUNTANT
    Financial information
```

Permissions should eventually be granular enough to support:

```text
sales.create
sales.refund
inventory.adjust
products.edit
reports.financial
customers.credit
expenses.create
users.manage
```

The exact permission matrix should be configurable.

---

# 39. Audit Logs

Sensitive operations should generate audit records.

Examples:

```text
Product price changed
Stock manually adjusted
Sale refunded
Expense created
Customer debt modified
User permission changed
Cash reconciliation performed
```

Audit records should include:

```text
Actor
Business
Device
Timestamp
Action
Entity
Entity ID
Relevant metadata
```

---

# 40. Data Integrity Rules

Important rules:

* Financial transactions should not be silently deleted.
* Completed sales should not be directly edited without an audit trail.
* Inventory movements should be traceable.
* Customer balances should be derived.
* Supplier balances should be derived.
* Financial account balances should be derived.
* Synchronization events must be idempotent.
* IDs should be immutable.
* Historical transactions should retain their original timestamps.
* Business ownership must be enforced at the database/service level.

---

# 41. Returns and Corrections

Returns should not simply delete the original sale.

A return should reference the original sale where possible.

Example:

```text
Original Sale
    Product A × 5
        ↓
Return
    Product A × 2
```

The return creates compensating inventory and financial transactions.

Similarly, corrections should generally be represented through new transactions rather than modifying history.

---

# 42. Multi-Branch Support

Multi-branch support does not need to be fully implemented in the MVP, but the data model should allow it.

Recommended hierarchy:

```text
Organization
    ├── Branch
    │     ├── Devices
    │     ├── Users
    │     └── Inventory
    │
    └── Branch
          ├── Devices
          ├── Users
          └── Inventory
```

A small business can simply have one branch.

A supermarket chain can later have many.

---

# 43. Multi-Tenancy

The system should be multi-tenant.

Conceptually:

```text
Platform
    │
    ├── Business A
    │      ├── Users
    │      ├── Products
    │      ├── Sales
    │      └── Inventory
    │
    ├── Business B
    │      ├── Users
    │      ├── Products
    │      ├── Sales
    │      └── Inventory
```

Every business-owned record should be associated with the appropriate business/organization.

Tenant isolation is a critical security requirement.

---

# 44. Localization

The first market is Cameroon; the product is designed for other African countries as well.

The application should therefore support:

```text
Currency: XAF / FCFA
Languages: French and English
```

The architecture should support additional languages later.

Currency should not be represented internally as floating-point values.

Use integer minor units where appropriate.

For XAF, values can generally be represented as whole FCFA amounts.

---

# 45. Connectivity Assumptions

The product should assume that:

* Internet may be unavailable.
* Internet may be slow.
* Connections may frequently drop.
* Multiple devices may operate independently.
* Users may have limited data.
* Synchronization may be delayed for hours or days.

The application should therefore minimize unnecessary network traffic.

Synchronization should use compact payloads and batches.

---

# 46. Performance Requirements

The application should remain responsive on inexpensive Android hardware.

Primary goals:

* Fast product search
* Fast POS operations
* Fast local database queries
* Minimal startup delay
* Minimal network dependency
* Efficient synchronization
* Efficient rendering of large product lists

Inventory and POS operations should not require server round trips.

---

# 47. Barcode Support

Barcode scanning should be part of the product architecture.

The system should eventually support:

```text
Camera barcode scanning
Dedicated Bluetooth scanners
Possibly USB scanners on supported devices
```

A barcode scanner should effectively behave as an input device.

The POS should not require a camera if a dedicated scanner is available.

---

# 48. Receipts

The product should eventually support receipts.

Potential outputs:

* Digital receipt
* PDF receipt
* Printed receipt
* Thermal printer

Printing should be abstracted behind a service/interface so that printer-specific implementation does not contaminate sales logic.

---

# 49. Notifications

Potential notifications include:

```text
Low stock
Customer debt overdue
Supplier payment due
Daily sales summary
Cash discrepancy
Synchronization failure
```

Notifications should be designed as a separate subsystem.

The MVP can begin with local notifications.

---

# 50. MVP Scope

The first production MVP should contain:

```text
Business setup
User authentication
Users and basic roles

Products
Categories
Barcode
Inventory
Stock movements

POS
Sales
Returns
Cash payments
Mobile Money payments
Credit sales

Customers
Customer balances
Customer payments

Suppliers
Purchases
Supplier balances
Supplier payments

Financial accounts
Expenses
Cash management

Dashboard
Basic reports

Offline operation
Synchronization
Basic multi-device support
```

The MVP should deliberately exclude complex accounting, payroll, advanced taxation, sophisticated ERP functionality, and other secondary systems.

---

# 51. Development Phases

The domain checklist below describes product areas. The current executable sequence
F0–F9, dependencies, methods and acceptance criteria live in the
[implementation plan](docs/implementation/plan.md). Standalone setup and file exchange
precede the optional server.

## Foundation

Implement:

```text
Project structure
Authentication
Business/tenant model
User model
SQLite
PostgreSQL
Database migrations
Basic API
Basic React Native shell
```

## Inventory

Implement:

```text
Products
Categories
Stock movements
Stock levels
Barcode
Inventory history
```

## POS

Implement:

```text
Cart
Sales
Payments
Receipts
Returns
```

## Business Finance

Implement:

```text
Financial accounts
Customer credit
Supplier balances
Expenses
Cash reconciliation
```

## Reporting

Implement:

```text
Dashboard
Sales reports
Inventory reports
Financial reports
Customer reports
Supplier reports
```

## Synchronization

Implement:

```text
Device identity
Event queue
Push
Pull
Idempotency
Retries
Conflict handling
Sync status
```

## Expansion

Later:

```text
Web dashboard
Desktop client
Multi-branch
Advanced accounting
Payroll
Purchasing workflows
Advanced analytics
Cloud backup
Integrations
```

---

# 52. Repository Structure

```text
apps/
  mobile/          Expo/React Native and native adapters
  desktop/         Electron main/preload + React renderer
  server/          Optional Fastify server
packages/
  core/            Shared business rules, local SQLite operations, replay
  contracts/       Versioned runtime-validated exchange/API contracts
docs/
  adr/             Accepted decisions and supersession index
  implementation/  Phases, methods, APIs, identity, exchange, testing
  reference/       Generated public TypeScript declarations/JSDoc
  history/         Preserved historical working guidance
scripts/           Boundary and documentation verification
infrastructure/    Development DB and deployment scaffolding
archive/
  legacy-mobile/   Prior dependency-resolution reference
```

Use npm workspaces and one root lockfile. Current code and guide status must distinguish
implemented foundations from planned standalone setup, peer transfer and optional server
business behavior.

---

# 53. AI Agent Development Rules

AI agents working on this project must follow these principles.

## Read Before Modifying

An agent must inspect the existing architecture and relevant files before making changes.

It must not introduce an alternative architecture simply because it is familiar with another pattern.

## Preserve Domain Boundaries

Agents should modify the smallest appropriate domain.

For example, a product feature should not unnecessarily modify synchronization, authentication, and financial systems.

## No Silent Architectural Changes

An agent must not introduce:

* A new database
* A new backend framework
* A new state-management architecture
* A new synchronization strategy
* A new authentication system

without explicit approval.

## Offline-First Is Non-Negotiable

Agents must never implement core business functionality in a way that requires network connectivity.

Incorrect:

```text
createSale()
    → POST /sales
    → wait for server
    → show success
```

Correct:

```text
createSale()
    → validate locally
    → SQLite transaction
    → show success
    → queue synchronization
```

## Financial Data Is Immutable

Agents must not implement destructive updates to historical financial records unless the specification explicitly requires them.

Corrections should use compensating transactions.

## Idempotency Is Required

Any synchronization operation must be safe to retry.

## Do Not Duplicate Business Logic

Business rules should live in appropriate domain/application services rather than being duplicated across:

* React Native screens
* API handlers
* Database triggers
* Reports

## Tests Are Required

New business logic should include appropriate tests.

Critical areas requiring strong tests:

```text
Inventory
Sales
Payments
Customer balances
Supplier balances
Financial calculations
Synchronization
Conflict handling
Authorization
```

---

# 54. AI Agent Task Format

AI agents should receive tasks in a structured format.

Example:

```text
TASK

Implement customer credit payments.

CONTEXT

The application is an offline-first business management platform.

STACK

Client:
React Native + TypeScript

Backend:
Optional Fastify + TypeScript

Local database:
SQLite

Server database:
PostgreSQL

REQUIREMENTS

A customer may have an outstanding balance.

A payment must:
- work offline
- create a local transaction
- update the locally derived customer balance
- create a synchronization event
- synchronize when connectivity returns

CONSTRAINTS

Do not make payment creation dependent on the network.

Do not directly overwrite the customer's balance.

Do not delete historical payments.

Use the existing synchronization architecture.

DELIVERABLE

Implement the feature and tests.

BEFORE CODING

Inspect:
- customer domain
- financial transaction domain
- local database
- synchronization system
- existing tests

Do not introduce new architectural patterns without justification.
```

This format should become the standard for future coding-agent tasks.

---

# 55. Architectural Decision Records

Important architectural decisions should be documented as ADRs.

Examples:

```text
ADR-001: Offline-first architecture
ADR-002: SQLite local database
ADR-003: PostgreSQL server database
ADR-004: React Native client
ADR-005: Go backend
ADR-006: Event-based synchronization
ADR-007: Immutable financial transactions
ADR-008: Multi-tenant architecture
ADR-009: Inventory movement ledger
```

An AI agent should consult relevant ADRs before making architectural changes.

---

# 56. Source of Truth Hierarchy

The project should establish a clear hierarchy.

```text
Product specification
        ↓
Architecture specification
        ↓
Architecture Decision Records
        ↓
Domain specifications
        ↓
Implementation
        ↓
Tests
```

If implementation conflicts with the specification, the conflict should be identified rather than silently normalized.

---

# 57. Documentation Structure

The repository should eventually contain:

```text
docs/

    README.md

    product/
        overview.md
        requirements.md
        roadmap.md

    architecture/
        overview.md
        offline-first.md
        synchronization.md
        security.md

    domain/
        products.md
        inventory.md
        sales.md
        customers.md
        suppliers.md
        finance.md
        reports.md

    database/
        schema.md
        migrations.md

    api/
        authentication.md
        synchronization.md
        endpoints.md

    adr/
        ADR-001-offline-first.md
        ADR-002-sqlite.md
        ...
```

This documentation becomes part of the project's engineering infrastructure.

---

# 58. Initial Database Domain Model

At a high level:

```text
Organization
    │
    ├── Branch
    │
    ├── User
    │
    ├── Device
    │
    ├── Product
    │      └── Category
    │
    ├── Inventory Movement
    │
    ├── Customer
    │      └── Customer Transaction
    │
    ├── Supplier
    │      └── Supplier Transaction
    │
    ├── Sale
    │      └── Sale Item
    │
    ├── Purchase
    │      └── Purchase Item
    │
    ├── Payment
    │
    ├── Financial Account
    │
    ├── Expense
    │
    ├── Audit Event
    │
    └── Sync Event
```

This is intentionally a conceptual model.

The exact relational schema should be designed separately before implementation.

---

# 59. Critical Architectural Rule

The most important architectural principle of the entire system is:

> **Business events create immutable transactions; current state is derived from those transactions.**

For example:

```text
SALE
 ↓
Inventory movement
 ↓
Payment
 ↓
Customer transaction
 ↓
Financial effects
```

This allows the same underlying data to power:

```text
Inventory
POS
Customer balances
Cash balances
Profit reports
Audit logs
Synchronization
```

The system should avoid maintaining multiple independent versions of the same truth.

---

# 60. Long-Term Architecture

The eventual platform should look conceptually like:

```text
                    BUSINESS PLATFORM
                           │
          ┌────────────────┼────────────────┐
          │                │                │
      OPERATIONS        FINANCE          ANALYTICS
          │                │                │
     ┌────┼────┐      ┌────┼────┐      ┌────┼────┐
     │    │    │      │    │    │      │    │    │
   Stock Sales Purch. Cash Credit Exp. Sales Profit Trends
     │    │    │      │    │    │      │    │    │
     └────┴────┴──────┴────┴────┴──────┴────┴────┘
                           │
                    Transaction Engine
                           │
                    Synchronization
                           │
                    Cloud Platform
```

The mobile application remains the primary operational interface.

The cloud provides:

* Synchronization
* Backup
* Multi-device coordination
* Remote access
* Centralized reporting
* Future integrations

The system should remain useful even if the cloud is temporarily unreachable.

---

# 61. Product Philosophy

The product should optimize for **reliability, simplicity, and speed** rather than feature count.

A shop owner should not need accounting knowledge to use it.

A cashier should not need training in financial software.

A business owner should be able to open the application and immediately understand:

> What happened today?

> How much money came in?

> How much money went out?

> What do I have in stock?

> Who owes me money?

> What do I owe?

> Am I making money?

The complexity should exist inside the architecture, not in the user's workflow.

---

# 62. Definition of Success

The MVP is successful when a real shop can use the application for its daily operations while completely offline and then reconnect later without losing or duplicating transactions.

A successful system should allow a business owner to go from:

```text
Physical Shop
     ↓
Sales / Purchases / Expenses
     ↓
Application
     ↓
Reliable Transactions
     ↓
Inventory + Cash + Credit
     ↓
Reports
     ↓
Business Decisions
```

without requiring constant internet connectivity or complicated accounting knowledge.

---

# 63. Current Technology Decision

The accepted baseline as of 2026-10-05 (ADR-017–019):

| Layer | Choice |
|---|---|
| Mobile | React Native + Expo + TypeScript |
| Desktop | Electron + React + TypeScript |
| Shared business core | Strict TypeScript; pure rules plus explicit storage adapters |
| Local operational database | SQLite on every installed client |
| Optional server | Fastify + TypeScript, explicit PostgreSQL repositories |
| Server database | PostgreSQL |
| Exchange | Immutable versioned events; file/Bluetooth/HTTP transports |
| Product editions | Standalone mobile/desktop, hosted subscription, self-hosted server |
| Authentication | Local shop/actor authority; optional independent network sessions |
| API | Versioned HTTP; v1 migration reference, planned v2 server contract |
| Tooling | npm workspaces, Node 24 LTS, one root dependency lock |
| Currency / languages | XAF / FCFA, French / English |

Existing business/financial invariants remain unchanged. Accepted ADRs record explicit
changes to earlier baseline choices; changes require a new ADR. Read the implementation
plan and progress log before assuming a declared target has been implemented.
