# Offline CLI

The `@kolo/cli` workspace provides step 1 of the command-line tooling: offline
reports, exports, support checks and isolated development shops. It requires the
repository's Node 24 version and has no Electron dependency.

From the repository root, run `npm run kolo -- --help`. This builds the shared
packages and CLI. For repeated commands, build once:

```sh
npm run build:packages
npm run build -w @kolo/cli
node apps/cli/dist/main.js --help
```

After `npm install` and the build, the workspace's `kolo` binary is also available
through `npm exec -- kolo --help`.

## Reports and exports

Use a standalone, consistent SQLite copy taken while the app was closed, a
SQLite backup made by tooling that understands WAL, or an encrypted shop backup.
Copying only the `.db` file while the app is running can omit committed data.
The CLI rejects paths with `-wal` or `-shm` companions, copies the input into a
private temporary directory, and opens that copy read-only without migrations.
It never selects a desktop workspace or reads the OS credential vault.

```sh
npm run kolo -- report sales --db shop-copy.db --from 2026-01-01 --to 2026-02-01
npm run kolo -- report inventory --db shop-copy.db
npm run kolo -- export products --db shop-copy.db --format csv --out products.csv
npm run kolo -- check --db shop-copy.db --stuck-hours 24
```

Reports use the same core queries as the apps. Available reports are `sales`,
`profit`, `purchases`, `inventory`, `cash`, `customers` and `suppliers`. Periods
use UTC, with an inclusive start and exclusive end; omitting the dates includes
all history. `--business ID` selects a shop when a copy contains multiple shops.
Amounts remain integer minor units and quantities remain thousandths.

Exports support explicit business tables listed in `--help`, as JSON or CSV.
Credential references, device keys and server sessions are excluded. CSV quotes
fields and neutralizes formula-like text for spreadsheet consumers. JSON retains
the original values. Output goes to stdout unless `--out` is supplied. Files use
exclusive creation and owner-only permissions; existing files are never replaced.

`check` reports SQLite integrity and foreign key failures, sale/purchase stock
ledger mismatches, cross-shop references, missing journal application records,
invalid origin sequence counters, quarantined/unsupported events, old pending
application/delivery states, and rejected or retried old outbox entries. Negative
stock is valid offline business history and is not treated as corruption.
Old delivery entries can reflect a peer being offline; the command reports them
for investigation. It does not repair or retry anything. An older/newer copy's
schema is reported as unsupported; it is never upgraded in place.
Reports and exports require this CLI's current schema. For an older shop, use
`--backup` to validate and migrate an encrypted backup in temporary storage, or
`kolo backup decrypt` to create an updated SQLite copy. A newer schema requires
an updated CLI. Schema errors include both the detected and required versions.

## Backups

Supply the backup password through `KOLO_BACKUP_PASSWORD` or a single-line
`--password-file` (maximum 4 KB, including the trailing newline). Passwords are
not accepted as command-line arguments. Offline commands use the public
development password `kolo-fixture-2026` when neither is supplied, so freshly
generated demo and fixture backups open without additional setup. Explicit
passwords take precedence; empty supplied passwords are refused. Headless till
commands continue to require an explicit transfer password.

```sh
npm run kolo -- backup verify shop.kolo-backup.json --password-file /tmp/password
npm run kolo -- backup inspect shop.kolo-backup.json --password-file /tmp/password
npm run kolo -- backup decrypt shop.kolo-backup.json --password-file /tmp/password --out shop-copy.db
npm run kolo -- report profit --backup shop.kolo-backup.json --password-file /tmp/password
```

`verify` and `inspect` both authenticate encryption, the snapshot digest and
signature, schema, SQLite integrity, scope, foreign keys and replay boundary,
then emit the verified shop name, owner, schema version, creation time and event
count. Core backup validation may migrate the private staging candidate. Decrypt
writes that validated candidate as a standalone SQLite image; it never activates
or restores a desktop shop. Report, export and check accept `--backup` in place
of `--db`. Temporary files are removed after success or failure. Transfer sizes
are bounded by core's large transfer profile.

## Demo and performance fixtures

```sh
npm run kolo -- demo --out demo.kolo-backup.json
npm run kolo -- backup inspect demo.kolo-backup.json
npm run kolo -- report sales --backup demo.kolo-backup.json
npm run kolo -- fixture --products 10000 --sales 2000 --days 90 --seed 42 --out fixture.kolo-backup.json
```

