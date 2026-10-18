# Codebase review 1

Date: 2026-10-17

Scope: financial calculations, costing, data integrity, and backup and restore behavior in the current working tree, including uncommitted changes. Repository implementation files were not changed during the review.

## Findings

### 1. [P1] Server restore destroys existing data before validating its inputs

Reference: [infrastructure/restore.sh:11](infrastructure/restore.sh#L11)

Using mocked Docker commands, I confirmed that even a missing dump file triggers `dropdb` before the script fails. The key check only searches for `"private_key"`; it does not parse the JSON or validate the private key. A missing, unreadable, or damaged backup can therefore leave the deployment without its previous database and with the server stopped.

Restore into a temporary database, validate the dump and identity key, then switch over while retaining the previous database for rollback.

### 2. [P1] Sales use stale purchase costs, overstating profit

References: [apps/desktop/src/electron/application.ts:559](apps/desktop/src/electron/application.ts#L559), [packages/core/src/domain/pos/cart.ts:119](packages/core/src/domain/pos/cart.ts#L119)

Sales take their cost from the product's editable `purchasePriceMinor`, while inventory valuation prioritizes the latest costed purchase or opening-stock movement. Recording a purchase does not refresh the product's purchase-price field.

Reproduced: product cost 100 FCFA, subsequent purchase cost 600 FCFA, selling price 1,000 FCFA. The sale records a cost of 100 and reports 900 profit, while inventory correctly values the remaining unit at 600. Using the latest purchase cost would yield 400 profit.

Resolve and freeze the sale's cost using a shared costing policy at checkout, consistently across desktop and mobile. Preserve that historical cost for subsequent reports and returns.

### 3. [P1] Backups silently omit sync decryption keys when the vault fails

References: [packages/core/src/application/backup.ts:108](packages/core/src/application/backup.ts#L108), [packages/core/src/application/sealed-sync.ts:78](packages/core/src/application/sealed-sync.ts#L78)

Backup creation catches failures while collecting shop keys and proceeds with an empty key list. The underlying `shopKeys` function also skips individual grants that cannot be opened.

I injected a vault failure into a shop holding a sync key: backup creation succeeded with zero carried keys. After losing every till, the snapshot remains readable, but later encrypted server history may be unrecoverable without those keys.

Verify required key coverage before declaring the backup complete. Distinguish a shop that has never used encrypted sync from a failure to retrieve existing recovery material, and report incomplete recovery material explicitly.

### 4. [P2] Restore validation accepts logically corrupt financial data

Reference: [packages/core/src/backup/snapshot.ts:43](packages/core/src/backup/snapshot.ts#L43)

Restore validation checks SQLite integrity, foreign keys, schema, shop scope, and replay boundaries, but does not run the existing business consistency checks.

I added an extra sale stock movement. The existing integrity checker reported `sale_stock_mismatch`, yet backup creation and restore preview accepted the inconsistent snapshot. SQLite integrity, signatures, and hashes establish structural validity and authenticity, not accounting consistency.

Run the existing business consistency checks on the staged database after migration and before activation. Treat corruption findings separately from legitimate operational attention states such as pending or quarantined sync events.

### 5. [P2] Failed desktop exports leave incomplete files named as finished backups

Reference: [apps/desktop/src/electron/transfer-files.ts:72](apps/desktop/src/electron/transfer-files.ts#L72)

The export copies directly into the final destination filename. Its cleanup closes the destination and deletes the private temporary file, but does not remove an incomplete destination after a copy failure.

A simulated read failure left an empty `.kolo-backup` destination while deleting the private temporary copy. An interrupted copy or failed write can similarly leave a partial file that looks like a completed backup.

Write to a temporary sibling on the destination filesystem, sync it, then publish it atomically while preserving the existing no-overwrite behavior. Clean up failed copies.

## Arithmetic assessment

The arithmetic foundation is good: integer XAF amounts, BigInt intermediates, deterministic discount allocation, and cumulative rounding for partial returns. The main reproduced financial issue is inconsistent cost selection rather than the shared rounding primitives.

## Backup strategy and durability

Prioritize scheduled encrypted off-device copies, versioned or immutable retention, separately stored recovery secrets, and recurring full restore drills. A successful export or cryptographic verification alone does not prove that a shop can recover its financial records and resume encrypted sync.

Revisit the deliberate `synchronous=NORMAL` setting in [packages/core/src/data/database/node-sqlite.ts:94](packages/core/src/data/database/node-sqlite.ts#L94) and the equivalent native SQLite adapter. It permits loss of acknowledged transactions after power failure. This is a documented durability tradeoff, rather than an accidental implementation defect, but deserves an explicit decision for a financial ledger.

## Validation and limitations

- Ran `npm run test -w @kolo/core`: all 55 test files passed.
- Reproduced stale sale costing, omitted sync recovery keys, and acceptance of an inconsistent backup using temporary scripts and real SQLite databases.
- Verified destructive restore command ordering using mocked Docker commands; no live deployment was changed.
- Reproduced an incomplete desktop export destination using a simulated source read failure.
- Did not run a live PostgreSQL restore or physical-device power-loss tests.
- This was a focused financial and recovery review, not an exhaustive audit of every application or security boundary.
