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

/** Is the ambient global a storage we can actually WRITE to?
 *
 *  Node 22+ defines a `localStorage` global of its own, but it only works when the process was
 *  started with `--localstorage-file`; without that flag the property still resolves to an object
 *  that carries none of the Storage methods. A `typeof … === "undefined"` guard reads that stub as
 *  "a real localStorage is already here", skips the shim, and every persisted-store write then
 *  dies with `storage.setItem is not a function` — which took out every test that touches a
 *  `persist`-wrapped store on Node 25. Feature-detect the METHODS rather than the binding.
 *
 *  Reading the property can itself throw (the global is a getter, and some Node builds raise
 *  rather than return a stub), so a throw counts as unusable too. */
function hasUsableStorage(): boolean {
  try {
    const existing = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
    return typeof existing?.setItem === "function" && typeof existing?.getItem === "function";
  } catch {
    return false;
  }
}

if (!hasUsableStorage()) {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    // Writable so a test that swaps in its own storage (e.g. runtimeStore.test.ts) still can.
    writable: true,
    configurable: true,
  });
}

/** jsdom implements no `PointerEvent`. Testing-library's `fireEvent.pointerDown/Move/Up` then falls
 *  back to a plain `Event`, which silently DROPS the coordinate fields — so `clientX`/`clientY`
 *  arrive `undefined` and any pointer-drag handler computes `NaN` instead of a delta. The handler
 *  runs, nothing moves, and the test fails looking like a broken component rather than a missing
 *  browser API.
 *
 *  MouseEvent already carries exactly the coordinate surface a drag reads, so aliasing it is enough
 *  for the drag paths we test; `pointerId`/`pointerType` ride along from the init dict as own
 *  properties. Only defined when genuinely absent, so a future jsdom that ships the real thing wins. */
// Guarded on MouseEvent too: this setup file also runs for NODE-environment suites, where there is
// no DOM at all and `class X extends MouseEvent` throws at module load — which would take down every
// non-jsdom test in the repo rather than just skipping a polyfill they never use.
if (
  typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined" &&
  typeof MouseEvent !== "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(globalThis, "PointerEvent", {
    value: PointerEventPolyfill,
    writable: true,
    configurable: true,
  });
}
