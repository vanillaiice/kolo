# ADR-037: French and English category names

**Status:** Accepted, 2026-10-18.

## Context

KOLO's screens are in French and English, but a product category has one name, typed by the shop. A till set to
English shows "Boissons", and the sales-by-category report labelled products in no category "Sans catégorie" whatever
the language. Expense categories are a fixed list and were already translated in both apps.

`CATEGORY_SAVED` v2 payloads are strict (ADR-033), so a new field on it would quarantine the event on a till that has
not been updated.

## Decision

- **Main name plus optional names per language.** `categories.name` stays required and is what older tills, receipts
  of history, the journal subject and ordering use. A category may also have a French name and an English name; each is
  optional, trimmed, at most 120 characters, and a blank one means none.
- **Display.** Every screen shows the name for its language, otherwise the main name (`domain/category-names`
  `categoryLabel`). Reports and analytics take a `language` view option (default French) for category labels,
  including "Sans catégorie" / "No category".
- **Search.** A category is found by its main name or either language name, accent- and case-insensitively, through
  generated folded keys that use the same rules as `search_name`.
- **Sync.** The names are a last-write-wins record per category (later `updated_at`, then the higher device ID) carried
  by a new signed event, `CATEGORY_NAMES_SET { category_id, fr?, en?, updated_at }`. An absent name in the payload
  clears it. `saveCategory` takes optional `names` and emits the event, in the same transaction as the category, only
  when the names change; omitted `names` leaves them unchanged.
- **Authority.** The first names of a category ride on `products.create` (like its creation); replacing names already
  set needs `products.edit`, checked on the till that writes and again on replay.

## Consequences

Migration 31 adds `category_names`. Older tills keep `CATEGORY_NAMES_SET` unsupported and apply it after they update;
until then they show the main name, which is always present. Lists stay ordered by the main name, so an English screen
can show them out of alphabetical order. Product names are unchanged: they are what a receipt prints.
