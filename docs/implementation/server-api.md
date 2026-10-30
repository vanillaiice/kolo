# Optional server API

## Implemented (F6a relay, F6b sealed sync and connection codes, F6c operator dashboard)

Default development addresses: sync `http://127.0.0.1:8080`, operator dashboard `http://127.0.0.1:8081/admin/`.
The server relays signed facts between a shop's tills; it applies no business rules ([ADR-029](../adr/ADR-029-sync-server-relay.md))
and cannot read business records: every fact except trust, key and address facts arrives sealed with the shop key
([ADR-030](../adr/ADR-030-end-to-end-encryption-and-connection-codes.md)). Request and response schemas are the shared
`@kolo/contracts/sync`, `delivery` and `events` modules. Migrations are explicit (`npm run migrate -w @kolo/server`, or
`node apps/server/dist/main.js migrate`); sync and readiness answer 503 `schema_outdated` until they have run. Tests use
real PostgreSQL and real SQLite client replicas on an ephemeral listener.

| Method/path | Auth | Result |
|---|---|---|
| `GET /healthz` | None | 200 `{"status":"ok"}` if process is serving |
| `GET /readyz` | None | 200 `{"status":"ready"}` when PostgreSQL is reachable and migrated; otherwise 503 `database_unavailable`/`schema_outdated` |
| `GET /api/v2/capabilities` | None | API 2, exchange format 1, `sync` and `enrollment` true when ready |
| `GET /api/v2/server` | None | Server device ID, public key, 32-hex fingerprint, `enrollment_open` |
| `POST /api/v2/enrollment/challenges` | Strict rate limit | Single-use 2-minute challenge |
| `POST /api/v2/enrollment/complete` | Signed claim + single-use `connection_code` | 204; attaches the shop with its IDs and consumes the code in the same transaction. 403 `invalid_connection_code` (unknown, cancelled or missing), `connection_code_used`, `connection_code_expired`, `shop_suspended`/`shop_removed`; 409 `enrollment_conflict`; 401 `invalid_challenge`/`invalid_signature`. Re-enrolling from the enrolling device needs no code. An owner-recovery code (`connection_codes.recovery_business_id`, migration `0006_recovery`, ADR-036) instead attaches a new device of the shop's owner to that existing shop once, after a restore on a replacement till; it never creates a shop (403 `invalid_connection_code` when presented for a shop the server does not know, 409 `enrollment_conflict` for a different existing shop). |
| `POST /api/v2/auth/challenges` | Strict rate limit | Single-use session challenge |
| `POST /api/v2/auth/sessions` | Signature by an active device key | Bearer token (stored hashed), expiry; 401 `invalid_session` for unknown/revoked keys; 403 `shop_suspended`/`shop_removed` |
| `DELETE /api/v2/auth/session` | Token | 204, idempotent |
| `GET /api/v2/auth/me` | Token | Shop, device and server device IDs |
| `POST /api/v2/sync/push` | Token; `kolo.sync-batch` signed by the session device | Per-event results and a server-signed receipt (below) |
| `GET /api/v2/sync/pull?cursor=&limit=` | Token | Server-signed `kolo.sync-batch` of unacknowledged facts (default 100, max 1000), `cursor`, `has_more` |
| `POST /api/v2/sync/receipts` | Token; receipt signed by the session device | `{ "acknowledged": n }` |
| `GET /api/v2/sync/bootstrap` | Token | Owner-signed `DEVICE_TRUSTED`/`DEVICE_REVOKED` facts |
| `GET /api/v2/sync/status` | Token | This device's pending/delivered counts, shop conflicts and active devices |
| `GET /api/v2/entitlements` | Token | `{edition, status: unlimited\|active\|grace\|inactive, paid_until, grace_until}` ([ADR-031](../adr/ADR-031-hosted-subscriptions-manual-billing.md)); available even while sync is paused |
| `GET /api/v2/plan` | Token | `{max_tills, tills}` ([ADR-039](../adr/ADR-039-till-limits-and-trial-days.md)): the shop's till limit (null unlimited) and the tills holding a place; also while sync is paused. A till trusted beyond the limit is held and refused a session with 403 `till_limit_reached`; `POST /join` and its enrollment are refused the same way while the shop is full |
| `POST /internal/billing/webhooks/generic` | `x-kolo-signature: t=<unix>,v1=<HMAC-SHA256("<t>.<raw body>")>`, hosted with `KOLO_BILLING_WEBHOOK_SECRET` only | `{event_id, shop_id, months, amount_minor, method, reference?}` → 201 recorded, 200 `duplicate` for a repeated event; 401 `invalid_signature`/`stale_signature`, 409 `payment_conflict` |

