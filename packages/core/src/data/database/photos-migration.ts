import type { Migration } from "./migrations.ts";

/**
 * Optional product photos (migration 22).
 *
 * One current thumbnail per product, held as a small BLOB beside the catalogue so a
 * backup snapshot carries it without a second store. The digest is the SHA-256 of the
 * bytes, the content address later transfers and server storage will use. Size is
 * bounded per row here and per shop by the operation that writes it.
 */
export const PHOTOS_MIGRATION: Migration = {
  version: 22,
  name: "optional product photos",
  statements: [
    `CREATE TABLE product_photos (
       business_id       TEXT    NOT NULL REFERENCES businesses (id) ON DELETE RESTRICT,
       product_id        TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
       digest            TEXT    NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
       media_type        TEXT    NOT NULL CHECK (media_type IN ('image/webp', 'image/jpeg')),
       bytes             BLOB    NOT NULL CHECK (length(bytes) BETWEEN 1 AND 65536),
       width             INTEGER NOT NULL CHECK (width BETWEEN 1 AND 512),
       height            INTEGER NOT NULL CHECK (height BETWEEN 1 AND 512),
       updated_at        TEXT    NOT NULL,
       updated_by_device TEXT    NOT NULL,
       PRIMARY KEY (business_id, product_id)
     ) STRICT`,
  ],
};
