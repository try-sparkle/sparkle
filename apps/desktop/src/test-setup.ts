/** THERE ARE NO jest-dom MATCHERS IN THIS PACKAGE, AND THAT IS THE ANSWER TO THE ERROR YOU HIT.
 *
 *  `expect(el).toHaveTextContent(...)` — and `toBeInTheDocument`, `toBeVisible`, `toBeDisabled`,
 *  every other `@testing-library/jest-dom` matcher — dies here with `Invalid Chai property`.
 *  That message names no file and no missing import, and vitest dumps the whole rendered DOM for
 *  each failure, so it reads as a broken suite rather than an absent one-line setup. Measured:
 *  FOURTEEN tests went red at once on that message, thousands of lines of noise ahead of the
 *  cause, one debug cycle per person writing their first component test here (bead sparkle-tikxx9).
 *  Five separate suites had already each rediscovered it and written their own note about it.
 *
 *  WHAT TO WRITE INSTEAD — read the DOM directly. These are the idioms the existing suites use:
 *      expect(el.textContent).toContain("...")           // instead of toHaveTextContent
 *      expect(el).not.toBeNull()                         // instead of toBeInTheDocument
 *      expect((el as HTMLButtonElement).disabled).toBe(true)   // instead of toBeDisabled
 *
 *  WHY IT IS NOT SIMPLY ADDED. `@testing-library/jest-dom` resolves from the ROOT node_modules
 *  today as a transitive dep, so a bare import would appear to work while no package.json declares
 *  it — a phantom dependency that breaks on any hoisting change. Registering it properly means an
 *  explicit devDependency plus a lockfile change, and it alters matcher resolution across ~380
 *  component suites at once. That is a single-purpose PR with a full-suite run behind it, not a
 *  passenger on an unrelated branch. Until someone does that, the idioms above are the contract.
 */
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { argsCarryTauriUnavailableSignature } from "./services/tauriUnavailableSignature";

/** `@tauri-apps/api/core`'s real `invoke()` reads `window.__TAURI_INTERNALS__.invoke` — present
 *  only inside an actual Tauri webview. Left alone, EVERY unmocked `invoke()` call throws a
 *  synchronous `TypeError: Cannot read properties of undefined (reading 'invoke')`, which becomes
 *  a rejected promise. Components that render Tauri-backed data as a SIDE EFFECT of mounting (not
 *  the thing a given test is about — e.g. the concierge tools pane pulling the retirement ledger
 *  on every render) catch that rejection and log it, once per render, in every one of the ~380
 *  component suites that don't otherwise mock this module. At suite scale that is thousands of
 *  console lines funnelled through vitest's own worker→main RPC channel (the SAME channel
 *  `onTaskUpdate` acks over — see @vitest/runner's `createRuntimeRpc`), which can starve that
 *  channel past its 60s timeout and redden an otherwise fully-passing shard with an unhandled
 *  `[vitest-worker]: Timeout calling "onTaskUpdate"` error (bead sparkle-yzcjc).
 *
 *  DELIBERATELY DOES NOT CHANGE invoke()'S BEHAVIOR AT ALL — it keeps rejecting exactly as it
 *  does today, unmocked. Two earlier designs both tried to make invoke() succeed instead, and both
 *  caused real regressions caught only by a full-suite run (never by this one bead's own test
 *  file, which has no reason to exercise either code path):
 *    1. Stubbing `window.__TAURI_INTERNALS__` directly made every `hasTauri`-style presence check
 *       (`"__TAURI_INTERNALS__" in window`, e.g. services/attention.ts) read "we ARE in Tauri", so
 *       code that used to skip real webview-only APIs like `listen()` under jsdom started calling
 *       them for real and crashing on a DIFFERENT missing internal (`transformCallback`) — 11
 *       files / 61 tests.
 *    2. Mocking the `invoke` EXPORT to resolve `undefined` avoided that, but a real CI run (not
 *       caught locally) then hit `TypeError: results is not iterable` in
 *       stores/runtimeStore.ts's `pollProjectStatus`: its `try { results = await
 *       projectAgentsStatus(...) } catch { return }` was written to tolerate a REJECTION (the
 *       pre-existing, real behavior), not a resolution with the wrong shape — so a caller that
 *       assumed a typed array without its own defensive check got a NEW, different unhandled
 *       error, one shard failure standing in for another. Not every one of the ~380 unmocked call
 *       sites is written as defensively as preview.ts's `reply?.foo ?? null`.
 *
 *  Filtering the console line instead sidesteps BOTH failure classes at once: `hasTauri` checks
 *  are untouched (nothing about `window` changes), and every caller's control flow is UNCHANGED
 *  (invoke() still rejects, still hits the SAME catch block it always did) — only whether that
 *  already-happening, already-caught rejection gets WRITTEN to console differs. This mirrors this
 *  file's own established pattern one layer up: logger.ts's `LOG_FORWARD_DENYLIST` /
 *  `shouldForwardConsole` already suppress specific, well-understood noisy-but-benign messages
 *  (a Tauri callback-id log, an xterm WebGL restore) by substring match rather than blocking
 *  console output wholesale — this is the same idea, scoped to the one TypeError message every
 *  affected call site's error object carries, however each formats it into its own log line.
 *
 *  The signature match and predicate live in ./services/tauriUnavailableSignature, NOT inlined
 *  here: a test that wants to unit-test the predicate directly must import THAT module, never
 *  this one — this file is wired in only via vite.config.ts's `setupFiles`, invisible to
 *  scripts/dormant-modules.mjs's static import-graph scan, so an explicit `import` of this file
 *  from a `.test.tsx` would be this file's ONLY visible importer and read as "reachable only from
 *  a test" (caught by that exact guard on this bead's first attempt at this test). */
if (typeof window !== "undefined") {
  (["debug", "warn", "error", "log"] as const).forEach((method) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (argsCarryTauriUnavailableSignature(args)) return;
      original(...args);
    };
  });
}

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
