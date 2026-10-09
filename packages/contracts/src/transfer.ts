import { z } from "zod";
export const transferUuid=z.uuid().refine(v=>v===v.toLowerCase());
export const transferTime=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
export const transferDigest=z.string().regex(/^[a-f0-9]{64}$/);
export const transferSignature=z.string().regex(/^[a-f0-9]{128}$/);
export const transferKey=z.string().min(32).max(8192).refine(v=>v.includes("BEGIN PUBLIC KEY")&&!v.includes("PRIVATE KEY"));
const name=z.string().min(1).max(120).refine(v=>v.trim().length>0);
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const base64=z.string().max(24*1024*1024).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(v=>v.length%4===0);
/** Versioned authenticated-encryption header; every field participates in AES-GCM AAD. */
export const encryptedHeaderSchema=z.strictObject({format:z.literal("kolo.encrypted"),format_version:z.literal(1),
 purpose:z.enum(["backup","enrollment","exchange","receipt"]),file_id:transferUuid,
 cipher:z.literal("AES-256-GCM"),kdf:z.literal("PBKDF2-SHA256"),iterations:z.literal(600000),
 salt:z.string().regex(/^[a-f0-9]{64}$/),nonce:z.string().regex(/^[a-f0-9]{24}$/),plaintext_bytes:integer.positive().max(18*1024*1024),
});
export const encryptedFileSchema=z.strictObject({header:encryptedHeaderSchema,ciphertext:base64,tag:z.string().regex(/^[a-f0-9]{32}$/)});
export type EncryptedHeader=z.infer<typeof encryptedHeaderSchema>;
/** Snapshot boundary includes origin coverage and permanent application count, never a global server cursor. */
export const snapshotBoundarySchema=z.strictObject({audit_watermark:integer,applied_count:integer,
 origins:z.array(z.strictObject({device_id:transferUuid,maximum_sequence:integer,next_local_sequence:integer.positive().nullable()})).max(10000),
 legacy:z.array(z.strictObject({business_id:transferUuid,provenance:z.literal("unsigned_v1_snapshot"),outbox_next:integer.positive(),audit_watermark:integer})).max(1),
});
const target=z.strictObject({installation_id:transferUuid,device_id:transferUuid,public_key:transferKey,label:name,
 platform:z.enum(["ANDROID","IOS","DESKTOP"]),authority_allowed:z.boolean(),invite_id:transferUuid,request_id:transferUuid,request_digest:transferDigest});
/** Signed checksum/identity manifest for a sanitized physical SQLite snapshot. */
export const snapshotManifestSchema=z.strictObject({format:z.literal("kolo.snapshot"),format_version:z.literal(1),snapshot_id:transferUuid,
 kind:z.enum(["backup","enrollment"]),schema_version:integer.min(17),created_at:transferTime,
 business:z.strictObject({id:transferUuid,name,currency:z.literal("XAF")}),owner:z.strictObject({id:transferUuid,name}),
 source_device_id:transferUuid,source_public_key:transferKey,snapshot_digest:transferDigest,snapshot_bytes:integer.positive().max(16*1024*1024),
 boundary:snapshotBoundarySchema,credential_policy:z.literal("device_local_credentials_excluded"),target:target.nullable(),
}).refine(m=>(m.kind==="enrollment")===(m.target!==null));
export const signedSnapshotSchema=z.strictObject({manifest:snapshotManifestSchema,digest:transferDigest,signature:transferSignature});
export type SnapshotManifest=z.infer<typeof snapshotManifestSchema>;
export type SignedSnapshot=z.infer<typeof signedSnapshotSchema>;
/** Source invitation contains identity only; its fingerprint must be compared out of band. */
export const pairingInviteSchema=z.strictObject({format:z.literal("kolo.pairing-invite"),format_version:z.literal(1),invite_id:transferUuid,
 business_id:transferUuid,business_name:name,owner_id:transferUuid,owner_name:name,source_device_id:transferUuid,source_public_key:transferKey,
 created_at:transferTime,expires_at:transferTime,nonce:z.string().regex(/^[a-f0-9]{64}$/),authority_allowed:z.boolean()});
export const signedPairingInviteSchema=z.strictObject({invite:pairingInviteSchema,digest:transferDigest,signature:transferSignature});
/** New installation proves possession of its fresh native key; owner approval still precedes initialization. */
export const pairingRequestSchema=z.strictObject({format:z.literal("kolo.pairing-request"),format_version:z.literal(1),request_id:transferUuid,
 invite:signedPairingInviteSchema,installation_id:transferUuid,device_id:transferUuid,public_key:transferKey,label:name,
 platform:z.enum(["ANDROID","IOS","DESKTOP"]),created_at:transferTime});
export const signedPairingRequestSchema=z.strictObject({request:pairingRequestSchema,digest:transferDigest,signature:transferSignature});
export type SignedPairingInvite=z.infer<typeof signedPairingInviteSchema>;
export type SignedPairingRequest=z.infer<typeof signedPairingRequestSchema>;
