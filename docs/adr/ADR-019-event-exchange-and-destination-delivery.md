# ADR-019: Event exchange and per-destination delivery

**Status:** Accepted, 2026-10-05
**Extends:** ADR-006, ADR-014; replaces single-server delivery as the final exchange model.
**Retains:** Transactional local outbox, immutable event IDs, retry and append-only facts.

## Context

Standalone users exchange files or Bluetooth data; connected users use hosted/self-hosted
HTTP. Replacing databases would discard concurrent transactions. A single delivered flag
or server cursor cannot describe whether multiple independent peers/cloud received a fact.

## Decision

Use one immutable event format across transfer methods, preserving origin device/sequence,
actor, shop, occurrence time and payload version while forwarding. A durable journal and
destination-specific receipts track offered/stored/applied/deferred/rejected outcomes.
Same event ID with changed content is conflict, never duplicate success. Snapshots serve
bootstrap/backup/restore; events merge concurrent histories. Verify trust and payloads before
effects. Exporting alone is not delivery; peer receipt is not cloud acknowledgement.

## Consequences

F2/F3 must migrate v1 outbox/inbox and permanently retain deduplication identity. Pruned
history cannot be fabricated into authentic old events; migrated baselines are explicit.
Signature/container/authority compatibility is versioned before production exchange.
Current bundle parsers are unsigned shape foundations, not a production importer. HTTP
v1 remains isolated until explicit v2 server migration. Bluetooth shares import logic and
adds framing/resumption only after supported-hardware verification.
