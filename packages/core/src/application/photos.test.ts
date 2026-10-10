import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createHash, generateKeyPairSync, randomUUIDv7 } from "node:crypto";
import type { Database } from "../data/database/driver.ts";
import { openDatabase } from "../data/database/node-sqlite.ts";
import { migrate, MIGRATIONS } from "../data/database/migrations.ts";
import { inspectPhoto, PhotoError, PHOTO_LIMITS } from "../data/products/photos.ts";
import { createWorkspace, unlockWorkspace } from "../identity/workspace.ts";
import { createLocalMember } from "../identity/members.ts";
import { WorkspaceError, type WorkspacePorts } from "../identity/types.ts";
import * as commands from "./operations.ts";
import { photoUsage, productPhoto, productPhotoDigest, removeProductPhoto, setProductPhoto } from "./photos.ts";

const at = "2026-10-06T09:00:00.000Z", secret = "fixture-secret";
const crypto = { sha256Bytes: async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") };
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const code = (value: string) => (error: unknown): boolean => (error instanceof WorkspaceError || error instanceof PhotoError) && error.code === value;

/** A lossless WebP whose header declares the given size, padded to `length` bytes; only the header is read. */
function webp(width: number, height: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(length, 30)), view = new DataView(bytes.buffer);
  bytes.set([..."RIFF"].map(c => c.charCodeAt(0)), 0); view.setUint32(4, bytes.length - 8, true);
  bytes.set([..."WEBPVP8L"].map(c => c.charCodeAt(0)), 8); view.setUint32(16, bytes.length - 20, true);
  bytes[20] = 0x2f; view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}
