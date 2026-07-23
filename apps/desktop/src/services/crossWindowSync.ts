// Cross-window consistency for shared persisted state. Reliable path: a Tauri global event
// emitted on change; every window listens and rehydrates from the (shared) localStorage blob.
// The browser `storage` event is kept as a best-effort bonus only — it is not reliably delivered
// across separate Tauri WebViews (WKWebView on macOS especially).
import { emit, listen } from "@tauri-apps/api/event";
import { useProjectStore, PROJECTS_PERSIST_KEY, flushProjectsPersist } from "../stores/projectStore";
import { useDictationStore, DICTATION_PERSIST_KEY } from "../stores/dictationStore";
import { perfSpan, perfSpanAsync } from "../perfTrace";
import { safeUnlisten } from "./safeUnlisten";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Minimum gap between two rehydrates of the same store. A structural change fans out one event per
 *  mutation, so a burst (spawning agents, a branch of rapid status flips, auto-name churn across
 *  dozens of agents) can deliver events far faster than a rehydrate is worth doing: each one
 *  re-reads and re-parses the whole persisted blob and writes the store, re-rendering every
 *  subscriber. Rehydrate always reads the CURRENT blob, so collapsing N events in a window into one
 *  run is equivalent to running only the last — the intermediate runs would each be overwritten by
 *  the next. At scale (40+ agents) 50ms was too tight: name-churn bursts arrived ~every 60-110ms and
 *  each paid a full rehydrate, producing recurring ~1s main-thread jank (perfTrace `rehydrate` spans
 *  hitting 900ms+). 300ms collapses a whole burst into a single trailing run; cross-window liveness
 *  of ~300ms is imperceptible (the receiving window is not the one being interacted with). */
const REHYDRATE_COALESCE_MS = 300;

/** A persisted store wired for cross-window liveness. `rehydrate()` is provided by zustand's
 *  `persist` middleware; `signature()` is a coarse hash of just the fields other windows care
 *  about, so high-churn fields (lastPrompt, mic level, …) never trigger a broadcast. */
interface SyncSpec {
  /** Tauri event name broadcast on change. */
  event: string;
  /** localStorage key of the persisted blob — used to filter the browser `storage` event. */
  persistKey: string;
  store: {
    subscribe: (cb: () => void) => () => void;
    persist: {
      rehydrate: () => void | Promise<void>;
      hasHydrated: () => boolean;
      onFinishHydration: (fn: () => void) => () => void;
    };
  };
  signature: () => string;
  /** Optional: synchronously flush the store's (debounced) localStorage write BEFORE broadcasting,
   *  so a receiving window rehydrates the fresh blob and not a stale one still in the debounce
   *  buffer (sparkle-pngb + ). */
  flush?: () => void;
}

/** Wire one persisted store for cross-window consistency, pushing teardown fns into `unsubs`.
 *  `isTorndown` reports whether the caller's teardown has already run: `listen(...)` resolves
 *  asynchronously, so a handle that arrives after teardown must be unlistened on the spot rather
 *  than pushed into an `unsubs` the forEach already walked — otherwise the listener leaks and
 *  fires rehydrate() for the life of the webview (mirrors improvementPass's `track`). */
