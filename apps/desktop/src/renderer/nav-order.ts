/** Sidebar sections in their default order. */
export const NAV_IDS = ["till", "products", "customers", "purchases", "finance", "analytics", "reports", "staff", "receipts", "devices", "settings"] as const;
export type NavId = typeof NAV_IDS[number];
/** The first default, which earlier builds saved on start even when nobody had chosen it. */
const PREVIOUS_DEFAULT: readonly NavId[] = ["till", "products", "customers", "purchases", "finance", "analytics", "reports", "staff", "devices", "receipts", "settings"];
const KEY = "kolo.navOrder";

/**
 * A complete order from any stored value: unknown or repeated entries are dropped and sections added by a newer version
 * are appended in their default place, so an old or damaged setting never hides a section.
 */
export function normalizeNavOrder(value: unknown): NavId[] {
  if (Array.isArray(value) && value.length === PREVIOUS_DEFAULT.length && value.every((id, index) => id === PREVIOUS_DEFAULT[index])) return [...NAV_IDS];
  const seen = new Set<NavId>(), order: NavId[] = [];
  if (Array.isArray(value)) for (const item of value) if ((NAV_IDS as readonly unknown[]).includes(item) && !seen.has(item as NavId)) { seen.add(item as NavId); order.push(item as NavId); }
  for (const id of NAV_IDS) if (!seen.has(id)) order.push(id);
  return order;
}
/** This computer's menu order; a per-computer convenience like language and appearance. */
export function storedNavOrder(): NavId[] {
  try { const text = localStorage.getItem(KEY); return normalizeNavOrder(text === null ? undefined : JSON.parse(text)); } catch { return [...NAV_IDS]; }
}
export function saveNavOrder(order: readonly NavId[]): void { try { localStorage.setItem(KEY, JSON.stringify(order)); } catch { /* The order stays for this session. */ } }
/** Moves one section up (-1) or down (+1); the ends stay put. */
export function moveNav(order: readonly NavId[], id: NavId, delta: -1 | 1): NavId[] {
  const next = [...order], from = next.indexOf(id), to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}
/** Places a dragged section where another one was dropped. */
export function dropNav(order: readonly NavId[], dragged: NavId, target: NavId): NavId[] {
  if (dragged === target) return [...order];
  const next = order.filter(id => id !== dragged), at = next.indexOf(target), from = order.indexOf(dragged), to = order.indexOf(target);
  next.splice(from < to ? at + 1 : at, 0, dragged);
  return next;
}
