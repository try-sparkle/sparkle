// A durable, cross-session snapshot of the project windows that were open at quit time — so a
// relaunch can reopen them all at their saved size/position and refocus the most-recently-active
// one (bead ). Deliberately SEPARATE from the live `sparkle-window-projects` registry
// (windowRegistry.ts): that map is label→projectId, rebuilt every session and wiped on cold start;
// this snapshot survives the reset and is what restore reads.
//
// Keyed by projectId, not window label: labels are opaque `win-<uuid>` values regenerated every
// session (the "main" window aside), so they can't be matched across a relaunch. A project shows in
// at most one window (enforced by findWindowForProject), so projectId is the stable identity.

import type { KV } from "./windowRegistry";
import { defaultStore } from "./windowRegistry";

export const WINDOW_SESSION_KEY = "sparkle-window-session";

export interface WindowSessionEntry {
  projectId: string;
  /** Was this the main OS window last session. On restore the main window adopts this entry's
   *  project (others become `win-<uuid>` windows) — which OS window is "main" may thus differ from
   *  last session, by design (only project + geometry + focus fidelity matters). */
  isMain: boolean;
  // LOGICAL pixels (device-independent). Logical is used everywhere — the WebviewWindow constructor
  // and setPosition/setSize all default to logical — so capture and restore never mix unit systems.
  x: number;
  y: number;
  width: number;
  height: number;
  /** Date.now() stamped whenever this window gains focus. The entry with the max focusedAt is the
   *  window to refocus on restore. */
  focusedAt: number;
}

function read(store: KV): Record<string, WindowSessionEntry> {
  try {
    const raw = store.getItem(WINDOW_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Reject arrays too (typeof [] === "object"): the map is keyed by projectId, so an array blob
    // would surface numeric indices as keys — return {} instead of a shape that violates the type.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, WindowSessionEntry>)
      : {};
  } catch {
    return {};
  }
}

function write(store: KV, map: Record<string, WindowSessionEntry>): void {
  store.setItem(WINDOW_SESSION_KEY, JSON.stringify(map));
}

/** All persisted window sessions, keyed by projectId. Best-effort: a malformed/absent blob → {}. */
export function readWindowSessions(store: KV = defaultStore()): Record<string, WindowSessionEntry> {
  return read(store);
}

/** Persist (create or replace) one window's session entry. Read-modify-write by projectId so a
 *  sibling window's entry is never clobbered by this write. */
export function saveWindowSession(entry: WindowSessionEntry, store: KV = defaultStore()): void {
  const map = read(store);
  map[entry.projectId] = entry;
  write(store, map);
}

/** Drop a project's session entry — called when the user EXPLICITLY closes (destroys) its window,
 *  so a relaunch doesn't reopen a window the user deliberately closed. NOT called on quit. */
export function removeWindowSession(projectId: string, store: KV = defaultStore()): void {
  const map = read(store);
  if (projectId in map) {
    delete map[projectId];
    write(store, map);
  }
}

/** Wipe every session entry. */
export function clearAllWindowSessions(store: KV = defaultStore()): void {
  write(store, {});
}