On a hosted server, push, pull, receipts and bootstrap answer 403 `hosted_service_inactive` once a shop's paid period
and grace have ended; stored facts are kept and flow again after the next payment.

Errors use `{"error":{"code":"…","retry":bool}}`: 400 `invalid_request`/`invalid_cursor`/`invalid_receipt`,
401 `invalid_session`/`invalid_signature`/`invalid_challenge`, 403 `permission_denied`/`shop_suspended`/`shop_removed`
and the connection-code codes above, 409 `batch_conflict`/`receipt_conflict`/`enrollment_conflict`, 413 `batch_too_large`,
429 `rate_limited` (with `Retry-After`), 503 `database_unavailable`/`schema_outdated`, 500 `internal`. Bodies are limited to
64 KiB except push (8 MiB + 64 KiB). The global limit is 600 requests a minute per address and 30 for challenge and
session routes. Tenant and device always come from the session, never the body. Suspension and revocation take effect
on the next request.

Configuration: `DATABASE_URL`, `KOLO_HOST`, `PORT`, `KOLO_PUBLIC_URL` (the address printed into connection codes;
defaults to `http://127.0.0.1:<PORT>` on loopback, required otherwise to issue codes), `KOLO_ADMIN_HOST`/`KOLO_ADMIN_PORT`
(dashboard listener, default `127.0.0.1:8081`, `off` disables), `KOLO_ADMIN_TOTP` (`on` default; `off` = password only, loopback dashboards only), `KOLO_ADMIN_UI_DIR` (built dashboard; default
`apps/admin/dist`), `KOLO_SERVER_KEY_FILE` (default `.kolo-server-key.json`; Docker `/var/lib/kolo`),
`KOLO_SESSION_TTL_SECONDS` (60–86400, default 3600), `KOLO_TRUST_PROXY`, `KOLO_EDITION` (`selfhost` default or `hosted`),
`KOLO_GRACE_DAYS` (0–90, default 7), `KOLO_BILLING_WEBHOOK_SECRET` (32+ characters; enables the webhook on hosted servers), `KOLO_LOG_LEVEL` (default `info`: one JSON line
per request with method, path, status and time, never bodies or headers; `silent` disables). `KOLO_ENROLLMENT_CODE` is no
longer read. The server prints its fingerprint at start.

Commands (`node apps/server/dist/main.js <command>`): `migrate [--discard-plaintext]`, `invite --label <shop> [--days 7] [--months 0] [--trial-days 0] [--tills <n>|unlimited]`
(prints the code and a terminal QR code; on a hosted server `--tills` is required, ADR-039), `till-limit <shop id> <n>|unlimited` (raising it releases waiting tills), `invite --recovery-shop <shop id> [--days 7]` (an owner-recovery code, below), `admin create <username> [--role admin|viewer] [--password-stdin]` (prints a
generated password unless one is piped, and the authenticator link and QR code), `admin reset-totp <username>`, `purge`.

### Join by code (ADR-032)

| Method/path | Auth | Result |
|---|---|---|
| `POST /api/v2/join` | Token of an active authority till; strict limit | `{join_id, invite, mac}` → 201 `{expires_at}` (10 minutes); the invite must be signed by that till for its shop; at most 3 open per shop |
| `GET /api/v2/join/:id` | None; strict limit | The offer, or 404 `join_not_found` |
| `POST /api/v2/join/:id/request` | None; strict limit | `{request, encryption_public_key, mac}` → 204; the same request again is harmless, another is 409 `join_conflict` |
| `GET /api/v2/join/:id/request` | Owner's token | The request, or 204 while none |
| `POST /api/v2/join/:id/enrollment` | Owner's token | `{enrollment, sealed_password, mac}`; `enrollment` is base64 of the encrypted container (≤ 48 MiB, `MAX_JOIN_ENROLLMENT_CHARS`, ADR-035) → 204 |
| `GET /api/v2/join/:id/enrollment` | None | The encrypted shop file and sealed password, or 204 while the owner has not answered |
| `DELETE /api/v2/join/:id` | Owner's token | Refuse or cancel |

