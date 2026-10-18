import type { Queryable } from "../data/database/driver.ts";
import * as photos from "../data/products/photos.ts";
import { appendLocalAudit, authorizedOperation } from "../identity/internal-authority.ts";
import { WorkspaceError, type OperationContext } from "../identity/types.ts";
import type { TransferCrypto } from "../backup/types.ts";

function requireProduct(tx: Queryable, context: OperationContext, productId: string): void {
  if (tx.get(`SELECT id FROM products WHERE business_id = ? AND id = ?`, [context.businessId, productId]) === undefined) throw new WorkspaceError("scope_mismatch");
}

/**
 * Stores or replaces a product's photo under products.edit. The bytes are checked
 * (WebP or JPEG, size and dimension limits) and hashed before the write; the shop's
 * total is checked inside it against {@link photos.PHOTO_LIMITS.shopBytes}. Photos are device-local until photo transfer exists:
 * no exchange event is journaled, only a local audit entry with the digest.
 */
export async function setProductPhoto(context: OperationContext, input: { readonly productId: string; readonly bytes: Uint8Array },
  crypto: Pick<TransferCrypto, "sha256Bytes">): Promise<{ digest: string }> {
  photos.inspectPhoto(input.bytes);
  const digest = await crypto.sha256Bytes(input.bytes);
  return authorizedOperation(context, ["products.edit"], (_database, tx, ports, revision) => {
    requireProduct(tx, context, input.productId);
    photos.writeProductPhoto(tx, { businessId: context.businessId, productId: input.productId, digest, bytes: input.bytes, at: ports.now(), deviceId: context.deviceId });
    appendLocalAudit(tx, context, ports, revision, "PRODUCT_PHOTO_SET", input.productId, { digest });
    return { digest };
  });
}

/** Removes a product's photo under products.edit; returns whether there was one. */
export function removeProductPhoto(context: OperationContext, productId: string): boolean {
  return authorizedOperation(context, ["products.edit"], (_database, tx, ports, revision) => {
    requireProduct(tx, context, productId);
    const removed = photos.deleteProductPhoto(tx, context.businessId, productId);
    if (removed) appendLocalAudit(tx, context, ports, revision, "PRODUCT_PHOTO_REMOVED", productId);
    return removed;
  });
}

/** A product's photo under products.view, or undefined when this device holds none. */
export function productPhoto(context: OperationContext, productId: string): photos.ProductPhoto | undefined {
  return authorizedOperation(context, ["products.view"], (_database, tx) => photos.productPhoto(tx, context.businessId, productId));
}

/** A product's photo digest under products.view, without the bytes. */
export function productPhotoDigest(context: OperationContext, productId: string): string | undefined {
  return authorizedOperation(context, ["products.view"], (_database, tx) => photos.productPhotoDigest(tx, context.businessId, productId));
}

/**
 * Photo digests for up to 100 products in one read, under products.view; products without a photo
 * on this device are absent. Lists use the digest as a cache key and load bytes for visible rows only.
 */
export function productPhotoDigests(context: OperationContext, productIds: readonly string[]): ReadonlyMap<string, string> {
  if (productIds.length > 100 || productIds.some(id => typeof id !== "string")) throw new WorkspaceError("invalid_input");
  return authorizedOperation(context, ["products.view"], (_database, tx) => {
    const result = new Map<string, string>();
    if (productIds.length === 0) return result;
    for (const row of tx.all(`SELECT product_id, digest FROM product_photos WHERE business_id = ? AND product_id IN (${productIds.map(() => "?").join(",")})`, [context.businessId, ...productIds]))
      result.set(String(row["product_id"]), String(row["digest"]));
    return result;
  });
}

/** How many photos the shop holds against its storage limit, under products.view. */
export function photoUsage(context: OperationContext): ReturnType<typeof photos.photoUsage> {
  return authorizedOperation(context, ["products.view"], (_database, tx) => photos.photoUsage(tx, context.businessId));
}
