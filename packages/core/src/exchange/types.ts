/** Native crypto implementations sign UTF-8 canonical bytes with protected Ed25519 keys. */
export interface ExchangeCrypto {
  sha256(message: string): Promise<string>;
  verify(publicKey: string, message: string, signatureHex: string): Promise<boolean>;
}
/** Stable exchange failures; never includes payloads, private keys or native error text. */
export class ExchangeError extends Error {
  readonly code: "invalid_event" | "invalid_payload" | "untrusted_device" | "invalid_signature" | "conflict" | "return_conflict" | "scope_mismatch" | "permission_denied" | "unsupported_event" | "missing_dependency" | "authority_revision" | "device_revoked" | "invalid_receipt" | "invalid_destination" | "fingerprint_mismatch" | "locked";
  constructor(code: ExchangeError["code"]) { super(code); this.name = "ExchangeError"; this.code = code; }
}
/** Durable effect outcomes; deferred/unsupported/quarantined records produce no business effects. */
export type EventOutcome = "applied" | "duplicate" | "deferred" | "quarantined" | "unsupported";
/** An opaque verified capability; matching fields on a forged object confer no authority. */
export interface VerifiedEvent { readonly eventId: string; readonly digest: string; }
