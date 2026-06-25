// Cross-window consistency for the shared project list. Reliable path: a Tauri global event
// emitted on structural changes; every window listens and rehydrates from the (shared)
// localStorage blob. The browser `storage` event is kept as a best-effort bonus only — it is
// not reliably delivered across separate Tauri WebViews (WKWebView on macOS especially).
import { emit, listen } from "@tauri-apps/api/event";
import { useProjectStore, PROJECTS_PERSIST_KEY } from "../stores/projectStore";

const EVENT = "sparkle://projects-changed";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// A coarse signature of the structural state other windows care about — deliberately excludes
// high-churn fields like lastPrompt so we don't broadcast on every keystroke. The full
// JSON.stringify is O(projects × agents); negligible at realistic project/agent counts.
function signature(): string {
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

/** Wire cross-window consistency. Returns an unsubscribe fn; no-op when `window` is undefined. */
export function subscribeToCrossWindowSync(): () => void {
  if (typeof window === "undefined") return () => {};
  let applyingRemote = false;
  let last = signature();
  const unsubs: Array<() => void> = [];

  const rehydrate = () => {
    // `applyingRemote` guards the store subscriber so the state-write that `persist.rehydrate()`
    // performs does not get mistaken for a local mutation and re-broadcast — that would loop
    // forever (Tauri `emit` echoes to the emitter and fans out to every window). Self-echo is
    // therefore harmless: the emitter rehydrates once against the blob it just wrote (idempotent)
    // and does not re-emit.
    applyingRemote = true;
    void Promise.resolve(useProjectStore.persist.rehydrate()).finally(() => {
      last = signature();
      applyingRemote = false;
    });
  };

  const onStorage = (e: StorageEvent) => {
    if (e.key === PROJECTS_PERSIST_KEY) rehydrate();
  };
  window.addEventListener("storage", onStorage);
  unsubs.push(() => window.removeEventListener("storage", onStorage));

  if (inTauri()) {
    void listen(EVENT, () => rehydrate()).then((u) => unsubs.push(u));
  }

  const unsubStore = useProjectStore.subscribe(() => {
    // Liveness-only contract: a local structural change that happens to land *during* a remote
    // rehydrate is folded into `last` and not broadcast. It self-heals on the next mutation and
    // the persisted blob stays authoritative, so the worst case is a transiently stale Recent
    // list in another window — acceptable, and far cheaper than risking the re-broadcast loop.
    if (applyingRemote) return;
    const now = signature();
    if (now === last) return;
    last = now;
    if (inTauri()) void emit(EVENT);
  });
  unsubs.push(unsubStore);

  return () => unsubs.forEach((u) => u());
}
