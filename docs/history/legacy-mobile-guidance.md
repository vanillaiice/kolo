# apps/mobile/CLAUDE.md

Guidance for the React Native client. The repository root `CLAUDE.md` holds the rules that apply everywhere; this file loads when working under `apps/mobile/`.

## The data layer

`apps/mobile/src/data/`: the client's SQLite layer (ADR-002, ADR-014). Migration 7 adds `customers` and their `customer_transactions`, migration 13 adds `suppliers`, `supplier_transactions`, `purchases` and `purchase_items` (all append-only by SQLite trigger exactly as the server's are), and migration 14 adds `device_session`, the one row that says who this till is:

- `database/`: a deliberately narrow driver interface, a `node:sqlite` adapter for tests, and forward-only migrations that catch a device up across any number of versions
- `auth/session.ts`: who this till is, and what it holds to prove it (ADR-012). The *record* of being enrolled is a row in SQLite, where a screen can read it while drawing; the **token is in the platform keystore** (§37), because it is the one thing on the device that is a credential rather than a record; everything else in `kolo.db` describes what happened, while the token lets its holder act as this till. `enrol` writes the token **first** and the rows second: the other order would leave a device that looks enrolled and cannot authenticate, a till that appears to work and whose every sync is refused. `signOut` reverses it (row first) and **keeps the business data**, because a till may hold a day of sales that have not reached the server and signing out is not a decision to discard them. Two things are refused outright: a second business on a device that already holds one (ADR-008: interleaved tenants cannot be separated afterwards), and a business that does not trade in XAF, since nothing above this layer carries a currency and storing it would relabel every price rather than convert it
- `auth/secure-store.ts` and `auth/store-on-device.ts`: the keystore, taking the native module as an **argument** exactly as `expo-sqlite.ts` does, so the claim "expo-secure-store's API looks like this" is compile-checked at one call site and everything above is testable under Node. An error names the key and never the value: an error that reached a log carrying the token would defeat the point of storing it there
- `auth/login.ts`: the one thing in the app that needs the network. §4 enumerates what must work offline and first login is deliberately not among it: PIN hashes never leave the server (ADR-012), so a device that has never spoken to it has nothing to check a PIN against. The transport is an interface for the reason the sync engine's is: what happens when the server refuses, or cannot be reached, is the part worth testing. Refusals come back as **codes, never prose**, because the screen speaks French and English (§44), and a code this build has never seen is reported as the server's problem rather than guessed at. `logIn` presents the device identity this installation was already given, including across a sign-out: a till that registered itself again on every shift would spread one shop's history across a dozen device identities (§28)
- `sync/outbox.ts`: the queue of events waiting for the server. **A business write and its event commit in one transaction, or neither does.** `enqueue` takes a transaction, not a database, so it cannot be called on its own
- `inventory/movements.ts`: recording stock on the device. Every write records the movement and queues its event together; the ledger is append-only here too, enforced by SQLite triggers, and stock is derived by SQL sum
- `sync/inbox.ts`: the mirror of the outbox: events pulled from other devices, **stored durably before they are applied**. An event can arrive before what it depends on (a movement before its product), so arrival advances the cursor and applying is retried on later syncs. One holds what has not left, the other what has not landed
- `sync/transport.ts`: the HTTP contract plus an implementation. The engine takes the interface, so its failure behaviour is testable without a network
- `sync/engine.ts`: drains both queues. An event leaves the outbox only when the server says it has it; anything else keeps it queued. A rejection is set aside rather than retried forever, since retrying blocks everything behind it
- `sync/stock-applier.ts`: applies a pulled `STOCK_MOVED` to the local ledger, `INSERT OR IGNORE` on the movement ID so re-applying cannot double stock
- `sync/product-applier.ts`: applies a pulled `PRODUCT_SAVED`, which is what unblocks movements deferred waiting on their product
- `customers/customers.ts`: customers on the device. Their details are state and settle by last-write-wins; what they owe is `balanceOf`, a SQL sum over the ledger and never a column. `recordCustomerPayment` appends a payment against the *account*, not against a sale; a regular's debt is a fortnight of small buys, and asking which one the 5,000 pays off invents a question the shop does not ask. `wouldExceedCreditLimit` is a question, not a rule this layer enforces
- `sync/customer-applier.ts`: applies a pulled `CUSTOMER_SAVED`, which is what unblocks a credit sale deferred waiting on its customer
- `sync/payment-applier.ts`: applies a pulled `CUSTOMER_PAYMENT`, appending it: two tills each taking a payment is two payments, and both stand
- `finance/accounts.ts` and `sync/account-applier.ts`: accounts on the device, settled by last-write-wins. Opening Orange Money on a phone is what puts it on every till at the next sync
- `finance/cash.ts` and `sync/cash-applier.ts`: money moved by hand (§18): the float, cash to the bank, transfers, the correction after a count, and the cash handed to a delivery driver. `balanceOfAccount` is the **five**-source sum; `reconcile` sets a count against it. The signs differ on purpose: a customer's `PAYMENT` is negated into the account (less debt means more cash), a supplier's is taken as stored (less debt *because* the money left)
- `expenses/expenses.ts` and `sync/expense-applier.ts`: what the business spent that is not stock (§19), undone by a reversal rather than an edit
- `reports/reports.ts`: §21's reports and §22's dashboard, every figure a query over transactions and none a stored total. Periods are **half-open** and sliced by when business happened, so days tile without double-counting and last week's takings do not change when a device syncs late. What customers owe and what the shop owes wholesalers are **two figures, never netted**: an owner with 80,000 out on credit and 80,000 owed to a supplier is not square, because one arrives when customers choose to pay and the other falls due when the van comes back
- `inventoryValuation` in `reports.ts`: what the shelves are worth (§8). Stock is valued at the **latest purchase cost**: the unit cost on the most recent `PURCHASE` movement, which reads as replacement cost. The method is named (`CostingMethod`) and its SQL lives in one `COST_OF` map, because §8 requires FIFO and weighted average to be addable later; adding one is a case in that map, not a rewrite of the report. Three things it deliberately does **not** do: read the product's `purchase_price` column (a field someone edits, not a fact from the ledger); value uncosted stock at zero (that is reported as `uncosted`, an honest gap; stock from before the system is not free); or hide stock below zero (two devices selling the last unit offline is expected, and the negative total is the one figure that reveals it). The cost comes from movements that brought stock **in**, never from the cost recorded on a sale line, which is a later movement that would otherwise win
- `fastMoving`/`slowMoving`/`deadStock` in `reports.ts`: §21's movement reports. Ranked by **quantity, not takings**: a cheap thing that shifts daily is fast-moving even though one generator outsells a year of it. The ranking is built from a scan of *products* with correlated subqueries, never a join from sale lines, because the products that sold **nothing** are the whole point of the slow end: "these sold least" and "these did not sell" are different questions and only the second is worth attention. `deadStock` is the actionable version: stock **on hand** that sold nothing since a date, valued at latest purchase cost. A product that sold out is finished rather than dead, and one nobody stocks is not dead either
- `salesByCategory`, `cashFlow`, `customerStatement`, `customerPurchases` in `reports.ts`: the rest of §21. A category is joined **through the product**, never copied onto the sale line, because moving a product between categories has to move its history with it, the opposite of why a line's name and price are copied, which is that a receipt must show what was charged. `cashFlow` reports in and out **apart, never netted** ("took 400,000 and paid out 380,000" and "took 20,000" are different days), and its `CASH_SOURCES` must stay the same five arms `balanceOfAccount` sums or the report will not reconcile with the balance beside it. `customerStatement` runs the balance down **in the order things happened**, so an entry synced late reads as the customer experienced it
- `products/products.ts`: products on the device, with the last-write-wins upsert. A losing edit is a `false` return, never an error
- `sales/sales.ts`: **the POS fan-out** (§9). `completeSale` writes the sale, its lines, the stock they released, the payments, the customer ledger entry for anything left owing, and the outbox event in one transaction. `totalsOf` is exported so a till shows a running total from *this* arithmetic; a second implementation in the UI is how the screen comes to disagree with the receipt. `subtotalOf` is exported for the same reason, so the applier that receives a sale from another till works out the debt the way the till that sold it did
- `suppliers/suppliers.ts`: wholesalers on the device (§14, §16), the mirror of `customers.ts` and kept apart from it deliberately: what a customer owes the shop and what the shop owes a wholesaler are opposite obligations, and one table with a sign would make it possible to settle a customer's debt with a supplier's payment. Details are state and settle by last-write-wins; what is owed is `balanceOfSupplier`, a SQL sum and never a column. `recordSupplierPayment` appends against the *account*, not against a delivery, for the reason a customer's payment is
- `purchases/purchases.ts`: **the delivery fan-out** (§15), a sale upside down. `recordPurchase` writes the purchase, its lines, the stock they brought in, the money handed over at the door, the supplier ledger entry for anything still owed, and the outbox event in one transaction. `totalsOfDelivery` is exported so a screen shows a running total from *this* arithmetic. **The money handed over is an `account_movements` row, not a supplier ledger entry**: a crate bought at the market names no wholesaler and so has no ledger for it to go in, but the cash still left the drawer
- `sync/supplier-applier.ts`: applies a pulled `SUPPLIER_SAVED` (last-write-wins, so one edit lands) and `SUPPLIER_PAYMENT` (appended, so both devices' entries stand). Both in one file because the contrast is the point: resolving the second the way the first is resolved would silently drop a payment somebody actually made
- `sync/purchase-applier.ts`: applies a pulled `PURCHASE_RECORDED`, `INSERT OR IGNORE` throughout so a replay cannot double stock, cash, or a debt. What is owed is worked out here by the same arithmetic the sending device used, never read from the wire
- `sync/sale-applier.ts`: applies a pulled `SALE_COMPLETED`, `INSERT OR IGNORE` throughout so a replay cannot double a day's takings or a customer's debt. A sale for a customer this device has never seen is **deferred, not dropped**: the debt waits for the customer rather than being lost

`purchases.test.ts` asserts the exact set of keys every payload carries, and `wire_contract_test.go` on the server feeds the literal bytes this client emits through the real decoder. That pair is the only thing standing between a field added on one side and a silent one-way sync: the server refuses a payload with a field it does not know, so the whole client stops syncing. Identifiers are **drawn, never composed**: every one is parsed as a UUID on arrival (ADR-011), so a movement identifier derived from a line's would have the event rejected with the delivery already on the till.

Line totals are `price × quantity / 1000` rounded **half away from zero**, matching the server's `MulRatio(..., RoundHalfUp)` exactly. `Math.round` is wrong here: it breaks ties toward positive infinity, so it would agree today and diverge the moment a negative line existed. A device and a server that round differently disagree by a franc a line and nobody can say which is right.

## Above the data layer

`apps/mobile/src/domain/`: the rules a screen needs, with **no React in them**
(ADR-004). They run under Node against real SQLite, so they are tested without a
device, and a second screen cannot grow a second answer to the same question.

- `domain/pos/cart.ts`: the rules of a cart. A cart being filled is *transient
  UI state* and belongs in a `useReducer` on the till screen, so these are pure
  functions from a cart to a cart. `view()` **never throws**: a cart is supposed
  to be invalid while it is being filled, and a till that threw at a cashier who
  had scanned one item would be unusable; it returns `problems` instead, as
  codes rather than sentences, because the till speaks French and English (§46).
  The running total comes from the data layer's own `subtotalOf`, never a second
  implementation. `complete.test.ts` proves the seam in both directions: what
  `toCart` builds is something `completeSale` accepts, and every cart the till
  calls complete is one the data layer will write
- `domain/auth/login-form.ts`: what counts as a fillable-in login form. It
  checks nothing about a credential: the PIN is verified by the server and
  nowhere else, and what this prevents is spending a round trip (over a link
  §45 assumes is slow and expensive) on something that cannot possibly be
  right. The PIN's *length* matches the server's `auth.ValidatePIN`; its
  weak-PIN rules deliberately do **not**, because those exist for the moment a
  PIN is chosen, and applying them at login would tell somebody their PIN is
  too simple when what they need to hear is that it is wrong.
  `normaliseBusinessId` is forgiving about how an identifier was typed and
  strict about what it is: the business code is the one UUID a person ever
  types, copied off a slip of paper, so capitals, spaces and rubbed-out dashes
  all name the same shop, and anything else is refused here rather than after
  a round trip
- `domain/money.ts`: turning amounts into what a shopkeeper reads. **XAF has no
  subunit**, so formatting is grouping digits, never placing a decimal point.
  Grouping is done by hand rather than with `Intl`, because the JS engine on
  cheap Android may ship without full ICU and the failure mode is not a crash:
  it is a price that reads differently on the owner's phone than on the till.
  Parsing is the dangerous direction and is deliberately strict: a comma is read
  as *grouping* only when the digits fall where grouping puts them, so "1,000"
  is a thousand while "100.5" is refused rather than silently becoming 1,005
- `data/products/products.ts` also carries `searchProducts`, §46's POS path: an
  exact barcode first (a scanner types the whole code), then SKU, then a name
  starting with the term, then one containing it. The leading-wildcard arm
  cannot use an index and that is accepted for it alone; FTS5 is the next step
  and that function is where it goes

## The app

`apps/mobile/src/app/`, `features/`, `components/`: the shell, per ADR-004's
§33 structure. Expo SDK 57, React Native 0.86.2, React 19 (ADR-016).

- `index.ts` registers the root component and does nothing else
- `app/config.ts`: where the server is, and nothing else. Read from
  `EXPO_PUBLIC_API_URL` at build time, so a build for a real shop changes no
  code. Deliberately **not** a field on the login screen: a "server address"
  box is one somebody can be talked into changing, and what they would be
  handing over is the shop's whole book
- `app/App.tsx` opens the database **once** and passes the handle down. A screen
  that could open its own would eventually open a second, and two connections
  mean a write in one is invisible to a read in the other until it commits:
  which on a till reads as a sale that did not happen. It draws the four states
  a device is actually in: opening, failed, not enrolled (the login screen), and
  trading. A spinner that never resolves is what a failed migration looks like
  when the failure has nowhere to go. The keystore handle and the auth transport
  are built **once**, with `useMemo`, so a re-render cannot hand a screen a new
  one mid-login
- `features/auth/LoginScreen.tsx`: enrolling the device (ADR-012), and the only
  screen that needs the network. It validates nothing itself: what counts as a
  fillable-in form is `domain/auth/login-form.ts`, and the server's refusal
  codes are turned into French here. A wrong number and a wrong PIN read the
  same, which is the server's rule and not one this screen may soften; telling
  somebody their number is registered would make login a way to discover who
  works here
- `app/dev-seed.ts`: **scaffolding, meant to be deleted.** A demo shop so the
  till can be developed with no server. What keeps it alive is the other half of
  login: there is no way yet to create a business, a user and a PIN on the
  server, so a developer with a real login screen has nothing to log in *to*.
  Guarded four ways so it cannot become production: only when there is no
  business at all, only under `__DEV__`, off when `EXPO_PUBLIC_DEMO_SHOP=0`
  (which is how the login screen is reached on a development build), and it
  writes nothing to the outbox and **no token**: a demo shop that synced would
  put a fictional business on somebody's server. Its stock arrives by opening
  `ADJUSTMENT` rather than a purchase, because nobody bought it, and inventing a
  delivery would put a fictional cost into §8's valuation
- `features/pos/PosScreen.tsx`: the till (§9). It **does no arithmetic**: every
  figure comes from `domain/pos`, which gets it from the data layer's own
  `subtotalOf`, the same function that writes the receipt. It holds no business
  data in React state; search reads SQLite on each keystroke, because a
  catalogue copied into memory is stale the moment another till sells something.
  The search box submits on enter and keeps focus, which is what a **hardware
  scanner** needs: §33 requires the POS to work with a scanner and no camera, and
  a scanner is a keyboard that types a barcode and presses enter. The payment
  buttons are the shop's **own** financial accounts, read from SQLite: which
  accounts exist is the shop's decision, and opening Orange Money is a row
  rather than a release (§10). A till that has just enrolled has none until it
  syncs, and says so rather than showing an empty row of buttons
- `components/theme.ts`: the few visual decisions shared everywhere. `type` is
  annotated as `TextStyle` rather than inferred, because an `as const` makes
  `fontVariant` readonly and React Native wants it mutable

### Versions are pinned by Expo, not by us

Expo SDK 57 bundles **React Native 0.86.2** and `@types/react` **~19.1**, and
both matter. Installing `react-native@latest` gives 0.87, whose package layout
`@expo/metro-config` cannot bundle (`rn-get-polyfills` moved); `@types/react@19.2`
breaks `FlatList` as a JSX component. `node_modules/expo/bundledNativeModules.json`
is the list to consult, since `expo install --check` needs the network.

### One collision to know about

Expo Router claims a directory named `app/`, and ADR-004's structure puts one at
`src/app/`. `expo export` says so on every run. It is harmless today because
`expo-router` is not a dependency and `package.json` names `index.ts` as the
entry, but installing `expo-router` would make it start routing our shell.

## Running the app

`npm run bundle` builds it with Metro and is the check to run after touching the
shell: it catches what `tsc` cannot, which is whether every import *resolves*.
`npm start` needs a dev build on a device; `npm run prebuild` generates the
Android project.

**Nothing here has run on a device.** It bundles, it typechecks against the real
`expo-sqlite` and `expo-secure-store` types, and its logic is tested, but
neither native module has ever been loaded, and ADR-016 says plainly that only
running it proves that. The keystore is the newer of the two unknowns: a device
with no screen lock, or a user who clears the app's data, are cases only a
device will show.

`data/database/expo-sqlite.ts` takes the native handle as an **argument** rather
than importing `expo-sqlite`, and `open-on-device.ts` is the one file that passes
the real one in. That is what lets the adapter's transaction nesting, its
`null`-to-`undefined` translation and its error wrapping be tested against real
SQLite with no device, and it is what caught two genuine incompatibilities the
moment the package landed: `expo-sqlite` **cannot bind a `bigint`** (its
`SQLiteBindValue` has no such member, while our `SqlValue` does), and its bind
arrays are mutable. Both appeared as a compile error on one line instead of
being spread through the file. The adapter now converts at that boundary and
**refuses** a bigint too large to convert exactly, rather than truncating one.

The data layer is plain TypeScript so it runs under Node; React Native types
arrive with the screens.
