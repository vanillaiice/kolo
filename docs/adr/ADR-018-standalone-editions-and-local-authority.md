# ADR-018: Standalone editions and local shop authority

**Status:** Accepted, 2026-10-05
**Supersedes in part:** ADR-012 first-login/server-authority requirement and ADR-008's
server-derived envelope assumptions for peer exchange.
**Retains:** Secure credentials, one-shop installation, actor attribution, isolation.

## Context

A completely offline customer must install, create a shop, authenticate users and
operate without a server. Desktop has the same requirement. Hosted subscriptions add
sync, while a customer can operate the same optional server on their own infrastructure.

## Decision

Business/owner/device identity and local user unlock are created offline. Shop owner
authority governs local membership/permissions; paired devices and optional servers
verify propagated authority. Cloud identity/session and service entitlement are separate
from local unlock. Hosted expiry pauses hosted services without locking local operations,
records or exports. Hosted/self-host servers share one codebase.

Attaching a local shop to a server preserves business/entity/event identities. Pairing
requires owner-approved identity proof, not just a copied shop UUID. Restoring a backup
creates a fresh writable installation identity while preserving historical origins.

## Consequences

Current server login/demo bootstrap must be migrated in F1, not simply renamed. Local
PIN/KDF/key storage and recovery need native tests. Revocation cannot be immediate on
disconnected devices; authority revisions and late-event outcomes must be specified.
No default network license/account check may become a local trading prerequisite.