`:id` is SHA-256 of the code; the server never receives the code. Every message is tagged with a key derived from it,
which only the two tills check.

### Sync batch and sealed facts

```json
{"batch": {"format":"kolo.sync-batch","format_version":1,"batch_id":"…","business_id":"…","sender_device_id":"…",
  "receiver_device_id":"…","created_at":"…","events":[
    {"clear": {"envelope": {"event_type":"DEVICE_ENCRYPTION_KEY","…":"…"}, "digest":"…", "signature":"…"}},
    {"sealed": {"event_id":"…","origin_device_id":"…","origin_sequence":12,"digest":"…","key_id":"…","epoch":1,
      "nonce":"24 hex","ciphertext":"base64","tag":"32 hex"}}]},
 "digest":"…", "signature":"…"}
```

Clear facts are limited to `CLEAR_EVENT_TYPES`; any other clear fact is rejected with `plaintext_refused`. The server
verifies clear facts against their origin and accepts sealed facts from the authenticated, batch-signing till for any
origin in the shop's roster; tills open and verify every sealed fact themselves. `digest` is the digest of the inner
signed fact, so the same fact sealed again is a `duplicate` and receipts match file exchange.

### Push response

```json
{
  "results": [
    {"event_id":"…","status":"stored"},
    {"event_id":"…","status":"duplicate"},
    {"event_id":"…","status":"rejected","code":"untrusted_device","retry":true},
    {"event_id":"…","status":"rejected","code":"plaintext_refused","retry":false},
    {"event_id":"…","status":"rejected","code":"event_identity_conflict","retry":false}
  ],
  "receipt": {"receipt": {"format":"kolo.receipt","entries":[{"event_id":"…","digest":"…","state":"stored"}]}, "digest":"…","signature":"…"}
}
```

200 means the batch was evaluated; results govern each event. `stored` is durable relay storage,
not business application. An unknown origin is retried within the batch after any owner trust
fact it contains, then left with the sender. Changed content under a known event ID or origin
position is kept in `journal_conflicts`. The receipt is `null` when nothing was accepted.

### Pull and acknowledgements

Pull pages are signed by the server as forwarding sender and contain only facts the device has not
acknowledged and did not push itself, oldest first. Persist and import a page, then post the signed
receipt from `createPeerReceipt`. The cursor pages within a pass only; a new pass starts without one,
so facts a device skipped (from a key it does not trust yet, or sealed with a shop key it has not been granted yet)
are offered again.

### Operator dashboard API (separate listener)

Served on `KOLO_ADMIN_HOST:KOLO_ADMIN_PORT` only, never on the sync port. The page is `/admin/` (Preact, with client
routes such as `/admin/shops/<id>`; ADR-045); the API is `/admin/api`.
Sessions are an HttpOnly, SameSite=Strict cookie (`Path=/admin`, `Secure` over HTTPS) lasting at most 12 hours and ending
after 30 idle minutes; a request with `x-kolo-poll: 1` (a background refresh) does not count as activity. Every non-GET
request must carry a matching `Origin` (403 `bad_origin`). Viewers get 403 `read_only` on changes. Origin, session, role
and step-up are checked before the request is validated against its schema: unknown fields and wrong types are refused
without coercion, with the field's own code where it has one (`invalid_months`, `invalid_till_limit`, …) and
`invalid_request` otherwise; a malformed path ID is 404 `not_found`. Responses carry a strict CSP, `X-Frame-Options: DENY`
and `Cache-Control: no-store`.

**Step-up:** routes marked *step-up* need `POST /admin/api/session/confirm` within the last 5 minutes, else 403
`step_up_required`.

