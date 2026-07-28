// Drop files (images or anything else) onto an agent's TERMINAL to attach them to that agent's
// next message. Successor to useDragVisionHint, which listened for the same drag and could only
// explain that images had nowhere to go — CM-U7 removed the pane composer, so the terminal was a
// dead end. It isn't any more: the concierge box grew a real attachment list (parity row #21,
// hooks/useConciergeAttachments), and this hook is the surface that routes a terminal drop into it.
//
// ONE ATTACHMENT MECHANISM. The paths land in the SAME staged list the box's Screenshot / Image /
// Files buttons fill and render as the same removable chips — this hook adds a way to REACH that
// list, not a second list. The hand-off runs through stores/terminalDropStore; see its header.
//
// WHICH AGENT. Tauri's onDragDropEvent is webview-GLOBAL: the payload carries a cursor position and
// no target element, and with dragDropEnabled on there are no HTML5 drop events to lean on. So the
// terminal stage marks itself `data-dnd-target="terminal-stage"` and we hit-test the position
// against the DOM (services/dndTargets). That ALONE is not enough to name an agent — every visited
// agent's pane stays MOUNTED and stacked in that one stage (Workspace keeps them alive so a tab
// switch can't kill a PTY), so several panes sit under the cursor and elementFromPoint cannot tell
// them apart. The disambiguator is `enabled`: the caller passes "this pane is VISIBLE", exactly one
// pane is, and only that pane's copy of this hook subscribes. A background pane never listens, so
// it can never claim a drop.
//
// Like useNewBuildAgentDrop this is a webview-level listener and Tauri fans events out to every one
// of them, so they coexist. The "+ New Build Agent" empty-state button is nested INSIDE the stage
// and owns its drops (it spawns a NEW agent for them), so we hit-test it ourselves and stand down —
// the same carve-out, and the same no-listener-ordering-assumption, that Composer.tsx makes.
//
// NON-IMAGE FILES ARE ACCEPTED, exactly like every other drop path: the payload is a list of
// absolute paths prefixed to the prompt for the agent to read off disk, and a .log or a .csv is as
// readable as a .png. The only thing image-ness decides is the wording of the confirmation.
import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isImagePath } from "../components/composer/attachments";
import { useTerminalDropStore } from "../stores/terminalDropStore";
import { useUiStore } from "../stores/uiStore";
import {
  isOverDndTarget,
  NEW_BUILD_AGENT_DND_TARGET,
  reportDropWithNoTarget,
  TERMINAL_STAGE_DND_TARGET,
} from "../services/dndTargets";
import { safeUnlisten } from "../services/safeUnlisten";
import { describePaths } from "../services/logSafePaths";
import { log } from "../logger";

/** True when this drag position belongs to the terminal: over the stage, and NOT over the
 *  "+ New Build Agent" button nested inside it (that button's own listener owns those drops).
 *  Pure apart from the DOM hit-test, so the precedence rule is testable on its own. */
export function isTerminalDropPosition(position: { x: number; y: number }): boolean {
  return (
    isOverDndTarget(position, TERMINAL_STAGE_DND_TARGET) &&
    !isOverDndTarget(position, NEW_BUILD_AGENT_DND_TARGET)
  );
}

/** What landed, for the confirmation pill. `images` is a subset of `count` — a mixed drop reports
 *  both, so the copy never calls a .csv an image. */
export interface TerminalDropResult {
  count: number;
  images: number;
}

export interface TerminalDrop {
  /** A drag is currently over this pane's terminal — render the "drop here" affordance. */
  dropActive: boolean;
  /** The most recent drop this pane accepted, until dismissed. */
  dropped: TerminalDropResult | null;
  dismiss: () => void;
}

/**
 * Subscribe (only while `enabled` — i.e. this pane is the visible one) to webview drag/drop and
 * attach anything dropped on the terminal to `agentId`'s next message.
 *
 * The paths are handed to the compose box's staged list and the box is given the caret, so the
 * user's very next send carries them. Queueing rather than SENDING is deliberate: a bare file path
 * is not a prompt, and firing an agent turn the user never typed is exactly what an explicit Send
 * exists to prevent.
 */
export function useTerminalDrop(enabled: boolean, agentId: string | null): TerminalDrop {
  const [dropActive, setDropActive] = useState(false);
  const [dropped, setDropped] = useState<TerminalDropResult | null>(null);
  const dismiss = useCallback(() => setDropped(null), []);
  useEffect(() => {
    // No setState on this path: a disabled pane's state is cleared by the CLEANUP of the run that
    // was enabled (React only calls the previous effect's cleanup, so disabled→enabled has nothing
    // to clear, and enabled→disabled clears exactly once). Resetting in the effect body instead
    // would be a synchronous cascading render on every mount of every background pane.
    if (!enabled || !agentId) return;
    // UNLISTENING IS ASYNCHRONOUS. safeUnlisten has to AWAIT the listen() promise before it can
    // call the unlisten fn, and in a real webview that resolution is an IPC round-trip. So between
    // "this pane stopped being visible" and "Tauri stopped calling us" there is a window in which
    // the OLD pane's handler is still registered ALONGSIDE the newly-visible pane's — and a drop
    // landing in that window is delivered to both, attaching the same files to TWO agents. An
    // async teardown cannot close a synchronous gap; this flag can, and does it on the first line
    // of cleanup so the stale handler is inert before the promise has even settled.
    let live = true;
    let unlistenPromise: Promise<(() => void) | undefined>;
    try {
      unlistenPromise = getCurrentWebview()
        .onDragDropEvent((event) => {
          if (!live) return;
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            setDropActive(isTerminalDropPosition(p.position));
          } else if (p.type === "leave") {
            setDropActive(false);
          } else if (p.type === "drop") {
            setDropActive(false);
            if (!isTerminalDropPosition(p.position)) {
              // Silent when some other target owns the drop; speaks only for a drop that matched
              // no target at all (services/dndTargets.reportDropWithNoTarget).
              reportDropWithNoTarget(p.position);
              return;
            }
            const paths = p.paths ?? [];
            if (paths.length === 0) return;
            // Kinds and counts, never paths — the log ships with support tickets and crash reports
            // (see services/logSafePaths).
            log.info("composer", `dropped ${paths.length} file(s) on the terminal`, {
              agentId,
              ...describePaths(paths),
            });
            useTerminalDropStore.getState().enqueue(agentId, paths);
            // Give the one compose box the caret, so the files the user just dropped are visibly
            // staged where they will be sent from and they can type the ask straight away.
            useUiStore.getState().requestComposeFocus();
            setDropped({ count: paths.length, images: paths.filter(isImagePath).length });
          }
        })
        .catch((e) => {
          // A failed listen has no unlisten fn to return; log and let cleanup no-op.
          log.error("composer", "terminal drop listen failed", e);
          return undefined;
        });
    } catch (e) {
      // The pane mounts in the plain-browser dev preview too, where `getCurrentWebview()` throws
      // synchronously. Drop-to-attach is simply unavailable there; everything else still works.
      log.error("composer", "terminal drop unavailable", e);
      return;
    }
    return () => {
      live = false;
      setDropActive(false);
      // A pane that is no longer the visible one has no business still showing a confirmation for
      // a drop the user made on it — and the files are staged regardless, so nothing is lost.
      setDropped(null);
      // safeUnlisten awaits the listen() promise so a handler that resolves AFTER unmount is still
      // torn down (and the Tauri teardown race is swallowed).
      void safeUnlisten(unlistenPromise);
    };
  }, [enabled, agentId]);
  return { dropActive, dropped, dismiss };
}
