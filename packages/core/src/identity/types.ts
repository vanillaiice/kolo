import type { Database } from "../data/database/driver.ts";
import type { AccountKind } from "../data/finance/accounts.ts";

/** Stable failures for local setup, authentication and application authorization. */
export type WorkspaceErrorCode =
  | "invalid_input" | "already_configured" | "legacy_installation" | "setup_pending"
  | "not_configured" | "credential_unavailable" | "invalid_credential" | "retry_later"
  | "recovery_required" | "locked" | "actor_inactive" | "permission_denied" | "scope_mismatch"
  /** A custom role that members still hold, or a role name the shop already uses. */
  | "role_in_use" | "duplicate_name";

/** Contains a stable code and optional retry time, never a PIN or native error. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly retryAt: string | undefined;

  constructor(code: WorkspaceErrorCode, retryAt?: string) {
    super(code);
    this.name = "WorkspaceError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

/** Public key and opaque native references; no private key or verifier bytes. */
export interface ProvisionedIdentity {
  readonly publicKey: string;
  readonly keyReference: string;
  readonly credentialReference: string;
}

/**
 * Native credential boundary, asynchronous and independent of SQLite/network.
 * Implementations must use a reviewed salted expensive KDF and protected native
 * storage. Provisioning is idempotent by installation ID: existing material must
 * be verified against the request, never silently overwritten. Inspect returns
 * material only after BOTH credential and device key are durably provisioned.
 * Lost/incomplete material returns undefined; exceptions must not expose secrets.
 * Native adapters and their performance/security gates are documented separately.
 */
export interface CredentialPort {
  provision(request: {
    readonly installationId: string;
    readonly businessId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly secret: string;
  }): Promise<ProvisionedIdentity>;
  inspect(installationId: string): Promise<ProvisionedIdentity | undefined>;
  verify(credentialReference: string, secret: string): Promise<boolean>;
  /** Signs versioned exchange bytes with the protected installation key; never exports private material. */
  sign?(keyReference: string, message: string): Promise<string>;
  /** Owner recovery proves a separately stored high-entropy recovery code. */
  recover?(oldReference: string, newReference: string, recoveryCode: string, newSecret: string): Promise<void>;
  /** Confirms a fully written credential change after a process crash. */
  hasCredential?(reference: string): Promise<boolean>;
  /** Reveals the recovery code only after credential proof; never persists it in SQLite. */
  recoveryCode?(reference: string, secret: string): Promise<string | undefined>;
  /** This installation's X25519 public key (SPKI PEM) for sealed shop keys, created on first use in the native vault. */
  encryptionKey?(keyReference: string): Promise<string>;
  /** X25519 agreement with a peer public key; returns the shared secret as hex. The private key never leaves the vault. */
  agree?(keyReference: string, peerPublicKey: string): Promise<string>;
}

/** Injected local dependencies; IDs must be fresh UUIDv7 and clock ISO UTC. */
export interface WorkspacePorts {
  readonly database: Database;
  readonly credentials: CredentialPort;
  readonly newId: () => string;
  readonly now: () => string;
}

/** Offline setup request. Credentials are passed only to the native port. */
export interface CreateWorkspaceInput {
  readonly businessName: string;
  readonly currency: "XAF";
  readonly ownerName: string;
  readonly secret: string;
  readonly deviceLabel: string;
  readonly platform: "ANDROID" | "IOS" | "DESKTOP";
  readonly accounts?: readonly { readonly name: string; readonly kind: AccountKind }[];
}

/** Persisted public installation metadata, independent of optional cloud sessions. */
export interface Installation {
  readonly installationId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly publicKey: string;
  readonly configuredAt: string;
}

/** Boot states are explicit: legacy data is never auto-adopted or relabeled. */
export type InstallationState =
  | { readonly state: "empty" | "legacy" }
  | { readonly state: "pending"; readonly installationId: string }
  | { readonly state: "locked" | "unlocked"; readonly installation: Installation };

/**
 * An opaque, in-memory unlock capability. Commands accept only the exact object
 * issued by unlockWorkspace; copied/forged IDs or claimed roles confer no access.
 * Lock, replacement unlock and restart invalidate it. No cloud expiry applies.
 */
export interface OperationContext {
  readonly businessId: string;
  readonly userId: string;
  readonly deviceId: string;
}
