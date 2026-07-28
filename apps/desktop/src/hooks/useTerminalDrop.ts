// Drop files (images or anything else) onto an agent's TERMINAL and the paths are pasted into THAT
// TERMINAL, at its current input line.
//
// A DROP LANDS WHERE IT IS DROPPED. This used to hand the paths to the concierge compose box
// instead (via stores/terminalDropStore → hooks/useConciergeAttachments), so a screenshot dragged
// onto an agent's terminal surfaced as a chip in the Sparkle box on the far side of the window —
// and reached the agent only if the user then typed there AND the auto-router happened to aim that
// send at the agent rather than at Sparkle. Two indirections and a classifier between "I dropped it
// here" and "it went here", which users read — correctly — as the app ignoring where they dropped.
// Dropping on the CONCIERGE column still attaches to the concierge box
// (hooks/useConciergeAttachments): every surface takes its own drops, which is the whole rule.
//
// PASTE, NEVER SEND. The paths go in as ONE bracketed paste with NO carriage return, exactly like
// dragging a file into Terminal.app or iTerm — the text sits in the CLI's prompt for the user to
// type their ask around and submit themselves. A bare path is not a prompt, and firing a turn the
// user never wrote is what an explicit Enter exists to prevent. That care matters more here than it
// did when this staged a chip: a terminal write cannot be taken back.
//
// WHY A PATH AND NOT THE IMAGE ITSELF. The agent CLIs read files off disk — the same trick the
// composer's attachments have always used (an Attachment's `path` is what gets prefixed to the CLI
// payload; the dataUrl it may also carry is for Sparkle's own thumbnail, not for the agent). So an
// absolute path is the payload for a .png exactly as it is for a .log, which is why NON-IMAGE FILES
// ARE ACCEPTED on this path as on every other. Image-ness decides one thing only: the wording of the
// confirmation.
//
// WHICH AGENT. Tauri's onDragDropEvent is webview-GLOBAL: the payload carries a cursor position and
// no target element, and with dragDropEnabled on there are no HTML5 drop events to lean on. So the
// terminal stage marks itself `data-dnd-target="terminal-stage"` and we hit-test the position
// against the DOM (services/dndTargets). That ALONE is not enough to name an agent — every visited
// agent's pane stays MOUNTED and stacked in that one stage (Workspace keeps them alive so a tab
// switch can't kill a PTY), so several panes sit under the cursor and elementFromPoint cannot tell
// them apart. The disambiguator is `enabled`: the caller passes "this pane is VISIBLE", exactly one
// pane is, and only that pane's copy of this hook subscribes. A background pane never listens, so
// it can never claim a drop — and, now that a drop WRITES, that is what keeps the bytes out of the
// wrong agent's session.
//
// Like useNewBuildAgentDrop this is a webview-level listener and Tauri fans events out to every one
// of them, so they coexist. The "+ New Build Agent" empty-state button is nested INSIDE the stage
// and owns its drops (it spawns a NEW agent for them), so we hit-test it ourselves and stand down —
// the same carve-out, and the same no-listener-ordering-assumption, that Composer.tsx makes.
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isImagePath } from "../components/composer/attachments";
import { pasteIntoPty, PtyGoneError } from "../pty";
import { shellQuotePath } from "../services/shellQuote";
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

/**
 * What gets typed into the terminal for a set of dropped paths: each path SHELL-quoted so it is one
 * inert token (services/shellQuote — AgentPane mounts this hook for `kind: "shell"` panes too,
 * where the input line is a real shell), space-joined, with a TRAILING SPACE so whatever the user
 * types next isn't glued onto the last path.
 */
export function buildDroppedPathsPaste(paths: string[]): string {
  return `${paths.map(shellQuotePath).join(" ")} `;
}

/** What landed, for the confirmation pill. `images` is a subset of `count` — a mixed drop reports
 *  both, so the copy never calls a .csv an image. */
export interface TerminalDropResult {
  count: number;
  images: number;
  /** False when the paste did NOT land, because the agent's PTY was gone by the time the drop
   *  arrived. The pill must say so: claiming a delivery that did not happen is the one thing a
   *  confirmation cannot do, and the user's file is otherwise silently nowhere. */
  delivered: boolean;
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
 * paste anything dropped on the terminal into `agentId`'s PTY, at its current input line.
 *
 * `onPasted` runs after a paste actually lands (never after a failed one) — the caller uses it to
 * put the caret in the terminal, so the user can type the ask straight onto the text they can see
 * sitting there. Read through a ref, so passing an inline arrow doesn't re-subscribe the listener
 * on every render.
 */
export function useTerminalDrop(
  enabled: boolean,
  agentId: string | null,
  onPasted?: () => void,
): TerminalDrop {
  const [dropActive, setDropActive] = useState(false);
  const [dropped, setDropped] = useState<TerminalDropResult | null>(null);
  const dismiss = useCallback(() => setDropped(null), []);
  const onPastedRef = useRef(onPasted);
  useEffect(() => {
    onPastedRef.current = onPasted;
  }, [onPasted]);
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
    // landing in that window is delivered to both, pasting the same files into TWO agents'
    // terminals. An async teardown cannot close a synchronous gap; this flag can, and does it on
    // the first line of cleanup so the stale handler is inert before the promise has even settled.
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
            log.info("composer", `pasting ${paths.length} dropped file(s) into the terminal`, {
              agentId,
              ...describePaths(paths),
            });
            const result = { count: paths.length, images: paths.filter(isImagePath).length };
            void pasteIntoPty(agentId, buildDroppedPathsPaste(paths))
              .then(() => {
                // The pane may have been hidden while the write was in flight; a background pane
                // owns no confirmation and must not steal the caret from the visible one.
                if (!live) return;
                onPastedRef.current?.();
                setDropped({ ...result, delivered: true });
              })
              .catch((e) => {
                // A dead PTY is the expected failure (the agent exited), and the ONLY one the pill
                // can explain in the user's terms. Anything else is a real fault worth a log line —
                // but the pill says the same thing either way, because from the user's side the
                // fact that matters is identical: the files did not land.
                if (!(e instanceof PtyGoneError)) {
                  log.error("composer", "terminal drop paste failed", e);
                }
                if (!live) return;
                setDropped({ ...result, delivered: false });
              });
          }
        })
        .catch((e) => {
          // A failed listen has no unlisten fn to return; log and let cleanup no-op.
          log.error("composer", "terminal drop listen failed", e);
          return undefined;
        });
    } catch (e) {
      // The pane mounts in the plain-browser dev preview too, where `getCurrentWebview()` throws
      // synchronously. Drop-to-terminal is simply unavailable there; everything else still works.
      log.error("composer", "terminal drop unavailable", e);
      return;
    }
    return () => {
      live = false;
      setDropActive(false);
      // A pane that is no longer the visible one has no business still showing a confirmation for
      // a drop the user made on it — and the paste already landed in its terminal, where it stays.
      setDropped(null);
      // safeUnlisten awaits the listen() promise so a handler that resolves AFTER unmount is still
      // torn down (and the Tauri teardown race is swallowed).
      void safeUnlisten(unlistenPromise);
    };
  }, [enabled, agentId]);
  return { dropActive, dropped, dismiss };
}