/** A JPEG with a JFIF segment and a start-of-frame header declaring the given size. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

async function fixture() {
  const db = openDatabase(); databases.push(db); migrate(db);
  const material = { publicKey: generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, keyReference: randomUUIDv7(), credentialReference: randomUUIDv7() };
  const ports: WorkspacePorts = { database: db, now: () => at, newId: randomUUIDv7, credentials: { provision: async () => ({ ...material, credentialReference: randomUUIDv7() }), inspect: async () => material, verify: async (_ref, candidate) => candidate === secret } };
  const installation = await createWorkspace({ businessName: "Fixture", ownerName: "Owner", deviceLabel: "Till", platform: "DESKTOP", currency: "XAF", secret }, ports);
  const context = await unlockWorkspace({ userId: installation.ownerId, secret }, ports);
  const product = () => { const id = randomUUIDv7(); commands.saveProduct(context, { id, name: `Rice ${id.slice(-4)}`, unit: "unit", currency: "XAF", sellingPriceMinor: 500, taxRateBasisPoints: 0, minimumStock: 0, divisible: false, active: true, createdAt: at, updatedAt: at }); return id; };
  return { db, ports, context, product };
}

describe("photo inspection", () => {
  it("reads WebP and JPEG headers and refuses anything else or out of bounds", () => {
    assert.deepEqual(inspectPhoto(webp(320, 240)), { mediaType: "image/webp", width: 320, height: 240 });
    assert.deepEqual(inspectPhoto(jpeg(512, 1)), { mediaType: "image/jpeg", width: 512, height: 1 });
    for (const bad of [new Uint8Array(), new Uint8Array(100), webp(513, 10), webp(10, 513), jpeg(600, 300), webp(10, 10, PHOTO_LIMITS.maxBytes + 1),
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])])
      assert.throws(() => inspectPhoto(bad), code("invalid_photo"));
    assert.throws(() => inspectPhoto("not bytes" as unknown as Uint8Array), code("invalid_photo"));
  });
});

describe("product photos", () => {
  it("stores, replaces and removes one content-addressed photo per product, with audit and no exchange event", async () => {
    const f = await fixture(), rice = f.product(), events = Number(f.db.get(`SELECT count(*) AS n FROM event_journal`)!["n"]);
    const first = webp(320, 320, 2_000), second = jpeg(300, 200);
    const { digest } = await setProductPhoto(f.context, { productId: rice, bytes: first }, crypto);
    assert.equal(digest, createHash("sha256").update(first).digest("hex"));
    const stored = productPhoto(f.context, rice)!;
    assert.deepEqual([stored.mediaType, stored.width, stored.height, stored.bytes.byteLength], ["image/webp", 320, 320, 2_000]);
    assert.deepEqual([...stored.bytes], [...first]);
    await setProductPhoto(f.context, { productId: rice, bytes: second }, crypto);
    assert.equal(productPhotoDigest(f.context, rice), createHash("sha256").update(second).digest("hex"));
    assert.deepEqual(photoUsage(f.context), { photos: 1, bytes: second.byteLength, limitBytes: PHOTO_LIMITS.shopBytes });
    assert.equal(removeProductPhoto(f.context, rice), true); assert.equal(removeProductPhoto(f.context, rice), false);
    assert.equal(productPhoto(f.context, rice), undefined);
    assert.deepEqual(f.db.all(`SELECT action FROM local_audit WHERE action LIKE 'PRODUCT_PHOTO_%' ORDER BY sequence`).map(row => row["action"]), ["PRODUCT_PHOTO_SET", "PRODUCT_PHOTO_SET", "PRODUCT_PHOTO_REMOVED"]);
    assert.equal(Number(f.db.get(`SELECT count(*) AS n FROM event_journal`)!["n"]), events);
  });

  it("refuses invalid photos, unknown or foreign products and a shop past its storage limit, committing nothing", async () => {
    const f = await fixture(), rice = f.product();
    await assert.rejects(setProductPhoto(f.context, { productId: rice, bytes: webp(600, 600) }, crypto), code("invalid_photo"));
    await assert.rejects(setProductPhoto(f.context, { productId: randomUUIDv7(), bytes: webp(10, 10) }, crypto), code("scope_mismatch"));
    const other = await fixture(), foreign = other.product();
    await assert.rejects(setProductPhoto(f.context, { productId: foreign, bytes: webp(10, 10) }, crypto), code("scope_mismatch"));
    // Fill the shop to just under its limit with maximum-size photos, then one more byte too many.
    const full = Math.floor(PHOTO_LIMITS.shopBytes / PHOTO_LIMITS.maxBytes);
    for (let index = 0; index < full; index++) await setProductPhoto(f.context, { productId: f.product(), bytes: webp(10, 10 + index % 400, PHOTO_LIMITS.maxBytes) }, crypto);
    await assert.rejects(setProductPhoto(f.context, { productId: rice, bytes: webp(10, 10) }, crypto), code("photo_storage_full"));
    assert.equal(productPhoto(f.context, rice), undefined);
    // The large-files setting raises the shop's photo limit; the same photo now fits.
    await setProductPhoto(f.context, { productId: rice, bytes: webp(10, 10) }, crypto, { large: true });
    assert.equal(photoUsage(f.context, { large: true }).limitBytes, PHOTO_LIMITS.largeShopBytes);
    assert.equal(removeProductPhoto(f.context, rice), true);
    // Replacing a photo does not count the one it replaces.
    const any = String(f.db.get(`SELECT product_id FROM product_photos LIMIT 1`)!["product_id"]);
    await setProductPhoto(f.context, { productId: any, bytes: webp(20, 20, PHOTO_LIMITS.maxBytes) }, crypto);
    assert.equal(photoUsage(f.context).bytes, full * PHOTO_LIMITS.maxBytes);
  });

  it("checks products.edit to change and products.view to read, inside the operation", async () => {
    const f = await fixture(), rice = f.product();
    await setProductPhoto(f.context, { productId: rice, bytes: webp(10, 10) }, crypto);
    const viewer = await createLocalMember(f.context, { name: "Stock", role: "CASHIER", secret });
    const staff = await unlockWorkspace({ userId: viewer, secret }, f.ports);
    assert.equal(productPhoto(staff, rice)?.width, 10);
    await assert.rejects(setProductPhoto(staff, { productId: rice, bytes: webp(12, 12) }, crypto), code("permission_denied"));
    assert.throws(() => removeProductPhoto(staff, rice), code("permission_denied"));
  });

  it("is enforced by the schema too: size, type, digest and dimensions", async () => {
    const f = await fixture(), rice = f.product(), digest = "a".repeat(64);
    const insert = (values: { digest?: string; type?: string; bytes?: Uint8Array; width?: number }) => f.db.run(
      `INSERT INTO product_photos VALUES (?,?,?,?,?,?,?,?,?)`,
      [String(f.db.get(`SELECT business_id FROM products WHERE id=?`, [rice])!["business_id"]), rice, values.digest ?? digest, values.type ?? "image/webp", values.bytes ?? new Uint8Array(10), values.width ?? 10, 10, at, "device"]);
    for (const bad of [{ digest: "A".repeat(64) }, { digest: "a".repeat(63) }, { type: "image/svg+xml" }, { bytes: new Uint8Array(65_537) }, { bytes: new Uint8Array() }, { width: 513 }])
      assert.throws(() => insert(bad));
    insert({}); assert.throws(() => insert({}), /UNIQUE|PRIMARY/);
  });

  it("upgrades schema 21 forward with an empty photo table and leaves products untouched", () => {
    const db = openDatabase(); databases.push(db);
    db.run(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT`);
    for (const migration of MIGRATIONS.filter(item => item.version <= 21)) db.transaction(tx => { for (const sql of migration.statements) tx.run(sql); tx.run(`INSERT INTO schema_migrations VALUES (?,?,?)`, [migration.version, migration.name, at]); });
    assert.deepEqual(migrate(db).applied.map(item => item.version), [22, 23, 24]);
    assert.equal(db.get(`SELECT count(*) AS n FROM product_photos`)!["n"], 0);
  });
});