Both commands create a new temporary shop, use an in-memory credential store,
and run setup, product creation, opening stock and paid sales through core's
permission-checked, audited operations. They produce a signed encrypted backup
that desktop or mobile can restore, plus a JSON generation summary including
elapsed milliseconds. All generated credentials and private keys are discarded.
Restoration requires choosing a fresh owner code in the app.

Demo defaults to 50 products and 500 sales; fixture defaults to 10,000 products
and 2,000 sales. `--products`, `--sales` (including zero), `--days`, `--seed` and
`--name` configure either command. Business history starts on 2026-01-01. The
seed repeats catalogue prices and sale choices; UUIDs and cryptographic material
remain fresh. The public default development backup password is
`kolo-fixture-2026`; override it with the same password options as inspection.
Generation prints this public default in its JSON summary when it is used.
Custom passwords are never printed.
Generation seals events in bounded batches; sizes remain subject to core's
snapshot limits. Existing desktop demo/mobile benchmark scripts remain
available for their richer scenarios and device-specific performance checks.

Exit codes: `0` success, `1` check findings or unresolved sync/import outcomes,
`2` invalid input or command failure. Live operations use the separately paired
headless till below.

## Headless till

`kolo till` runs a separately paired device. Its `--state` directory contains its
own SQLite workspace and signing/encryption identities. `init` accepts a new or
empty directory, and other commands require the CLI's state marker. A desktop
workspace cannot be selected with `--state`. The headless till uses the same
pairing, authorization, event signing, auditing and sync operations as the apps.

```sh
npm run kolo -- till init --state ./automation-till
npm run kolo -- till --help
```

The state directory uses mode 0700. Its native keys and credential records are
AES-GCM encrypted under a dedicated 0600 `vault.key` file. Access to this directory
controls access to this till's identity. The local password/code is supplied via
`KOLO_TILL_SECRET` or `--secret-file`, independent of the owner's desktop code.
On POSIX, group/world-readable state directories, keys and credential files are
rejected; on Windows, access follows the directory's Windows ACL. Keys never
enter SQLite or exports. Each command takes an exclusive `process.lock`; a second
command fails while one is running. After a crash, verify that the previous
process has stopped before removing that lock manually.

### Pair through files

On the owner's app, create an invitation. Compare its fingerprint through the
normal independent channel, then request pairing:

```sh
kolo till pair inspect owner.kolo-invite.json
kolo till pair request owner.kolo-invite.json --state ./automation-till --fingerprint VERIFIED_HEX --label Automation --secret-file /secure/till-secret --out request.kolo-request.json
```

Give the request to the owner, compare the displayed verification code, and have
the owner approve and save the encrypted enrollment file. Complete enrollment
using that same verified code and the enrollment password:

```sh
kolo till pair complete approved.kolo-enrollment.json --state ./automation-till --code VERIFIED_CODE --password-file /secure/transfer-password
kolo till status --state ./automation-till
```

Enrollment installs a fresh device identity, with the authority capability chosen
by the owner in the invitation. Core pairing currently uses the shop owner's
membership on the new till, with a new local credential; it does not create a
separate automation staff role. Business writes still check that membership's
current permissions and device trust. Authority changes reach the till through
normal sync. `kolo till pair cancel --state DIR` abandons a pending enrollment.

### Join through the server

The owner opens **Join** in the app and shares its join link. Inspect, request,
then poll completion after the owner presses **Allow**:

```sh
kolo till join inspect 'kolo://join?...'
kolo till join request 'kolo://join?...' --state ./automation-till --label Automation --secret-file /secure/till-secret
kolo till join complete --state ./automation-till
```

A typed code also works: replace the link with the code and supply `--url` and
`--fingerprint` from the owner's server details. The server fingerprint is checked
before the code is used. Join mailbox details persist encrypted, so requests and
completion can resume across process restarts. Completion emits `{"pending":true}`
until approval arrives. Both paths reuse the existing signed, recipient-bound
pairing flow; CLI commands cannot approve themselves on the owner's desktop.

### Sync and exchange

Follow the owner's shared server address with `connect`, or supply its verified
`--url` and `--fingerprint` explicitly. Commands unlock only this CLI till.

```sh
kolo till connect --state ./automation-till --secret-file /secure/till-secret
kolo till sync --state ./automation-till --secret-file /secure/till-secret
kolo till peers --state ./automation-till --secret-file /secure/till-secret
```

