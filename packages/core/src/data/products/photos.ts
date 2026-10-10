/**
 * Optional product photos.
 *
 * A photo is presentation, not trade: nothing about a sale, a stock count or a
 * balance depends on it, and a product with no photo — or whose photo this
 * device never received — shows its initial instead. So photos are kept to
 * small thumbnails, outside the product row and its PRODUCT_SAVED event, and
 * every limit is enforced here as well as in the schema:
 *
 * - one photo per product, at most {@link PHOTO_LIMITS.maxBytes} bytes and
 *   {@link PHOTO_LIMITS.maxSide} pixels a side;
 * - at most {@link PHOTO_LIMITS.shopBytes} bytes for the whole shop, so photos
 *   cannot crowd a backup out of its compressed-size budget (ADR-026), since
 *   already-compressed images do not deflate further.
 *
 * The digest is the SHA-256 of the bytes: a content address that later
 * device-to-device transfers and server storage can use to fetch only what is
 * missing.
 */

import { imageSize } from "image-size";
import type { Queryable } from "../database/driver.ts";

/** Size limits for product photos. */
export const PHOTO_LIMITS = {
  /** Largest stored photo. A 320-pixel WebP thumbnail is usually 10–25 KB. */
  maxBytes: 64 * 1024,
  /** Largest width or height. */
  maxSide: 512,
  /** Largest total for one shop, about a thousand thumbnails. */
  shopBytes: 16 * 1024 * 1024,
  /** Largest total on a device that opted into large transfer files (ADR-027). */
  largeShopBytes: 256 * 1024 * 1024,
} as const;

/** The encodings a photo may be stored in. */
export type PhotoMediaType = "image/webp" | "image/jpeg";

/** Raised when a photo is not a usable image or would not fit. */
export class PhotoError extends Error {
  readonly code: "invalid_photo" | "photo_storage_full";
  constructor(code: PhotoError["code"]) {
    super(code);
    this.name = "PhotoError";
    this.code = code;
  }
}

/** A stored product photo. */
export interface ProductPhoto {
  readonly productId: string;
  readonly digest: string;
  readonly mediaType: PhotoMediaType;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly updatedAt: string;
}

/** What a caller supplies to store a photo; dimensions and type come from {@link inspectPhoto}. */
export interface WritePhoto {
  readonly businessId: string;
  readonly productId: string;
  readonly digest: string;
  readonly bytes: Uint8Array;
  readonly at: string;
  readonly deviceId: string;
}

/**
 * Reads the type and size of an encoded image from its header, refusing anything
 * that is not a WebP or JPEG within the limits. Pixels are not decoded here.
 */
export function inspectPhoto(bytes: Uint8Array): { mediaType: PhotoMediaType; width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PHOTO_LIMITS.maxBytes) throw new PhotoError("invalid_photo");
  let size: ReturnType<typeof imageSize>;
  try { size = imageSize(bytes); } catch { throw new PhotoError("invalid_photo"); }
  const mediaType = size.type === "webp" ? "image/webp" : size.type === "jpg" ? "image/jpeg" : undefined;
  // EXIF orientations 5–8 swap the axes; either way both sides must be in range.
  if (mediaType === undefined || !inRange(size.width) || !inRange(size.height)) throw new PhotoError("invalid_photo");
  return { mediaType, width: size.width, height: size.height };
}

function inRange(side: number | undefined): side is number {
  return Number.isSafeInteger(side) && side! >= 1 && side! <= PHOTO_LIMITS.maxSide;
}

/**
 * Stores or replaces a product's photo, refusing one that would take the shop
 * past `shopBytes` (by default {@link PHOTO_LIMITS.shopBytes}). The replaced photo does not count.
 */
export function writeProductPhoto(tx: Queryable, photo: WritePhoto, shopBytes: number = PHOTO_LIMITS.shopBytes): void {
  if (!/^[0-9a-f]{64}$/.test(photo.digest)) throw new PhotoError("invalid_photo");
  const { mediaType, width, height } = inspectPhoto(photo.bytes);
  const others = Number(tx.get(`SELECT coalesce(sum(length(bytes)), 0) AS n FROM product_photos WHERE business_id = ? AND product_id <> ?`,
    [photo.businessId, photo.productId])?.["n"] ?? 0);
  if (others + photo.bytes.byteLength > shopBytes) throw new PhotoError("photo_storage_full");
  tx.run(`INSERT INTO product_photos (business_id, product_id, digest, media_type, bytes, width, height, updated_at, updated_by_device)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (business_id, product_id) DO UPDATE SET digest = excluded.digest, media_type = excluded.media_type,
            bytes = excluded.bytes, width = excluded.width, height = excluded.height,
            updated_at = excluded.updated_at, updated_by_device = excluded.updated_by_device`,
  [photo.businessId, photo.productId, photo.digest, mediaType, photo.bytes, width, height, photo.at, photo.deviceId]);
}

/** Removes a product's photo; returns whether there was one. */
export function deleteProductPhoto(tx: Queryable, businessId: string, productId: string): boolean {
  return tx.run(`DELETE FROM product_photos WHERE business_id = ? AND product_id = ?`, [businessId, productId]).changes > 0;
}

/** A product's photo, or undefined when it has none on this device. */
export function productPhoto(tx: Queryable, businessId: string, productId: string): ProductPhoto | undefined {
  const row = tx.get(`SELECT * FROM product_photos WHERE business_id = ? AND product_id = ?`, [businessId, productId]);
  if (row === undefined) return undefined;
  const bytes = row["bytes"];
  return { productId, digest: String(row["digest"]), mediaType: String(row["media_type"]) as PhotoMediaType,
    bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(), width: Number(row["width"]), height: Number(row["height"]), updatedAt: String(row["updated_at"]) };
}

/** A product's photo digest without its bytes, for listing and cache keys. */
export function productPhotoDigest(tx: Queryable, businessId: string, productId: string): string | undefined {
  const row = tx.get(`SELECT digest FROM product_photos WHERE business_id = ? AND product_id = ?`, [businessId, productId]);
  return row === undefined ? undefined : String(row["digest"]);
}

/** How many photos the shop holds and their total size. */
export function photoUsage(tx: Queryable, businessId: string, shopBytes: number = PHOTO_LIMITS.shopBytes): { photos: number; bytes: number; limitBytes: number } {
  const row = tx.get(`SELECT count(*) AS n, coalesce(sum(length(bytes)), 0) AS total FROM product_photos WHERE business_id = ?`, [businessId]);
  return { photos: Number(row?.["n"] ?? 0), bytes: Number(row?.["total"] ?? 0), limitBytes: shopBytes };
}
