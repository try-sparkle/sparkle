// Cross-window consistency for shared persisted state. Reliable path: a Tauri global event
// emitted on change; every window listens and rehydrates from the (shared) localStorage blob.
// The browser `storage` event is kept as a best-effort bonus only — it is not reliably delivered
// across separate Tauri WebViews (WKWebView on macOS especially).
import { emit, listen } from "@tauri-apps/api/event";
import { useProjectStore, PROJECTS_PERSIST_KEY, flushProjectsPersist } from "../stores/projectStore";
import { useDictationStore, DICTATION_PERSIST_KEY } from "../stores/dictationStore";
import { perfSpan, perfSpanAsync } from "../perfTrace";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

/** Wire one persisted store for cross-window consistency, pushing teardown fns into `unsubs`. */
function wire(spec: SyncSpec, unsubs: Array<() => void>): void {
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

  const rehydrate = () => {
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
    });
  };

  const onStorage = (e: StorageEvent) => {
    if (e.key === spec.persistKey) rehydrate();
  };
  window.addEventListener("storage", onStorage);
  unsubs.push(() => window.removeEventListener("storage", onStorage));

  if (inTauri()) {
    void listen(spec.event, () => rehydrate()).then((u) => unsubs.push(u));
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
    if (inTauri()) void emit(spec.event);
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

// The dictation mute is a single global boolean; mic level/status/phase are intentionally excluded
// (not persisted, and they change constantly) so only an actual mute toggle broadcasts.
function dictationSignature(): string {
  return String(useDictationStore.getState().enabled);
}

/** Wire cross-window consistency for all shared persisted stores. Returns an unsubscribe fn;
 *  no-op when `window` is undefined. */
export function subscribeToCrossWindowSync(): () => void {
  if (typeof window === "undefined") return () => {};
  const unsubs: Array<() => void> = [];

  wire(
    {
      event: "sparkle://projects-changed",
      persistKey: PROJECTS_PERSIST_KEY,
      store: useProjectStore,
      signature: projectSignature,
      flush: flushProjectsPersist,
    },
    unsubs,
  );
  wire(
    {
      event: "sparkle://dictation-changed",
      persistKey: DICTATION_PERSIST_KEY,
      store: useDictationStore,
      signature: dictationSignature,
    },
    unsubs,
  );

  return () => unsubs.forEach((u) => u());
}
