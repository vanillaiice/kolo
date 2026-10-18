import { z } from "zod";
export const transferUuid=z.uuid().refine(v=>v===v.toLowerCase());
export const transferTime=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
export const transferDigest=z.string().regex(/^[a-f0-9]{64}$/);
export const transferSignature=z.string().regex(/^[a-f0-9]{128}$/);
export const transferKey=z.string().min(32).max(8192).refine(v=>v.includes("BEGIN PUBLIC KEY")&&!v.includes("PRIVATE KEY"));
const name=z.string().min(1).max(120).refine(v=>v.trim().length>0);
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Size bounds a transfer reader or writer checks before key derivation or allocation. */
export interface TransferLimits {
  /** Largest raw SQLite image a backup or enrollment may carry. */
  readonly snapshotBytes: number;
  /** Largest decompressed content: a snapshot image plus its framed signed manifest. */
  readonly contentBytes: number;
  /** Largest encrypted container on disk: compressed content, chunk tags and header. */
  readonly fileBytes: number;
}
const MIB=1024*1024;
/**
 * The one size limit for backups and enrollment snapshots on every device (ADR-035): a 1 GiB SQLite
 * image. Files are whole byte arrays in memory, so peak memory is a few times the snapshot; users are
 * expected to have several GiB. The file bound adds 1 MiB to the content for deflate's stored-block
 * overhead on incompressible content (under 0.01%), chunk tags (16 bytes per MiB) and the header.
 */
export const TRANSFER_LIMITS: TransferLimits = Object.freeze({ snapshotBytes: 1024 * MIB, contentBytes: 1024 * MIB + MIB + 4, fileBytes: 1024 * MIB + 2 * MIB + 4 });
/** Largest raw SQLite image a backup or enrollment may carry. */
export const MAX_SNAPSHOT_IMAGE_BYTES=TRANSFER_LIMITS.snapshotBytes;
/** Largest decompressed transfer content. */
export const MAX_TRANSFER_CONTENT_BYTES=TRANSFER_LIMITS.contentBytes;
/** Largest encrypted transfer file on disk. */
export const MAX_ENCRYPTED_FILE_BYTES=TRANSFER_LIMITS.fileBytes;
/** Purposes an encrypted transfer file may declare. */
export const transferPurposeSchema=z.enum(["backup","enrollment","exchange","receipt"]);
/** Purposes an encrypted transfer file may declare. */
export type TransferPurpose=z.infer<typeof transferPurposeSchema>;
/** First eight bytes of an encrypted container (ADR-035): `\x89KOLO\r\n\x1a`. */
export const CONTAINER_MAGIC:readonly number[]=Object.freeze([0x89,0x4b,0x4f,0x4c,0x4f,0x0d,0x0a,0x1a]);
/** Magic plus the four-byte big-endian header length. */
export const CONTAINER_PREFIX_BYTES=12;
/** Largest canonical content header a container may declare. */
export const MAX_CONTAINER_HEADER_BYTES=4096;
/** Largest canonical key-slot section a container may declare. */
export const MAX_CONTAINER_SLOTS_BYTES=16384;
/** Most key slots one container may carry. */
export const MAX_KEY_SLOTS=8;
/** AES-GCM tag stored after every chunk. */
export const CONTAINER_TAG_BYTES=16;
/** Chunk size writers use; readers accept any power of two from 4 KiB to 4 MiB. */
export const CONTAINER_CHUNK_BYTES=1024*1024;
/** The HPKE suite of recipient slots: base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (RFC 9180). */
export const RECIPIENT_SUITE="HPKE-base-X25519-SHA256-AES256GCM";
const chunkBytes=integer.min(4096).max(4*1024*1024).refine(v=>(v&(v-1))===0);
const keyId=z.string().regex(/^[a-f0-9]{32}$/);
/**
 * Immutable content header, format version 3 (ADR-035). It is the canonical JSON after the 12-byte
 * prefix; magic, length and header together are the additional data of every chunk. `recipients`
 * lists the recovery keys sealed when the file was written, so a removed slot is detectable.
 */
export const containerHeaderSchema=z.strictObject({format:z.literal("kolo.encrypted"),format_version:z.literal(3),
 purpose:transferPurposeSchema,file_id:transferUuid,cipher:z.literal("AES-256-GCM"),compression:z.literal("deflate"),
 nonce_prefix:z.string().regex(/^[a-f0-9]{14}$/),chunk_bytes:chunkBytes,content_bytes:integer.positive().max(TRANSFER_LIMITS.contentBytes),
 recipients:z.array(keyId).max(MAX_KEY_SLOTS).refine(ids=>ids.every((id,i)=>i===0||ids[i-1]!<id),"sorted and unique")});
/** Parsed container header. */
export type ContainerHeader=z.infer<typeof containerHeaderSchema>;
const memoryKib=integer.min(65_536).max(262_144).refine(v=>(v&(v-1))===0);
/** A password slot: Argon2id over the NFC-normalized UTF-8 password wraps the file key (bounded parameters). */
export const passwordSlotSchema=z.strictObject({type:z.literal("password"),kdf:z.literal("argon2id"),memory_kib:memoryKib,
 passes:integer.min(3).max(10),parallelism:integer.min(1).max(4),salt:z.string().regex(/^[a-f0-9]{32}$/),
 nonce:z.string().regex(/^[a-f0-9]{24}$/),wrapped:z.string().regex(/^[a-f0-9]{96}$/)});
/** A recipient slot: the file key sealed with single-shot HPKE to a shop backup recovery key (ADR-036). */
export const recipientSlotSchema=z.strictObject({type:z.literal("recipient"),suite:z.literal(RECIPIENT_SUITE),key_id:keyId,
 enc:z.string().regex(/^[a-f0-9]{64}$/),wrapped:z.string().regex(/^[a-f0-9]{96}$/)});
/**
 * The mutable key-slot section: at most one password slot, first, then recipient slots in ascending
 * `key_id` order, so each set of slots has one encoding.
 */
export const keySlotsSchema=z.strictObject({slots:z.array(z.discriminatedUnion("type",[passwordSlotSchema,recipientSlotSchema])).min(1).max(MAX_KEY_SLOTS)
 .refine(slots=>slots.every((slot,i)=>slot.type==="password"?i===0:i===0||slots[i-1]!.type==="password"||(slots[i-1]!.type==="recipient"&&(slots[i-1] as {key_id:string}).key_id<slot.key_id)),"one password slot first, recipients sorted and unique")});
/** Parsed key slots. */
export type KeySlots=z.infer<typeof keySlotsSchema>;
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
 source_device_id:transferUuid,source_public_key:transferKey,snapshot_digest:transferDigest,snapshot_bytes:integer.positive().max(TRANSFER_LIMITS.snapshotBytes),
 boundary:snapshotBoundarySchema,credential_policy:z.literal("device_local_credentials_excluded"),target:target.nullable(),
 /** Backups only: the shop data keys (ADR-030) the making till held, so a restore can resume sync with no other till (ADR-036). */
 shop_keys:z.array(z.strictObject({key_id:transferUuid,epoch:integer.positive(),key:z.string().regex(/^[a-f0-9]{64}$/)})).max(1000).optional(),
}).refine(m=>(m.kind==="enrollment")===(m.target!==null)).refine(m=>m.kind==="backup"||m.shop_keys===undefined);
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
