import type { Language } from "./money.ts";

/**
 * The name to show for a category in `language` (ADR-037): its French or English name when set, otherwise its main
 * name. Pure, so every screen, report and export picks the same label.
 */
export function categoryLabel(category: { readonly name: string; readonly names?: { readonly fr?: string | undefined; readonly en?: string | undefined } | undefined }, language: Language): string {
  return category.names?.[language] ?? category.name;
}
