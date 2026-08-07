import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

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

// The concierge thread became a PERSISTED store so it survives an app restart (spec §3 subsystem
// C2) — which means it is also a module-level singleton that outlives a `render()`. Without this,
// every ConciergeHost test after the first mounts on top of the previous test's bubbles: 34 of them
// went red on `getByRole` finding multiple matches, and the failure reads as a component bug rather
// than as state bleed.
//
// Reset HERE rather than in each test file so a future test that mounts the host inherits the clean
// slate for free — the leak is a property of the store, not of any one suite. `beforeEach`, not
// `afterEach`: a suite that seeds the thread before rendering must not have its seed wiped.
//
// DYNAMIC import, and that is load-bearing: a static one is hoisted ABOVE the shim install below, so
// `persist`'s `createJSONStorage(() => localStorage)` — which resolves its storage eagerly, at module
// evaluation — would capture the unusable pre-shim global and every write would die on
// `setItem is not a function`. Importing inside the hook defers evaluation until after the shim
// exists. (Every other store escapes this only because test FILES import them, which already happens
// after setup.)
beforeEach(async () => {
  const { useConciergeThreadStore } = await import("./stores/conciergeThreadStore");
  useConciergeThreadStore.setState({ chat: [] });
  // The RESOLVED-nudge ledger is the same shape of problem as the thread store above: a
  // module-level singleton that outlives a `render()`. It is worse in one respect — the thread store
  // leaks bubbles a test can SEE, whereas this leaks a grey card for an agent id the next test never
  // blocked, so the failure surfaces as an off-by-one in an unrelated count ("expected 2 to be 1")
  // with nothing on screen to explain it. Ten cases across three suites went red exactly that way.
  //
  // Reset HERE, not per suite, for the reason already given above: the leak is a property of the
  // ledger, not of any one file, and EVERY host suite now runs the resolution pass on each render —
  // so a suite written next year inherits the clean slate without knowing this module exists.
  //
  // Dynamic import to match the pattern above. This module touches no store and no storage, so it
  // does not strictly need the deferral; it is imported this way so the two hooks cannot drift into
  // two different rules about when a global may be imported.
  const { resetResolvedLedgerForTests } = await import("./engine/resolvedNudges");
  resetResolvedLedgerForTests();
});

// Global RTL auto-cleanup. This suite runs WITHOUT vitest `globals` (see vite.config.ts
// test block — no `globals: true`), so @testing-library/react's package `afterEach(cleanup)`
// auto-registration never fires: it only self-installs when `afterEach` exists as a global.
// Without it, every `render()` leaves its React tree MOUNTED after the test ends — harmless
// while a feature's ownership comes from a click, but a STATE-DERIVED feature makes the
// leaked, still-mounted hooks re-subscribe to the shared store and fight the next test's
// component over it (a live example: 12 failures that pointed at the wrong code). Registering
// cleanup HERE, once, unmounts each test's trees so no test inherits the previous one's DOM.
//
// Safe for the node-environment store tests too: `cleanup()` only iterates the containers a
// `render()` mounted, so with nothing rendered it is a no-op and never touches `document`.
afterEach(() => {
  cleanup();
});
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