| Method/path | Role | Result |
|---|---|---|
| `GET /admin/api/config` | — | `{totp}`: whether sign-in asks for an authenticator code |
| `POST /admin/api/session` | — | `{username,password,code}`; 6-digit TOTP (unless `KOLO_ADMIN_TOTP=off`), each code once; 401 `invalid_credentials`, 423 `account_locked` (5 failures, 15 minutes); 10 a minute per address |
| `POST /admin/api/session/confirm` | any | `{password, code}` (a fresh step); failures count toward the lockout; returns `me` with `confirmedUntil` |
| `DELETE /admin/api/session`, `GET /admin/api/me` | any | Sign out; current operator `{username, role, idleMinutes, expiresAt, confirmedUntil, edition, totp}` |
| `GET /admin/api/overview` | any | Shops by status, hosted service counts, tills in use and waiting, facts in 24 h and per UTC day for 14 days, hosted revenue for 30 days, unused codes, the integrity summary and the attention list (`service_inactive`, `service_grace`, `service_expiring` (7 days), `held_tills`, `conflicts`, `stale_shop` (14 days), `code_expiring` (24 h), `purge_soon` (3 days), `server_errors`, `integrity`) |
| `GET /admin/api/health` | any | Version, database size, facts (total, last 24 h), active till sessions, shops by status, request/error/rate-limit counters since start, applied migrations, runtime (Node, PostgreSQL, memory, uptime) |
| `GET /admin/api/integrity` | any | Checks `audit_chain`, `payment_chain`, `paid_until`, `held_with_free_places`, `sessions_on_stopped_shops`, `purge_overdue`, each with failing targets; the audit head `{entries, headSeq, headHash}` |
| `GET /admin/api/codes?state=&offset=&limit=` | any | `{codes, total, canIssue, publicUrl, edition}`; never tokens |
| `POST /admin/api/codes`, `POST /admin/api/codes/:id/cancel` | admin | Issue `{label, days 1–90, includedMonths 0–36, includedDays 0–90, maxTills}` (hosted: `maxTills` required, `null` unlimited) or an owner-recovery code `{label, days, recoveryShopId}` (*step-up*; audited `code.issue_recovery`) → code shown once plus an SVG QR code; cancel an unused code |
| `GET /admin/api/shops?search=&status=&service=&sort=&dir=&offset=&limit=`, `GET /admin/api/shops.csv?…` | any | `{shops, total, edition}`; `search` matches the name, or an ID prefix when it looks like one; `sort` is `lastSeen` (default), `name`, `enrolled`, `facts`, `bytes` or `paidUntil`; CSV up to 5000 rows |
| `GET /admin/api/shops/:id` | any | Detail: tills with backlog, conflicts, key epoch, payments and the 50 latest audit entries naming the shop (`activity`) |
| `POST /admin/api/shops/:id/{suspend,resume,remove,restore}` | admin | Remove needs `{confirm: <shop id>}` (400 `confirmation_required`) and a *step-up*, and keeps data restorable for 30 days; the server purges it hourly afterwards |
| `POST /admin/api/shops/:id/till-limit` | admin | `{maxTills, expected?}`; 409 `stale` when the limit is no longer `expected`; returns `{released}` |
| `POST /admin/api/shops/:id/payments` | admin, hosted | `{months 1–36, amountMinor, method, reference?, requestId}`; extends paid-until from its end or today; the same `requestId` again returns the original with `duplicate: true` (409 `payment_conflict` if it differs); 409 `not_hosted` on self-hosted servers |
| `GET /admin/api/billing?from=&to=&offset=&limit=`, `GET /admin/api/billing.csv?…` | any, hosted | Payments in [`from`, `to`) (default the last 30 days) with shop names, totals by method and by source, and shops whose subscription ends within 30 days or lapsed; 409 `not_hosted`, 400 `invalid_period` |
| `GET /admin/api/audit?action=&username=&target=&from=&to=&before=&limit=`, `GET /admin/api/audit.csv?…` | any | Hash-chained, append-only audit log, newest first, each entry with `seq` and `hash`; `action` is a prefix (`shop.`); CSV up to 5000 rows |
| `GET /admin/api/account/sessions`, `DELETE /admin/api/account/sessions/:id`, `POST /admin/api/account/sessions/sign-out-others` | any | The operator's own live sessions (`id` is a token-hash prefix); ending one of them, or all the others |
| `POST /admin/api/account/password` | any, *step-up* | `{password}` (12+ characters, not only digits); ends the operator's other sessions |
| `GET /admin/api/operators` | admin | `{operators: [{adminId, username, role, active, locked, createdAt, lastLoginAt, sessions}], totp}` |
| `POST /admin/api/operators` | admin, *step-up* | `{username, role}` → generated password, `otpauth` URI and QR, shown once; 409 `username_taken` |
| `POST /admin/api/operators/:id/{role,deactivate,activate,unlock,reset-totp}` | admin, *step-up* | `role` takes `{role}`; never one's own account (409 `self_change`) nor the last active admin (409 `last_admin`); deactivating ends their sessions; `reset-totp` returns a new URI and QR |

