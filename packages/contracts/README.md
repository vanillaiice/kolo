# @kolo/contracts

Versioned exchange envelopes and runtime validation. Parsers bound bundle size,
refuse future versions/mixed tenants, and detect repeated IDs/origin positions
inside a bundle. They do not authenticate senders, validate financial payloads,
verify signatures, apply data, or acknowledge delivery.

These envelopes are for planned `/api/v2` and local exchange. The current core HTTP
engine remains `/api/v1` until an explicit migration. Do not pass bundles to that
engine or advertise trusted file exchange as implemented.

See [exchange](../../docs/implementation/exchange.md) and
[public API](../../docs/reference/typescript-api.md).
