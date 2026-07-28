// A small shared map (localStorage) of webview-window label -> the project id that window
// is currently showing. Lets any window find/focus the window already showing a project —
// including the initial "main" window, whose label can't be `project-<id>` (Tauri labels are
// immutable, and the main window can display any project after a "Replace").

export const WINDOW_REGISTRY_KEY = "sparkle-window-projects";
// NOTE (roborev 46897): the cross-window LIVENESS half of this module — isWindowOpen,
// openWindowLabels, allKeys, removeKey, getWindowProject, onWindowRegistryChange — is gone. Every
// one of them existed to validate the per-window blobs of windowStatus.readOtherWindowsRedAgents,
// which CM-U7 part 2 deleted along with the multi-window shell. What is left is the project↔window
// MAPPING that captureSends still routes on.

export type KV = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  /** Optional: real localStorage has it, minimal test/SSR shims may not. Callers that need to
   *  delete a key should go through `removeKey` below, which falls back to writing "" (read paths
   *  already treat an empty value as absent). */
  removeItem?(k: string): void;
  /** Optional enumeration — real Storage has both; minimal shims may not. Only prefix sweeps need it. */
  key?(i: number): string | null;
  readonly length?: number;
};



/** The localStorage-backed KV, with a no-op fallback for non-browser (test/SSR) environments.
 *  Shared by the sibling windowStatus channel so the two key off the same storage. */
export function defaultStore(): KV {
  return typeof localStorage !== "undefined"
    ? localStorage
    : { getItem: () => null, setItem: () => {} };
}

function read(store: KV): Record<string, string> {
  try {
    const raw = store.getItem(WINDOW_REGISTRY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Same-window listeners don't get the `storage` event (that only fires in OTHER windows), so we
// also broadcast a local event on every write. Lets the roster publisher re-push the open-project
// set the instant a window opens/closes a project — see onWindowRegistryChange.
const LOCAL_CHANGE_EVENT = "sparkle:window-registry";

function write(store: KV, map: Record<string, string>): void {
  store.setItem(WINDOW_REGISTRY_KEY, JSON.stringify(map));
  // Guard the METHOD, not just `window`: a partial/non-DOM `window` (SSR-ish or test shims that
  // provide addEventListener but not dispatchEvent) would otherwise throw here and break an
  // otherwise-successful registry write. The broadcast is best-effort — a missing dispatchEvent
  // just means same-window listeners don't get the instant nudge (cross-window `storage` still fires).
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
  }
}


export function setWindowProject(label: string, projectId: string, store: KV = defaultStore()): void {
  const map = read(store);
  map[label] = projectId;
  write(store, map);
}

export function clearWindowProject(label: string, store: KV = defaultStore()): void {
  const map = read(store);
  delete map[label];
  write(store, map);
}

/** Wipe the whole registry. Used by the main window at cold start to drop stale cross-session
 *  entries (the blob outlives the process, but windows don't).
 *
 *  Prefer `pruneWindowRegistry` from anything that can run more than once per process — see its
 *  doc for what a mid-session wipe now costs. */
export function resetWindowRegistry(store: KV = defaultStore()): void {
  write(store, {}); // via write() so same-window subscribers (onWindowRegistryChange) are notified
}

/**
 * Drop rows whose window no longer exists, keeping the live ones. Returns true when it changed
 * anything.
 *
 * This exists because a WIPE stopped being harmless once satellites started writing this map.
 * `AppBoot`'s effect runs on every mount of `<App/>` — the error card's "Reload UI" remounts the
 * tree, and so does HMR — and a satellite only writes its row on ITS OWN mount, which a main-window
 * reload does not trigger. So the wipe erased the row for a window that was still on screen showing
 * that project, `findWindowForProject` started returning null, and capture-sends and orchestration
 * events for a torn-out project "fell through" to main: main would adopt the send and navigate onto
 * the re-dock placeholder while the satellite sat there rendering the project the user meant.
 * Checking the real window list cannot make that mistake.
 */
export function pruneWindowRegistry(liveLabels: readonly string[], store: KV = defaultStore()): boolean {
  const map = read(store);
  const live = new Set(liveLabels);
  const out: Record<string, string> = {};
  let changed = false;
  for (const [label, projectId] of Object.entries(map)) {
    if (live.has(label)) out[label] = projectId;
    else changed = true;
  }
  if (!changed) return false;
  write(store, out);
  return true;
}



export function findWindowForProject(projectId: string, store: KV = defaultStore()): string | null {
  const map = read(store);
  for (const [label, pid] of Object.entries(map)) {
    if (pid === projectId) return label;
  }
  return null;
}

