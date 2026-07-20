// Captures THIS window's geometry + focus time into the durable window-session snapshot, so a
// quit/relaunch can reopen every project window where the user left it and refocus the last-active
// one (bead ). Renders no UI. Mounted per project-bearing window inside
// CurrentProjectProvider, alongside LastFocusedProjectTracker (same contract: it needs the window's
// current project). The snapshot is keyed by projectId; the actual restore reads it on cold start
// (windowContext) and executes the plan from planWindowRestore.
//
// Geometry is captured in LOGICAL pixels (via scaleFactor) because that's the unit the WebviewWindow
// constructor and setPosition/setSize all use — capture and restore never mix unit systems. Position
// uses outerPosition (top-left incl. title bar, what setPosition sets); size uses innerSize (content
// size, what the width/height options set) so a restored window reproduces the original faithfully.
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCurrentProjectId, useIsMainWindow } from "./windowContext";
import {
  readWindowSessions,
  saveWindowSession,
  removeWindowSession,
} from "./services/windowSession";

// Coalesce a burst of move/resize events into one write once the drag settles.
const CAPTURE_DEBOUNCE_MS = 400;

/** The capture effect, split from the component so the in-window Replace cleanup is unit-testable by
 *  driving projectId changes with renderHook. */
export function useWindowSessionCapture(projectId: string | null, isMain: boolean): void {
  // The project this window most recently captured. When it changes WITHOUT unmounting (an in-window
  // "Replace project"), the old entry must be dropped so restore doesn't resurrect a separate window
  // for a project the user replaced away. A ref (not the effect's closure) so we see the PREVIOUS
  // value across re-runs; unmount-on-quit never re-runs the effect, so the entry is preserved.
  const prevProjectRef = useRef<string | null>(null);

  useEffect(() => {
    // Drop the entry this window previously owned when it moves off that project — a Replace
    // (project→project) OR losing its project entirely (project→null) — so restore won't resurrect a
    // window for a project this window no longer shows. Runs BEFORE the no-project bail-out so the
    // null transition is handled too. Unmount-on-quit never re-runs the effect, so a real quit
    // preserves the entry.
    const prev = prevProjectRef.current;
    if (prev && prev !== projectId) removeWindowSession(prev);
    prevProjectRef.current = projectId;

    // A window with no project isn't restorable — nothing to capture.
    if (!projectId) return;

    // Geometry (and therefore the whole entry) needs the real Tauri window: without it there's no
    // geometry to persist, and a geometry-less entry would be dropped by planWindowRestore anyway,
    // so the capture path — focus included — no-ops in plain-browser dev/preview + jsdom.
    const hasTauri = "__TAURI_INTERNALS__" in window;

    // Preserve the focus watermark across geometry-only writes; seed from any existing entry.
    let focusedAt = readWindowSessions()[projectId]?.focusedAt ?? 0;
    let disposed = false;
    // Have we created this window's entry yet? The FIRST capture creates it; every later write must
    // only UPDATE an entry that still exists — never RESURRECT one. This is what keeps an explicit
    // close correct: Workspace.finishClose removes the entry, then win.destroy() tears the window
    // down; a debounced capture scheduled just before the close could otherwise fire during teardown
    // and re-persist the entry, reopening the window the user just closed (roborev 36136). A real
    // quit never removes the entry, so normal captures still land.
    //
    // Assumption: the first capture (scheduled synchronously on mount) completes before any close —
    // true at our operating point, since a close is seconds of UI (close prompt → confirm) while the
    // first capture resolves in microtasks. A removal landing DURING that first capture's awaits
    // would slip past the guard; not defended, as it can't occur here.
    let created = false;

    /** Skip a save that would resurrect an entry removed out from under us (explicit close). Only the
     *  first-ever create is unconditional (see the assumption above). */
    const wasRemovedUnderUs = () => created && !readWindowSessions()[projectId];

    const captureNow = async () => {
      if (!hasTauri) return;
      try {
        const win = getCurrentWindow();
        const scale = await win.scaleFactor();
        const pos = (await win.outerPosition()).toLogical(scale);
        const size = (await win.innerSize()).toLogical(scale);
        if (disposed || wasRemovedUnderUs()) return;
        saveWindowSession({
          projectId,
          isMain,
          x: Math.round(pos.x),
          y: Math.round(pos.y),
          width: Math.round(size.width),
          height: Math.round(size.height),
          focusedAt,
        });
        created = true;
      } catch (e) {
        console.debug("windowSession capture failed", e);
      }
    };

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleCapture = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void captureNow();
      }, CAPTURE_DEBOUNCE_MS);
    };

    // Focus is the same signal LastFocusedProjectTracker uses (DOM `focus` + document.hasFocus).
    // Bump the watermark and persist it together with fresh geometry — persistence still flows
    // through captureNow, so like geometry it only lands when Tauri is present.
    const markFocused = () => {
      focusedAt = Date.now();
      void captureNow();
    };
    if (typeof document !== "undefined" && document.hasFocus()) markFocused();
    window.addEventListener("focus", markFocused);

    // Initial geometry snapshot, then follow OS move/resize.
    void captureNow();
    const unlisteners: Array<Promise<() => void>> = [];
    if (hasTauri) {
      const win = getCurrentWindow();
      unlisteners.push(win.onMoved(() => scheduleCapture()));
      unlisteners.push(win.onResized(() => scheduleCapture()));
    }

    // No beforeunload flush: captureNow already persists synchronously on every move/resize/focus, so
    // the last settled geometry is always in localStorage at quit. A flush would only re-write that
    // same last-settled geometry — redundant, and (as roborev 36136 found) a resurrection vector, because an
    // explicit close removes the entry and then destroy() fires beforeunload on the still-mounted
    // component. Dropping it removes that whole class of bug; the only cost is a move made within the
    // 400ms debounce right before quitting (its debounced capture, and thus the flush, never ran
    // either way).

    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      window.removeEventListener("focus", markFocused);
      unlisteners.forEach((p) => void p.then((u) => u()).catch(() => {}));
    };
  }, [projectId, isMain]);
}

export function WindowSessionCapture() {
  useWindowSessionCapture(useCurrentProjectId(), useIsMainWindow());
  return null;
}