## Remaining planned API

None for the server. A specific payment provider is one more `BillingAdapter` beside the generic webhook. Centralized
`GET /api/v2/reports/...` is dropped: the server cannot read sealed facts.

## API conventions

- JSON UTF-8; strict runtime schemas from contracts; explicit payload/protocol versions.
- API boundary amounts and quantities are safe integers; XAF amounts have no decimals.
- UTC ISO instants; server cursors are opaque destination-scoped strings, not device
  sequences. UUIDs are validated; new application-generated IDs are UUIDv7.
- Bearer installation sessions authenticate network requests. Operation/membership
  authority is checked separately, especially for forwarded events.
- Server session determines tenant/destination. Envelope business IDs must match it;
  callers cannot switch scope by adding an arbitrary business ID to a payload/query.
- Upload limit initially 8 MiB and 1000 events; clients normally use smaller measured
  batches. Pull default 100, max 1000. Reject excess before unbounded buffering.
- TLS for hosted/public endpoints; explicit LAN/self-host enrollment and server identity.
- Sessions are opaque 43-character bearer tokens from a signed challenge (ADR-029); no JWT.

## Error conventions

```json
{"error":{"code":"permission_denied","retry":false}}
```

| HTTP | Stable examples | Retry behavior |
|---|---|---|
| 400 | `invalid_request`, `invalid_cursor` | Correct input |
| 401 | `invalid_session` | Network reauthentication; local trading continues |
| 403 | `permission_denied`, `invalid_connection_code`, `connection_code_used`, `connection_code_expired`, `shop_suspended`, `shop_removed`, `hosted_service_inactive` | Ask the operator for a new code or to resume the shop; retain local history and keep trading |
| 409 | `enrollment_conflict`, `batch_conflict`, `receipt_conflict` (per-event `event_identity_conflict` is a push result) | Owner diagnostics; no silent overwrite |
| 413 | `batch_too_large` | Split batch without changing event identity |
| 422 | Planned `unsupported_format` | Upgrade/compatibility route |
| 429 | `rate_limited` | Backoff/Retry-After |
| 503 | `database_unavailable`, `schema_outdated` | Backoff; pending work retained |

Error filter normalizes these and suppresses causes/credentials from response/logs.
Validation issue paths may be included without echoing sensitive values. Unknown field
handling is explicit, and version dispatch precedes payload validation.

## PostgreSQL transaction and migration method

Use Kysely over `pg` with explicit, tenant-bound queries (`apps/server/src/sync/relay.ts`). A transaction
must acquire one client, BEGIN, write validated effects/journal/results, COMMIT or
ROLLBACK, and release in finally. Do not mix independent pool queries into a transaction.
Apply uniqueness, safe-money checks, composite tenant foreign keys and immutable triggers
in versioned SQL migrations. Connection/query deadlines and graceful pool drain are
required. Real PostgreSQL integration tests cover concurrency and tenant escape; mocks
cannot prove missing WHERE clauses or FK behavior.

The server no longer applies business facts (ADR-030), so the archived Go server's business application is not
ported; its payload fixtures remain useful for the shared client rules.
