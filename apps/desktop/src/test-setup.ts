// Vitest setup. The store tests run under node (no DOM), but our zustand stores use the
// `persist` middleware against `localStorage`. Provide a tiny in-memory shim so persisting
// during tests is a no-op write rather than a crash. Real DOM behavior isn't under test here.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  /** Real Storage supports enumeration; code that sweeps a key PREFIX (windowStatus's cold-start
   *  wipe) depends on it, so the shim must provide it too or such sweeps silently no-op in tests. */
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    // Writable so a test that swaps in its own storage (e.g. runtimeStore.test.ts) still can.
    writable: true,
    configurable: true,
  });
}
