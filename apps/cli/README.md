# KOLO CLI

Offline reports, exports, backup tools and demo fixtures, plus a separately paired
headless till for imports and sync. Requires Node 24.16+ (24.x) and npm 11.
Run commands from the repository root after `npm ci`:

```sh
npm run kolo -- --help
npm run kolo -- till --help
```

The wrapper builds the CLI each time. For repeated use, build once and run
`node apps/cli/dist/main.js` or `npm exec -- kolo`.

## Offline tools

```sh
npm run kolo -- report sales --db shop-copy.db --from 2026-10-01 --to 2026-11-01
npm run kolo -- export products --db shop-copy.db --format csv --out products.csv
npm run kolo -- check --db shop-copy.db
npm run kolo -- backup verify shop.kolo-backup --password-file /secure/password
npm run kolo -- backup decrypt shop.kolo-backup --password-file /secure/password --out shop-copy.db
npm run kolo -- demo --out demo.kolo-backup
npm run kolo -- fixture --products 10000 --sales 2000 --out fixture.kolo-backup
```

- Use a consistent SQLite copy taken while the app is closed or via SQLite's backup
  tooling. Files with WAL/SHM companions are rejected; the CLI reads a private copy.
- Reports, exports and checks also accept `--backup FILE` instead of `--db FILE`.
  Older backups migrate in temporary storage; raw SQLite copies are never migrated.
- Reports: `sales`, `profit`, `purchases`, `inventory`, `cash`, `customers`, `suppliers`.
  Dates use UTC, start inclusive and end exclusive; omitted dates include all history.
- Output defaults to JSON on stdout. Exports also support CSV; `--help` lists tables.
  Money uses integer minor units; quantities use thousandths.
- Backup passwords use `KOLO_BACKUP_PASSWORD` or `--password-file` (maximum 4 KB).
  Offline commands default to the public demo password `kolo-fixture-2026`.
- `check` reports integrity, ledger and delivery issues without repairing them.
  Demo/fixture commands create encrypted backups that the apps can restore.

## Headless till

A headless till has its own state directory, keys and local code. Pair it with the
shop before use; `--state` cannot point at a desktop workspace. Keep the whole
state directory, including its vault and import metadata.

For server pairing, the owner opens **Join** in the app and shares the join link:

```sh
npm run kolo -- till init --state ./automation-till
npm run kolo -- till join inspect 'kolo://join?...'
npm run kolo -- till join request 'kolo://join?...' --state ./automation-till --label Automation --secret-file /secure/till-secret
npm run kolo -- till join complete --state ./automation-till
```

Repeat `join complete` until the owner presses **Allow**. A typed code requires
`--url` and the verified server `--fingerprint`. Offline pairing uses `pair inspect`,
`pair request` and `pair complete`; see `till --help` for their required arguments.
Pairing uses the owner's membership with a new local credential.

```sh
npm run kolo -- till connect --state ./automation-till --secret-file /secure/till-secret
npm run kolo -- till sync --state ./automation-till --secret-file /secure/till-secret
npm run kolo -- till import products catalogue.json --state ./automation-till --secret-file /secure/till-secret
npm run kolo -- till report sales --state ./automation-till --secret-file /secure/till-secret --out sales.json
npm run kolo -- till backup --state ./automation-till --secret-file /secure/till-secret --password-file /secure/password --out shop.kolo-backup
```

Use `KOLO_TILL_SECRET` or `--secret-file` for the till's local code. Headless backup
and file exchange require an explicit `KOLO_BACKUP_PASSWORD` or `--password-file`.
`exchange` supports offline bundles and receipts; `export products` writes a live
catalogue. Cron/systemd can schedule these commands. Sync first for current peer data.
Commands take an exclusive state lock; output files are never overwritten.

### Import format

Imports accept JSON with a unique lowercase UUID job `id` and 1–10,000 rows:

```json
{
  "id": "0199b5b0-0000-7000-8000-000000000001",
  "rows": [{
    "id": "0199b5b0-0000-7000-8000-000000000002",
    "name": "Rice 25kg",
    "unit": "bag",
    "sellingPriceMinor": 18500
  }]
}
```

| Import | Row fields |
| --- | --- |
| `products` | New: `id`, `name`, `unit`, `sellingPriceMinor`. Optional: `purchasePriceMinor`, `barcode`, `divisible`, `minimumStock`, `active`. Omitted fields on edits are preserved. |
| `prices` | Existing product `id` and at least one of `sellingPriceMinor`, `purchasePriceMinor`. |
| `stock` | Existing product `id`, signed `quantityThousandths`, `reason`. Adds an adjustment. |

Batches are atomic. Repeating the same job on the same till returns `duplicate: true`;
reusing its ID with changed content fails. Imports stay local until sync or exchange.

Exit codes: `0` success, `1` check findings or unresolved sync/import outcomes,
`2` invalid input or command failure.

Licensed under [GPL-3.0-only](LICENSE).
