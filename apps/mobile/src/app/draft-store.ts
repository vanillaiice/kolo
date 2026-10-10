type Listener = () => void;
/**
 * Session-scoped transient values (cart, purchase draft, open tabs) with per-key subscriptions.
 * SQLite stays the source of saved facts; a new store is created for every unlocked session, so
 * lock, actor change, database replacement and cold boot discard everything held here.
 */
export class DraftStore {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /** The value for `key`, creating it from `initial` on first use. */
  get<T>(key: string, initial: () => T): T {
    if (!this.values.has(key)) this.values.set(key, initial());
    return this.values.get(key) as T;
  }
  /** Replaces the value and notifies that key's subscribers when it changed. */
  set(key: string, value: unknown): void {
    if (this.values.has(key) && Object.is(this.values.get(key), value)) return;
    this.values.set(key, value);
    for (const listener of [...this.listeners.get(key) ?? []]) listener();
  }
  /** Forgets a value (for example after a durable sale) and notifies its subscribers. */
  delete(key: string): void { if (this.values.delete(key)) for (const listener of [...this.listeners.get(key) ?? []]) listener(); }
  /** Subscribes to one key; returns the unsubscribe function. */
  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (set === undefined) { set = new Set(); this.listeners.set(key, set); }
    set.add(listener);
    return () => { set.delete(listener); };
  }
}
