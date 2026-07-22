// A small shared map (localStorage) of webview-window label -> the project id that window
// is currently showing. Lets any window find/focus the window already showing a project —
// including the initial "main" window, whose label can't be `project-<id>` (Tauri labels are
// immutable, and the main window can display any project after a "Replace").

export const WINDOW_REGISTRY_KEY = "sparkle-window-projects";

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

/** Every key currently in the store, or null when this KV can't enumerate. */
export function allKeys(store: KV): string[] | null {
  if (typeof store.key !== "function" || typeof store.length !== "number") return null;
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k != null) out.push(k);
  }
  return out;
}

/** Delete a key, tolerating a KV shim without removeItem. */
export function removeKey(store: KV, key: string): void {
  if (typeof store.removeItem === "function") store.removeItem(key);
  else store.setItem(key, "");
}

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

/** Subscribe to registry changes from THIS window (local event) and OTHER windows (storage). */
export function onWindowRegistryChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === WINDOW_REGISTRY_KEY) cb();
  };
  window.addEventListener(LOCAL_CHANGE_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LOCAL_CHANGE_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
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
 *  entries (the blob outlives the process, but windows don't). */
export function resetWindowRegistry(store: KV = defaultStore()): void {
  write(store, {}); // via write() so same-window subscribers (onWindowRegistryChange) are notified
}

/** Is the window with this exact label currently registered (open)? Label-keyed — the symmetric
 *  counterpart to setWindowProject/clearWindowProject — so a stale entry for a project another
 *  window now shows (after a crash + "Replace") isn't mistaken for this label still being open. */
export function isWindowOpen(label: string, store: KV = defaultStore()): boolean {
  return label in read(store);
}

/** Labels of every currently-registered (open) window. The sibling windowStatus channel enumerates
 *  these to find each window's own status key, instead of everyone sharing one blob (sparkle-csq2). */
export function openWindowLabels(store: KV = defaultStore()): string[] {
  return Object.keys(read(store));
}

export function findWindowForProject(projectId: string, store: KV = defaultStore()): string | null {
  const map = read(store);
  for (const [label, pid] of Object.entries(map)) {
    if (pid === projectId) return label;
  }
  return null;
}

/** The project this window is showing RIGHT NOW, or null when the label isn't registered (closed).
 *  The forward counterpart to findWindowForProject: that answers "which window shows project X?",
 *  this answers "what does window L show?". The registry is updated the moment a window opens or
 *  Replaces a project, so it is the authority any SELF-REPORTED per-window blob must be validated
 *  against before it's trusted — see windowStatus.readOtherWindowsRedAgents. */
export function getWindowProject(label: string, store: KV = defaultStore()): string | null {
  return read(store)[label] ?? null;
}
