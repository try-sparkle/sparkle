// A small shared map (localStorage) of webview-window label -> the project id that window
// is currently showing. Lets any window find/focus the window already showing a project —
// including the initial "main" window, whose label can't be `project-<id>` (Tauri labels are
// immutable, and the main window can display any project after a "Replace").

export const WINDOW_REGISTRY_KEY = "sparkle-window-projects";

export type KV = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
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

function write(store: KV, map: Record<string, string>): void {
  store.setItem(WINDOW_REGISTRY_KEY, JSON.stringify(map));
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
  store.setItem(WINDOW_REGISTRY_KEY, "{}");
}

/** Is the window with this exact label currently registered (open)? Label-keyed — the symmetric
 *  counterpart to setWindowProject/clearWindowProject — so a stale entry for a project another
 *  window now shows (after a crash + "Replace") isn't mistaken for this label still being open. */
export function isWindowOpen(label: string, store: KV = defaultStore()): boolean {
  return label in read(store);
}

export function findWindowForProject(projectId: string, store: KV = defaultStore()): string | null {
  const map = read(store);
  for (const [label, pid] of Object.entries(map)) {
    if (pid === projectId) return label;
  }
  return null;
}
