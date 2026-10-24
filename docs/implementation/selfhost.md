# Running a kolo sync server

For whoever runs a server for one or more shops: self-hosted for your own shops (free, no account, no telemetry) or
hosted for paying customers ([ADR-031](../adr/ADR-031-hosted-subscriptions-manual-billing.md)). Tills never need the
server to trade; it only relays their encrypted facts ([ADR-030](../adr/ADR-030-end-to-end-encryption-and-connection-codes.md)).

## Install (Docker Compose)

```sh
export KOLO_DATABASE_PASSWORD=$(openssl rand -hex 24)   # keep it; the backup restores into the same database user
export KOLO_PUBLIC_URL=https://sync.example.com          # LAN only: http://192.168.1.20:8080 and KOLO_BIND=0.0.0.0
docker compose -f infrastructure/compose.selfhost.yml up --build -d
docker compose -f infrastructure/compose.selfhost.yml exec server node apps/server/dist/main.js admin create <you>
```

`admin create` prints a password (shown once) and an authenticator QR code. The server migrates before it serves.
Hosted operators also set `KOLO_EDITION=hosted` and, optionally, `KOLO_GRACE_DAYS` and `KOLO_BILLING_WEBHOOK_SECRET`.

| Variable | Default | Meaning |
|---|---|---|
| `KOLO_PUBLIC_URL` | required | Address tills use; printed into every connection code |
| `KOLO_BIND`, `KOLO_SYNC_PORT` | `127.0.0.1`, `8080` | Where the sync port is published on the host |
| `KOLO_ADMIN_PORT` | `8081` | Dashboard, always published on the host's loopback only |
| `KOLO_EDITION` | `selfhost` | `hosted` makes sync depend on payments |
| `KOLO_GRACE_DAYS` | `7` | Hosted: days of sync after the paid period |
| `KOLO_BILLING_WEBHOOK_SECRET` | none | Hosted: enables the signed payment webhook (32+ characters) |
| `KOLO_TRUST_PROXY` | `false` | `true` behind the reverse proxy below |
| `KOLO_ADMIN_TOTP` | `on` | `off` signs operators in with the password alone; refused unless the dashboard listens on loopback (not in the Docker image, whose dashboard listens on all container interfaces) |

## HTTPS

Anything beyond a LAN needs TLS. `infrastructure/Caddyfile.example` is a complete Caddy site: it obtains certificates,
exposes only the sync API, health checks and the payment webhook, and never the dashboard. Set
`KOLO_TRUST_PROXY=true` behind it. Payloads are signed and business facts are encrypted either way, but TLS hides
metadata and protects sessions.

## The dashboard

Open it on the server itself, or from your computer through SSH: `ssh -L 8081:127.0.0.1:8081 <server>`, then
`http://127.0.0.1:8081/admin/`. Codes, shops, suspension, removal, payments (hosted), health and the audit log are there.
A viewer account (`admin create <name> --role viewer`) can read but not change anything.

## Attaching a shop

Issue a code per shop (dashboard, or `… main.js invite --label "Shop" [--months 3] [--trial-days 7] [--tills 3]`) and
send it to the owner. They paste it on their main till; their other tills follow on their own. A code works once and
expires (7 days by default).

**Till limits (ADR-039).** A shop may sync at most `max_tills` tills (unlimited by default, and for every shop that
existed before the upgrade). A hosted code must name its limit or `unlimited`. A till trusted beyond the limit is held:
it keeps trading, but its sync is refused with `till_limit_reached` until the owner revokes a till or you raise the
limit (shop page, or `… main.js till-limit <shop id> <n>|unlimited`), which releases waiting tills oldest first.
Lowering a limit never stops enrolled tills. Staff are not counted. **Trial days** on a code (0–90) are recorded as a
`code` payment when the shop attaches, with any paid months; manual payments stay in whole months.

If an owner loses every till, they restore their latest backup on a new device with the printed backup recovery key
(or the file password), then connect it with an owner-recovery code: the dashboard's Recovery panel on the shop page,
or `… main.js invite --recovery-shop <shop id>`. That code attaches the new device to the existing shop once and never
creates a shop; facts synced after the backup then come back from the server (ADR-036).

## Backups and restore

```sh
infrastructure/backup.sh /secure/place               # database dump + server identity key, both needed
infrastructure/restore.sh /secure/place/kolo-…dump /secure/place/kolo-…server-key.json
```

`restore.sh` changes nothing until both files check out (the key loads the way the server loads it, the dump is a
`pg_dump` archive), restores into a staging database while the server keeps serving, and only then switches it in.
The replaced database stays as `kolo_previous_<time>` and the replaced key as `server-key.json.previous-<time>` in the
identity volume; the script prints the `dropdb` command to run once the restore is confirmed.

Back up daily and keep copies off the machine. The key file is a secret: whoever holds it can impersonate the server
(but cannot read shop data, which only tills can decrypt). Restoring an older backup is safe: tills keep every fact and
resend what the server is missing on their next pass. Verified 2026-10-11 by a drill: install, attach a till, sync,
back up, destroy every volume, restore, resync with nothing missing and the original fingerprint.

## Upgrades and rollback

1. Back up (above).
2. `git pull` (or fetch the new release) and `docker compose -f infrastructure/compose.selfhost.yml up --build -d`.
   The server applies forward-only migrations before serving; `/readyz` answers 503 `schema_outdated` until they have run.
3. To roll back, check out the previous release and restore the backup taken in step 1. Never run an older server on a
   newer schema: it refuses to start serving rather than guess.

A migration that would destroy data never runs silently: for example `0002` refuses to start while unencrypted F6a
business facts exist until the operator runs `migrate --discard-plaintext`.

## Helping a shop

Ask the owner for the "Support details" on the till's sync screen (desktop: Devices → Sync server; phone: Backup &
devices → Sync server). It holds the app version, server address and fingerprint, last success, last error, waiting
count and subscription status, and no keys, codes or business data. On the dashboard, the shop's page shows its tills,
when each was last seen, how many facts each still has to receive, conflicts and the current key epoch.

Common answers: `server_unreachable` (network or firewall), `hosted_service_inactive` (record a payment),
`shop_suspended` (resume it), `fingerprint_mismatch` (the till is talking to another server: stop and send a new code),
facts waiting for the owner's key (the owner's main till must sync once to grant the shop key to a new till).
