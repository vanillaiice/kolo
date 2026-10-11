# ADR-016: Expo, and the device's SQLite driver

**Status:** Accepted
**Source:** SPECIFICATION.md §32, §33, §46, §47, §63; ADR-002, ADR-004, ADR-014

## Context

ADR-004 fixes React Native and TypeScript, Android-first, and the directory
structure. It does not say how the app is built, and it does not name the SQLite
module the app runs against. Both were left open because neither mattered until
there were screens. There are about to be.

Two constraints decide it between them.

**The data layer's driver interface is synchronous.** `Queryable.run`, `.all`
and `.get` return values rather than promises, and `Database.transaction` takes
a function and runs it to completion. That was not an aesthetic choice: ADR-014
requires a business write and its outbox event to commit together, and a
synchronous transaction is what makes "everything in this function, or nothing"
expressible without a promise chain that a caller could accidentally break in
the middle. Around four hundred tests and every repository are written against
it. **A driver that only offers an asynchronous API is therefore not a driver we
can adopt**: adopting one would mean rewriting the whole data layer, not
writing an adapter.

**Devices are cheap Android hardware on bad connections.** §46 asks for fast
product search, fast POS and minimal startup delay. §45 assumes connectivity is
slow, intermittent and expensive, which also means a shop may go a long time
without visiting an app store.

## Decision

### The app is an Expo project, built with dev builds

Not the managed workflow's prebuilt client: the app needs native modules, so it
is a dev build (`expo prebuild` / EAS), which is Expo's supported path for
exactly that. What Expo buys is the Android build pipeline and `expo-updates`.

The second matters more than it looks. A shop on an expensive metered link that
never opens the Play Store is not going to receive a fix any other way, and a
bug in a till is a bug in a business's takings. An update channel is not a
convenience here.

What it costs is a layer between us and the platform, and an SDK upgrade cadence
to keep up with. That is accepted.

### The device's SQLite driver is `expo-sqlite`

Its synchronous API (`runSync`, `getFirstSync`, `getAllSync`,
`withTransactionSync`) maps onto our interface one method at a time, so the
device adapter is a thin file beside the `node:sqlite` one that tests already
use. Both run real SQLite, so the same SQL is exercised either way and only the
adapter differs. That is the same reasoning ADR-013 gives for testing the
server's repositories against a real PostgreSQL.

It is the lowest-dependency option that satisfies the synchronous constraint,
and it is maintained in step with the SDK we have just taken on.

## Consequences

* **The driver stays swappable.** `op-sqlite` is faster, and if a shop's data
  ever outgrows `expo-sqlite` it can be adopted by writing a second adapter
  against the same interface. Nothing above `database/` would change. The narrow
  interface in `driver.ts` is what buys that, and is worth keeping narrow.
* **Tests continue to run under Node, not on a device.** `node:sqlite` is real
  SQLite, so schema, constraints and queries are exercised for real. What that
  still does not cover is the native module itself; that needs a device, and no
  amount of Node testing substitutes for running the app once.
* **A synchronous driver is now a stated requirement**, not an accident of what
  was convenient. A future driver that offers only promises is disqualified on
  that basis alone, and this ADR is the place that says so.
* **`expo-updates` is a distribution channel, and channels carry risk.** Pushing
  a broken update reaches every till at once. Whatever release process is
  adopted has to account for that; it is not addressed here.
