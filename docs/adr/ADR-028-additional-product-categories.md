# ADR-028: Additional product categories

**Status:** Accepted, 2026-10-10 (user decision: "several categories, one main")

## Context

Shops asked for a product to appear under more than one category (for example "Drinks" and
"Promo"). Sales-by-category reports group net sale lines by the product's category and must keep
summing to the period's sales; counting a product under several categories would break that.

## Decision

- A product keeps **one main category** on its own row (`products.category_id`, carried by
  `PRODUCT_SAVED`). Reports and analytics continue to group by it only.
- Up to **20 additional categories** form a separate set (migration 23: `product_category_sets`
  and `product_categories`), used for browsing and filtering. The main category is never repeated
  in the set.
- The set travels as its own signed event, `PRODUCT_CATEGORIES_SET` (v2 payload: product ID,
  sorted unique category IDs, `updated_at`), applied under last-write-wins per product (later
  `updated_at`, then greater device ID) and requiring `products.edit`. Category references are
  dependencies, so an event that arrives before its categories is deferred.
- Catalogue pages filtered by a category return products whose main **or** additional category it
  is. Core: `setProductCategories`, `records.productCategories`; desktop `updateProduct` accepts
  `otherCategoryIds`.

## Consequences

A till on an older version marks the new event "unsupported" and keeps it unapplied; it still
applies ordinary product edits and shows only main categories until it is upgraded. Backups carry
the new tables. Category reports are unchanged and still add up to sales.
