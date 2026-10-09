# Optional server API

## Implemented scaffold

Default development address: `http://127.0.0.1:8080`. No route accepts business writes,
credentials or event pushes yet. No migration runs automatically. HTTP tests start a
real Nest listener on an ephemeral port; optional PostgreSQL readiness uses a real pool.

| Method/path | Auth | Result |
|---|---|---|
| `GET /healthz` | None | 200 `{"status":"ok"}` if process is serving |
| `GET /readyz` | None | 200 `{"status":"ready"}` if PostgreSQL reachable; otherwise 503 `{"error":{"code":"database_unavailable"}}` |
| `GET /api/v2/capabilities` | None | 200 API 2, exchange format 1, `sync:false`, `enrollment:false` |

The current core/mobile HTTP implementation speaks archived `/api/v1`; it is not
compatible with future v2 merely by changing `API_BASE_URL`. Nest advertises disabled
features until implemented. Missing Nest routes currently use Nest's default 404 shape;
the uniform error filter below is planned in F6, not silently claimed as implemented.

## Planned API conventions (F6)

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
- No JWT/credential format is promised until F1/F6 identity ADR and implementation.

## Planned endpoints

| Method/path | Scope/authority | Function |
|---|---|---|
| `POST /api/v2/enrollment/challenges` | Rate-limited unauthenticated | Begin proof of existing local shop authority |
| `POST /api/v2/enrollment/complete` | Verified signed challenge/owner proof | Register shop/device baseline and network destination |
| `POST /api/v2/auth/sessions` | Installation credential/proof | Issue network-only session |
| `DELETE /api/v2/auth/session` | Current token; idempotent expiry | End network session without deleting local history |
| `GET /api/v2/auth/me` | Current session | Membership revisions and destination identity |
| `POST /api/v2/sync/push` | Authenticated installation + per-origin authority | Ingest verified events; per-event results |
| `GET /api/v2/sync/pull` | Authenticated shop/device | Bounded journal page including relayed origins |
| `POST /api/v2/sync/receipts` | Authenticated recipient | Confirm durable delivery/application results |
| `GET /api/v2/sync/status` | Device or owner diagnostics permission | Backlog, rejected/deferred/unsupported outcomes |
| `GET /api/v2/reports/...` | Specific report permission | Optional centralized reads; never required for local reports |
| `GET /api/v2/entitlements` | Hosted network session | Hosted service eligibility, not local-operation license |
| `POST /internal/billing/webhooks` | Provider signature, hosted only | Idempotent entitlement changes; no client financial facts |

Names above are design targets, not shipped endpoints. Complete request schemas are
added to the shared contracts/OpenAPI before each endpoint is implemented. Do not add
CRUD financial-table endpoints that bypass domain operations.

## Planned push request/response

Request carries an authenticated exchange container wrapping the bundle envelope in
the [exchange guide](exchange.md). Signature-container format is deliberately pending
the cryptographic/native spike; the unsigned codec must not become production auth.
Each event's original actor/device is verified even when forwarded.

```json
{
  "results": [
    {"event_id":"...","status":"applied"},
    {"event_id":"...","status":"duplicate"},
    {"event_id":"...","status":"stored_deferred","code":"missing_product"},
    {"event_id":"...","status":"rejected","code":"permission_denied","retry":false}
  ],
  "cursor":"destination-scoped-opaque-value"
}
```

200 means the request/batch was evaluated; results govern individual event delivery.
A duplicate is success only when immutable content matches. Changed content with the
same ID is `event_identity_conflict`, quarantined and visible. Temporarily missing
dependencies are stored/deferred; invalid signature/authority is refused, not acknowledged
as accepted. Financial rows and applied marker commit together before `applied`.
Lost HTTP response is safe to retry with the same event IDs. Entire-request authentication,
limits or unsupported container version failures use non-2xx and no acceptance claims.

## Planned pull and acknowledgements

`GET /api/v2/sync/pull?cursor=...&limit=100` returns authenticated events, next cursor
and `has_more`. Persist the incoming page before advancing its receive cursor; retain
unsupported verified events without pretending to apply them. `/sync/receipts` confirms
per-event durable/application outcomes. A cloud cursor cannot be reused against a new
server or local peer. Branch/membership filters must not produce invisible cursor gaps.

## Planned errors

```json
{"error":{"code":"permission_denied","request_id":"...","retry":false}}
```

| HTTP | Stable examples | Retry behavior |
|---|---|---|
| 400 | `invalid_request`, `invalid_cursor` | Correct input |
| 401 | `invalid_session` | Network reauthentication; local trading continues |
| 403 | `permission_denied`, `hosted_service_inactive` | Resolve authority/entitlement; retain local history |
| 409 | `event_identity_conflict`, `enrollment_conflict` | Owner diagnostics; no silent overwrite |
| 413 | `batch_too_large` | Split batch without changing event identity |
| 422 | `unsupported_format` | Upgrade/compatibility route |
| 429 | `rate_limited` | Backoff/Retry-After |
| 503 | `database_unavailable` | Backoff; pending work retained |

Error filter normalizes these and suppresses causes/credentials from response/logs.
Validation issue paths may be included without echoing sensitive values. Unknown field
handling is explicit, and version dispatch precedes payload validation.

## PostgreSQL transaction and migration method

Use `pg` with explicit repository modules and tenant-bound operations. A transaction
must acquire one client, BEGIN, write validated effects/journal/results, COMMIT or
ROLLBACK, and release in finally. Do not mix independent pool queries into a transaction.
Apply uniqueness, safe-money checks, composite tenant foreign keys and immutable triggers
in versioned SQL migrations. Connection/query deadlines and graceful pool drain are
required. Real PostgreSQL integration tests cover concurrency and tenant escape; mocks
cannot prove missing WHERE clauses or FK behavior.

Port archived Go event payload fixtures and behaviors as migration parity tests; new
v2 authority/signature/envelope fields require explicit adapters and version fixtures.
The Go server still contains more implemented behavior than this scaffold.