Sync performs one bounded pass through the existing HTTP transport and encrypted
sync protocol. The owner must have published this till's trust and granted its
shop key before all business events can cross the server. Rejected, untrusted or
locked events produce exit code 1 and counts for investigation. Server sessions
end after the pass. `peers` lists destination IDs, servers and core diagnostics.

For disconnected shops, exchange encrypted bundles and signed receipts instead:

```sh
kolo till exchange export --state ./automation-till --destination PEER_ID --secret-file /secure/till-secret --password-file /secure/transfer-password --out updates.kolo-exchange.json
kolo till exchange preview received.kolo-exchange.json --state ./automation-till --secret-file /secure/till-secret --password-file /secure/transfer-password
kolo till exchange import received.kolo-exchange.json --state ./automation-till --secret-file /secure/till-secret --password-file /secure/transfer-password
kolo till exchange receipt --state ./automation-till --batch IMPORTED_BATCH_ID --secret-file /secure/till-secret --password-file /secure/transfer-password --out received.kolo-receipt.json
kolo till exchange acknowledge returned.kolo-receipt.json --state ./automation-till --destination PEER_ID --secret-file /secure/till-secret --password-file /secure/transfer-password
```

Bundle export sends a bounded batch; repeat with fresh output filenames and
exchange receipts until delivery is complete. Preview authenticates without
applying business facts. Import rechecks permissions and reports each outcome.
A receipt acknowledges only the exact signed event digests for its destination.

### Bulk imports

Imports accept bounded JSON documents with a unique lowercase UUID `id` and
1–10,000 `rows`. The ID names a job: rerunning the exact same document on this till
returns `duplicate: true`, while different content with the same ID is refused.
A synchronous batch is atomic; an invalid row or missing permission rolls back
all its writes. Deterministic event IDs and durable import plans recognize a
committed batch after interruption and finish missing signatures on retry.
Keep the state directory's `imports` metadata alongside its database and vault.

Product import creates or edits explicit product IDs:

```json
{
  "id": "0199b5b0-0000-7000-8000-000000000001",
  "rows": [
    {
      "id": "0199b5b0-0000-7000-8000-000000000002",
      "name": "Rice 25kg",
      "unit": "bag",
      "sellingPriceMinor": 18500,
      "purchasePriceMinor": 16000,
      "divisible": false
    }
  ]
}
```

```sh
kolo till import products catalogue.json --state ./automation-till --secret-file /secure/till-secret
kolo till import prices supplier-prices.json --state ./automation-till --secret-file /secure/till-secret
kolo till import stock adjustments.json --state ./automation-till --secret-file /secure/till-secret
```

Products require `id`, `name`, `unit` and `sellingPriceMinor` when new. Optional
fields are `purchasePriceMinor`, `barcode`, `divisible`, `minimumStock` and `active`.
Barcodes support up to 256 characters, matching the apps.
Existing fields omitted from an edit are preserved. Price rows require an existing
product `id` and at least one of `sellingPriceMinor` or `purchasePriceMinor`.
Stock rows require an existing product `id`, signed `quantityThousandths` and
`reason`; they append stock **adjustments**, not absolute counts or purchases.
Money uses integer minor units; quantities use integer thousandths. Duplicate
product IDs within a job and unsupported fields are refused. A product update
that loses to newer history rolls back the batch; sync and submit a new job ID.
Imports seal all committed events, then normal `sync` or file exchange delivers
them. Importing does not make a network connection itself.

### Scheduled exports

Use cron or a systemd timer to invoke the same bounded commands. Live product
exports and reports use core's permission-checked application queries:

```sh
kolo till export products --state ./automation-till --secret-file /secure/till-secret --out catalogue.json
kolo till report sales --state ./automation-till --secret-file /secure/till-secret --from 2026-10-01 --to 2026-11-01 --out october-sales.json
kolo till backup --state ./automation-till --secret-file /secure/till-secret --password-file /secure/backup-password --out shop.kolo-backup.json
```

Each scheduled output needs a fresh filename because files are never overwritten.
Sync first when the export should include the latest records from other tills.
Live product JSON uses core's product field names; reports use the same shapes as
offline reports. Other raw table exports remain available through offline copies
or encrypted backups. Headless backups follow core's normal sanitized backup
policy and can be verified with `kolo backup verify`.
