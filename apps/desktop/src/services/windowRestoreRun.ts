// The Tauri-side execution of multi-window session restore (bead ). The DECISION is the
// pure planWindowRestore (windowRestore.ts); this module just carries out its plan against the real
// webview: apply the main window's saved geometry, recreate the other project windows, and focus the
// one the user was last active in. Called once, from the main window's cold-start effect.
import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { planWindowRestore, type MonitorRect } from "./windowRestore";
import type { WindowSessionEntry } from "./windowSession";
import { createProjectWindow } from "./projectWindows";
import { findWindowForProject } from "./windowRegistry";
import { useProjectStore } from "../stores/projectStore";

const FOCUS_RETRY_ATTEMPTS = 20;
const FOCUS_RETRY_DELAY_MS = 100;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Restore must run EXACTLY once per process. The cold-start effect has empty deps, but React
// StrictMode double-invokes effects in dev and HMR can re-run the module — either would spawn a
// second set of child windows (each createProjectWindow mints a fresh random label, so they don't
// dedupe). This process-lifetime latch short-circuits any repeat call.
let restoreRan = false;

/** Test-only: clear the run-once latch between cases. */
export function __resetWindowRestoreForTest(): void {
  restoreRan = false;
}

/** Monitor work areas in LOGICAL pixels (the unit planWindowRestore + window geometry use). Empty on
 *  any failure, which makes clampToMonitors a no-op (geometry restored verbatim) — best effort. */
async function readMonitorRects(): Promise<MonitorRect[]> {
  try {
    const monitors = await availableMonitors();
    return monitors.map((m) => {
      const pos = m.workArea.position.toLogical(m.scaleFactor);
      const size = m.workArea.size.toLogical(m.scaleFactor);
      return { x: pos.x, y: pos.y, width: size.width, height: size.height };
    });
  } catch (e) {
    console.debug("restore: reading monitors failed; skipping off-screen clamp", e);
    return [];
  }
}

/** Focus the most-recently-active restored window. The main window focuses itself; a child window is
 *  looked up via the registry (createProjectWindow registered it synchronously) and focused once its
 *  webview object exists — retried briefly because window creation is async. */
async function focusTarget(focusProjectId: string, mainProjectId: string): Promise<void> {
  if (focusProjectId === mainProjectId) {
    try {
      await getCurrentWindow().setFocus();
    } catch (e) {
      console.debug("restore: focusing main failed", e);
    }
    return;
  }
  const label = findWindowForProject(focusProjectId);
  if (!label) return;
  for (let i = 0; i < FOCUS_RETRY_ATTEMPTS; i++) {
    const win = await WebviewWindow.getByLabel(label);
    if (win) {
      try {
        await win.show();
        await win.setFocus();
      } catch (e) {
        console.debug("restore: focusing child failed", e);
      }
      return;
    }
    await delay(FOCUS_RETRY_DELAY_MS);
  }
}

/**
 * Execute session restore on the MAIN window at cold start. `sessions` is the persisted snapshot,
 * read before any registry reset. No-op outside Tauri (plain-browser dev/preview) and when there is
 * nothing to restore. The main window already adopts plan.mainProjectId synchronously (windowContext
 * initial memo, computed from the same monitor-independent selection), so this only applies its
 * geometry, spawns the other windows, and sets focus.
 */
export async function runWindowRestore(sessions: Record<string, WindowSessionEntry>): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (restoreRan) return; // idempotent: only the first invocation per process spawns windows
  restoreRan = true;
  const monitors = await readMonitorRects();
  const liveProjectIds = useProjectStore.getState().projects.map((p) => p.id);
  const plan = planWindowRestore(sessions, liveProjectIds, monitors);
  if (!plan.mainProjectId) return;

  // Apply the main window's saved geometry to THIS window.
  if (plan.mainGeometry) {
    try {
      const w = getCurrentWindow();
      await w.setPosition(new LogicalPosition(plan.mainGeometry.x, plan.mainGeometry.y));
      await w.setSize(new LogicalSize(plan.mainGeometry.width, plan.mainGeometry.height));
    } catch (e) {
      console.debug("restore: applying main geometry failed", e);
    }
  }

  // Recreate the other project windows. Suppress self-focus on every one EXCEPT the focus target so
  // they don't fight over focus as they paint (main.tsx honors ?focus=0). The focus-target child is
  // deliberately NOT suppressed: its own show-on-ready self-focus is the fast path (and a fallback if
  // focusTarget's getByLabel retry never resolves), while focusTarget below is the authority. The one
  // visible artifact of this is a brief main→child focus flash when the last-active window was a
  // child — main (no ?focus=0) self-focuses at boot before focusTarget runs. Accepted as cosmetic.
  for (const child of plan.children) {
    createProjectWindow(child.projectId, undefined, child.geometry, child.projectId !== plan.focusProjectId);
  }

  if (plan.focusProjectId) await focusTarget(plan.focusProjectId, plan.mainProjectId);
}
