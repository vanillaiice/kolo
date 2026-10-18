# Codebase review 2

Date: 2026-10-17

Scope: current working tree, including uncommitted changes. Rechecked all five findings in [review-1.md](review-1.md), then examined event replay, encrypted server sync, device enrollment, and platform transfer adapters. No implementation files were edited.

## New findings

### 1. [P1] Catalogue price changes quarantine valid sales during replay

Reference: [packages/core/src/data/exchange/apply.ts:87](packages/core/src/data/exchange/apply.ts#L87)

The receiver compares each sale's historical price with its current product price. A difference requires `sales.price_override` in the signed event's required permissions. An ordinary sale carries only the permissions needed when it was created, so a later catalogue change makes an authorized sale fail this check, even when the seller is the owner.

Reproduced with two real SQLite tills and signed journal batches:

1. Both tills know a product priced at 500 FCFA.
2. Till B changes its price to 600 FCFA while Till A continues trading at 500.
3. Till A completes an ordinary 500 FCFA sale and sends it to B.
4. A retains one sale; B retains zero sales and records the event as `quarantined / permission_denied`. Its signed required permissions are `["sales.create"]`.

The sale's stock and payment effects consequently remain absent on B. This affects file, local-network, and server imports because they share the replay implementation. Automatic retries leave the event quarantined; owner review is needed to apply it.

Bind replay validation to the catalogue version or price evidence used when the sale was created. Preserve explicit override authorization without inferring an override from a receiver's later catalogue state.

### 2. [P1] Encrypted history can permanently prevent a new till from receiving its key

References: [packages/core/src/application/server-sync.ts:263](packages/core/src/application/server-sync.ts#L263), [apps/server/src/sync/relay.ts:327](apps/server/src/sync/relay.ts#L327)

Every sync pass starts pulling at a null cursor and stops after a bounded number of pages. The server returns unacknowledged facts oldest first. A new till cannot open historical business facts until it receives its shop-key grant, and locked facts are neither stored nor acknowledged. When that grant sits beyond the page budget, each pass repeats the same unreadable prefix and never reaches the grant.

The defaults are 50 pages of up to 200 facts: a prefix of 10,000 unreadable facts is sufficient to block progress; byte-limited pages can lower the threshold. Pairing's snapshot does not eliminate this problem because it does not give the new device the source device's private encryption key or server delivery acknowledgments.

Reproduced against a temporary Fastify/PGlite server with real SQLite tills, using `batchSize: 2, maxPages: 1` to exercise the same boundary with a small history. The server held a valid grant for the new till at journal sequence 15. Four consecutive passes each returned two locked facts and left the till holding zero keys. Increasing only the page budget let it receive its key and import all five sales.

Deliver trust and key grants independently of the encrypted business backlog, or durably stage locked facts with scan progress and a retry mechanism. Merely increasing the page budget postpones the failure.

## Rechecked findings from review 1

All five remain open and were reproduced again against the current implementation.

| Original finding | Status and current evidence |
| --- | --- |
| **1. [P1] Destructive server restore before validation** | Confirmed at [restore.sh:11](infrastructure/restore.sh#L11). With Docker replaced by a command logger, a missing dump and JSON containing an invalid private-key string still invoked `stop server`, `dropdb`, and `createdb` before the missing-file failure. No real Docker operation ran. |
| **2. [P1] Stale purchase costs overstate sale profit** | Confirmed through the actual [desktop checkout](apps/desktop/src/electron/application.ts#L559). Product cost 100, delivery cost 600, selling price 1,000: the sale froze cost 100 and reported profit 900, while the remaining inventory unit was valued at 600. The [mobile cart](packages/core/src/domain/pos/cart.ts#L119) still takes the product purchase-price field too. |
| **3. [P1] Backup succeeds without sync recovery keys after vault failure** | Confirmed at [backup.ts:109](packages/core/src/application/backup.ts#L109) and [sealed-sync.ts:78](packages/core/src/application/sealed-sync.ts#L78). Created and successfully opened a real shop-key grant, then made vault agreement fail. Backup creation succeeded; its decrypted, signed manifest carried zero shop keys despite the existing grant. |
| **4. [P2] Snapshot validation accepts inconsistent business records** | Confirmed at [snapshot.ts:58](packages/core/src/backup/snapshot.ts#L58). Added an extra sale stock movement in a disposable database. `checkIntegrity` reported `sale_stock_mismatch` with severity `corruption`; encrypted backup creation and restore preview both succeeded. |
| **5. [P2] Failed desktop export leaves a completed-looking destination** | Confirmed at [transfer-files.ts:72](apps/desktop/src/electron/transfer-files.ts#L72). Truncated the prepared source after the save dialog opened to force an unexpected end of file during copying. The operation failed, deleted the private temporary file, and left a zero-byte `.kolo-backup` at the final destination. |

The proposed remedies in review 1 still apply: stage and validate server restores before switching; share a sale-costing policy; fail or explicitly report incomplete sync recovery material; run business consistency checks on staged snapshots; and publish exports atomically from temporary destination files.

## Validation and limits

- `npm run typecheck`: passed across the workspace.
- Contracts, core, CLI, mobile, server, and desktop test suites: passed. Core reported 55 passing test files; server reported 31 passing tests; desktop reported 68 passing tests inside Electron.
- Server tests used PGlite behind its PostgreSQL wire-protocol listener. Server and desktop networking tests required loopback access outside the restricted sandbox; their reruns passed.
- Additional disposable reproductions covered both new findings and all five original findings. Cryptographic and database paths used real implementations; the destructive restore check used mocked Docker commands.
- The key-delivery reproduction used a reduced page budget, not a default-size 10,000-event load. The default threshold follows from the same loop and query bounds.
- No production database, live deployment, or physical mobile device was tested. Passing suites do not cover the reproduced failures above.
