// Pure decision logic for multi-window session restore (bead ). Kept free of any Tauri
// dependency so the restore DECISION unit-tests without a webview — the thin Tauri glue in
// windowContext feeds it the persisted sessions + live project ids + monitor rects and then just
// executes the plan (adopt main geometry, create child windows, focus one). Mirrors how
// planWindowClose isolates the close decision from the Workspace side effects.

import type { WindowSessionEntry } from "./windowSession";

/** A window rectangle in LOGICAL pixels (matches WindowSessionEntry + Tauri logical geometry). */
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A monitor's work area in LOGICAL pixels. */
export type MonitorRect = Geometry;

// A restored window must land with at least this much of it on some monitor, so the user can always
// grab its title bar even if a monitor was unplugged/rearranged since last session. Width lets you
// reach the traffic lights; height covers the title bar strip.
const MIN_VISIBLE_W = 120;
const MIN_VISIBLE_H = 40;

function intersectionArea(a: Geometry, b: Geometry): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h;
}

/** Is the window's TITLE BAR grabbable on this monitor? That's what "reachable" really means: a
 *  window bigger than the screen, or with its top edge above the menu bar, is unusable even though
 *  its body overlaps the monitor. Require the top edge to sit within the monitor vertically and the
 *  title-bar row to overlap horizontally by a graspable amount. */
function titleBarReachable(g: Geometry, m: MonitorRect): boolean {
  const overlapW = Math.max(0, Math.min(g.x + g.width, m.x + m.width) - Math.max(g.x, m.x));
  const topOnScreen = g.y >= m.y && g.y <= m.y + m.height - MIN_VISIBLE_H;
  return overlapW >= MIN_VISIBLE_W && topOnScreen;
}

/** Ensure a window's saved geometry is reachable on the current monitor layout. If its title bar is
 *  already grabbable on some monitor, it's returned unchanged (the common case — nothing moved).
 *  Only when it would restore off-screen — a monitor was unplugged or the layout changed — is it
 *  re-homed onto the monitor it most overlaps (or the first monitor), shrunk to fit and clamped so
 *  its title bar is on-screen. With no monitor info, geometry is returned as-is (best effort). */
export function clampToMonitors(geometry: Geometry, monitors: MonitorRect[]): Geometry {
  if (monitors.length === 0) return geometry;

  // Already reachable on some monitor? Leave it exactly where the user had it.
  if (monitors.some((m) => titleBarReachable(geometry, m))) return geometry;

  // Re-home onto the best-overlap monitor, else the first (primary-ish) monitor. monitors is
  // non-empty here (guarded above), so monitors[0] is defined.
  let target: MonitorRect = monitors[0]!;
  let best = -1;
  for (const m of monitors) {
    const area = intersectionArea(geometry, m);
    if (area > best) {
      best = area;
      target = m;
    }
  }
  const width = Math.min(geometry.width, target.width);
  const height = Math.min(geometry.height, target.height);
  // Clamp top-left so the whole (possibly shrunk) window sits inside the target monitor.
  const x = Math.min(Math.max(geometry.x, target.x), target.x + target.width - width);
  const y = Math.min(Math.max(geometry.y, target.y), target.y + target.height - height);
  return { x, y, width, height };
}

export interface RestorePlan {
  /** Project the main OS window should adopt (its window is reused, not recreated). Null when there
   *  is nothing to restore — the caller then falls back to its normal initial-project logic. */
  mainProjectId: string | null;
  /** Clamped geometry to apply to the main window, or null when there is no session to restore. */
  mainGeometry: Geometry | null;
  /** Other project windows to (re)create, each with its clamped geometry. */
  children: Array<{ projectId: string; geometry: Geometry }>;
  /** Project whose window should be focused after restore (the most-recently-active). Null when
   *  there is nothing to restore. May equal mainProjectId. */
  focusProjectId: string | null;
}

/** A captured geometry we trust enough to restore. Guards against a degenerate capture (0/negative
 *  size) that would otherwise open an unusable sliver. */
function validGeometry(e: WindowSessionEntry): boolean {
  return e.width > 0 && e.height > 0;
}

/**
 * Decide how to restore the previous session's windows.
 *
 * - Drops entries whose project no longer exists (deleted between launches) or whose geometry is
 *   degenerate.
 * - The MAIN window adopts the entry flagged `isMain`; if none is flagged (or several are), the
 *   most-recently-focused surviving entry becomes main. Every other entry becomes a child window.
 * - Focus goes to the surviving entry with the greatest `focusedAt` (the window the user was last
 *   active in), main or child.
 * - All geometry is clamped to the given monitors so nothing restores off-screen.
 *
 * With no surviving entries, returns an all-null/empty plan so the caller restores nothing and keeps
 * its existing single-window behavior.
 */
export function planWindowRestore(
  sessions: Record<string, WindowSessionEntry>,
  liveProjectIds: Iterable<string>,
  monitors: MonitorRect[],
): RestorePlan {
  const live = new Set(liveProjectIds);
  const surviving = Object.values(sessions).filter((e) => live.has(e.projectId) && validGeometry(e));

  if (surviving.length === 0) {
    return { mainProjectId: null, mainGeometry: null, children: [], focusProjectId: null };
  }

  const byFocusDesc = [...surviving].sort((a, b) => b.focusedAt - a.focusedAt);
  // surviving is non-empty (guarded above), so byFocusDesc[0] is defined.
  const focusEntry = byFocusDesc[0]!;
  // Main = the flagged isMain entry (most-recent one if the flag somehow duplicated), else the
  // most-recently-focused surviving entry.
  const mainEntry = byFocusDesc.find((e) => e.isMain) ?? focusEntry;

  const clampGeom = (e: WindowSessionEntry): Geometry =>
    clampToMonitors({ x: e.x, y: e.y, width: e.width, height: e.height }, monitors);

  const children = surviving
    .filter((e) => e.projectId !== mainEntry.projectId)
    .map((e) => ({ projectId: e.projectId, geometry: clampGeom(e) }));

  return {
    mainProjectId: mainEntry.projectId,
    mainGeometry: clampGeom(mainEntry),
    children,
    focusProjectId: focusEntry.projectId,
  };
}