function wire(spec: SyncSpec, unsubs: Array<() => void>, isTorndown: () => boolean): void {
  let applyingRemote = false;
  let last = spec.signature();

  // zustand's persist rehydrates asynchronously after store creation, so the persisted value can
  // land *after* we wire and fire the subscriber. That initial hydration is not a user mutation —
  // counting it as one would broadcast a spurious change to every other window at launch. Gate the
  // broadcaster until hydration settles, reseeding `last` from the hydrated value at that point.
  let hydrated = spec.store.persist.hasHydrated();
  if (!hydrated) {
    unsubs.push(
      spec.store.persist.onFinishHydration(() => {
        last = spec.signature();
        hydrated = true;
      }),
    );
  }

  // Leading-edge throttle state. An isolated event (the common case) rehydrates immediately, so
  // cross-window latency is unchanged; events arriving while one is in flight or inside the
  // cooldown collapse into a single trailing run, so no update is ever dropped — only merged.
  let running = false;
  let cooldown: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const runRehydrate = () => {
    running = true;
    // `applyingRemote` guards the store subscriber so the state-write that `persist.rehydrate()`
    // performs does not get mistaken for a local mutation and re-broadcast — that would loop
    // forever (Tauri `emit` echoes to the emitter and fans out to every window). Self-echo is
    // therefore harmless: the emitter rehydrates once against the blob it just wrote (idempotent)
    // and does not re-emit.
    applyingRemote = true;
    // Time the full rehydrate (getItem read + JSON.parse + migrate + merge + state write) — this
    // runs on EVERY remote structural change, so a big projects blob makes cross-window sync a
    // recurring main-thread cost. perfTrace: `grep 'perf.*rehydrate'`.
    void perfSpanAsync(`rehydrate ${spec.event}`, () =>
      Promise.resolve(spec.store.persist.rehydrate()),
    ).finally(() => {
      last = spec.signature();
      applyingRemote = false;
      running = false;
      // A rehydrate in flight when teardown lands resolves afterwards; don't arm a cooldown timer
      // for a webview that's already gone.
      if (isTorndown()) return;
      cooldown = setTimeout(() => {
        cooldown = null;
        if (!pending) return;
        pending = false;
        runRehydrate();
      }, REHYDRATE_COALESCE_MS);
    });
  };

  const rehydrate = (incomingSig?: string) => {
    // A remote change whose signature already matches ours is a no-op — skip the whole
    // read/parse/write. Tauri `emit` echoes to the emitter AND fans out to every window, so
    // without this the window that made a change pays a redundant self-echo rehydrate, and two
    // windows that already converged rehydrate each other pointlessly. `undefined` (the browser
    // `storage` event, which carries no payload) always falls through and rehydrates.
    if (incomingSig !== undefined && incomingSig === last) return;
    if (running || cooldown !== null) {
      pending = true;
      return;
    }
    runRehydrate();
  };

  // Drop any scheduled trailing rehydrate on teardown: the cooldown timer outlives the listeners,
  // so without this a burst that ends right as the webview closes would fire one more rehydrate
  // against a torn-down store.
  unsubs.push(() => {
    if (cooldown !== null) clearTimeout(cooldown);
    cooldown = null;
    pending = false;
  });

  const onStorage = (e: StorageEvent) => {
    if (e.key === spec.persistKey) rehydrate();
  };
  window.addEventListener("storage", onStorage);
  unsubs.push(() => window.removeEventListener("storage", onStorage));

  if (inTauri()) {
    void listen<string>(spec.event, (e) => rehydrate(e.payload)).then((u) => {
      if (isTorndown()) void safeUnlisten(u);
      else unsubs.push(u);
    });
  }

  const unsubStore = spec.store.subscribe(() => {
    // Liveness-only contract: a local change that happens to land *during* a remote rehydrate is
    // folded into `last` and not broadcast. It self-heals on the next mutation and the persisted
    // blob stays authoritative, so the worst case is a transiently stale view in another window —
    // acceptable, and far cheaper than risking the re-broadcast loop.
    if (applyingRemote || !hydrated) return;
    // signature() JSON.stringifies a reduced projects shape on EVERY store mutation (status flips,
    // activity, prompt appends…). Time it — if it shows up, the change-detection itself is a cost
    // multiplier under a write storm (perfTrace).
    const now = perfSpan(`signature ${spec.event}`, () => spec.signature());
    if (now === last) return;
    last = now;
    // Structural change is about to fan out to other windows — make sure the debounced projects
    // write has hit real localStorage first, so the receivers rehydrate the fresh blob.
    spec.flush?.();
    // Carry the new signature as the payload so a receiver already at this signature (self-echo,
    // or a converged window) can skip the rehydrate entirely — see rehydrate(incomingSig).
    if (inTauri()) void emit(spec.event, now);
  });
  unsubs.push(unsubStore);
}

// A coarse signature of the structural project state other windows care about — deliberately
// excludes high-churn fields like lastPrompt so we don't broadcast on every keystroke. The full
// JSON.stringify is O(projects × agents); negligible at realistic project/agent counts.
function projectSignature(): string {
  return JSON.stringify(
    useProjectStore.getState().projects.map((p) => [
      p.id,
      p.name,
      p.rootPath,
      p.defaultBranch,
      p.agents.map((a) => [a.id, a.name, a.kind, a.parentId]),
    ]),
  );
}

// The two persisted, user-facing mic settings — `enabled` (on/off) and `phase` (paused vs. active)
// — form the signature, so a change to either fans out to the other windows. Mic level/status and
// other high-churn runtime fields are intentionally excluded (not persisted, change constantly).
function dictationSignature(): string {
  const s = useDictationStore.getState();
  return `${s.enabled}|${s.phase}`;
}

/** Wire cross-window consistency for all shared persisted stores. Returns an unsubscribe fn;
 *  no-op when `window` is undefined. */
export function subscribeToCrossWindowSync(): () => void {
  if (typeof window === "undefined") return () => {};
  const unsubs: Array<() => void> = [];
  let torndown = false;
  const isTorndown = () => torndown;

  wire(
    {
      event: "sparkle://projects-changed",
      persistKey: PROJECTS_PERSIST_KEY,
      store: useProjectStore,
      signature: projectSignature,
      flush: flushProjectsPersist,
    },
    unsubs,
    isTorndown,
  );
  wire(
    {
      event: "sparkle://dictation-changed",
      persistKey: DICTATION_PERSIST_KEY,
      store: useDictationStore,
      signature: dictationSignature,
    },
    unsubs,
    isTorndown,
  );

  return () => {
    // Mark torndown BEFORE walking `unsubs` so any `listen(...)` still in flight unlistens itself
    // in its own `.then` instead of pushing into an array we've already drained. safeUnlisten both
    // swallows the benign Tauri handlerId race and stops a throw from aborting the loop mid-teardown.
    torndown = true;
    unsubs.forEach((u) => void safeUnlisten(u));
  };
}
