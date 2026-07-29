// "Select it and it's yours": releasing a text selection inside the concierge thread copies it
// (PRD 1 §1). Mounted ONCE, on the thread's scroll container — never per message — so a selection
// that spans two bubbles is one copy rather than N, and so the listener count doesn't grow with the
// conversation.
//
// PLAIN TEXT, deliberately (`sel.toString()`), even though the answer it came from is markdown. A
// partial selection has no markdown source: the user dragged across RENDERED words, and the raw
// `m.text` behind them is a different, longer string that starts and ends somewhere else. Copying it
// would hand back text nobody highlighted. The whole-answer button is the opposite case and copies
// the source verbatim — see CopyAnswerButton for why the two differ.
//
// SCOPE: this is the CONCIERGE column's affordance. The terminal already auto-copies its own
// selection (see Terminal.tsx / SelectionPopup.tsx); do not mount this there, and do not remove
// that.
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { copyToClipboard } from "../../clipboard";

/** How long the check-mark confirmation stays up. Long enough to register as an answer to the
 *  gesture, short enough that it is gone before the eye goes looking for what it covers. */
export const COPY_TOAST_MS = 1200;

/** Quiet period after the last `selectionchange` before a KEYBOARD selection counts as finished.
 *
 *  A mouse selection announces its own end (`mouseup`); shift+arrow has no such event — it just
 *  stops. Copying on every `selectionchange` would write the clipboard once per keystroke and
 *  announce once per keystroke, which is the flooding the column's live region exists to avoid. */
export const KEYBOARD_SELECTION_DEBOUNCE_MS = 300;

export interface CopyOnSelectionOptions {
  /** The user's "Copy on selection" preference. False → nothing is listened for at all. */
  enabled: boolean;
  /** Something was copied. The integration layer announces it through the column's ONE live region
   *  (see ConciergeColumnProps.announcement) — this hook must never add a second one. */
  onCopied?: () => void;
}

/**
 * Copy the user's selection when they finish making it. Returns whether the confirmation toast
 * should currently be showing.
 *
 * @param containerRef the thread's scroll container — the selection must live INSIDE it.
 */
export function useCopyOnSelection(
  containerRef: RefObject<HTMLElement | null>,
  { enabled, onCopied }: CopyOnSelectionOptions,
): boolean {
  const [copied, setCopied] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether this hook's component is still mounted. The clipboard write is ASYNC, so its `.then`
  // can land after an unmount and would otherwise set state on a dead component.
  const alive = useRef(true);
  // Kept in a ref so a caller that passes an inline arrow doesn't re-attach every listener on every
  // render of the thread — which the host re-renders several times a second.
  const onCopiedRef = useRef(onCopied);

  useEffect(() => {
    onCopiedRef.current = onCopied;
  }, [onCopied]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      toastTimer.current = null;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    // The last string this hook copied, or null once the selection has been torn down. It exists
    // for the DOUBLE-CLICK path: a dblclick arrives as mousedown/mouseup/mousedown/mouseup/dblclick,
    // so the word-select is already complete by the second `mouseup` and BOTH that and the `dblclick`
    // would copy it. One clipboard write is harmless; two announcements into the live region are
    // not. Reset by `mousedown` (which collapses the selection) so re-selecting the same words
    // later still copies and still confirms.
    let lastCopied: string | null = null;

    const cancelPending = () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    };

    const showToast = () => {
      setCopied(true);
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => {
        toastTimer.current = null;
        setCopied(false);
      }, COPY_TOAST_MS);
    };

    const copySelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        lastCopied = null;
        return;
      }
      // THE GUARD THAT KEEPS FOREIGN TEXT OUT. Without it a drag that starts in the thread and ends
      // in the compose box — or one that starts outside and ends here — copies whatever the range
      // swept up on the way, silently replacing the user's clipboard with text they never
      // highlighted in this column.
      //
      // BOTH ends, not just the anchor. The anchor alone covers "started elsewhere" (the `mouseup`
      // listener is on the container, so that is the shape it can see); the focus end covers the
      // mirror case, which reaches us anyway through the document-level `selectionchange` path.
      const { anchorNode, focusNode } = sel;
      if (!anchorNode || !focusNode) return;
      if (!container.contains(anchorNode) || !container.contains(focusNode)) return;
      // PLAIN TEXT — the rendered words, not the markdown behind them. See this file's header.
      const text = sel.toString();
      // Whitespace-only selections are an accident of dragging, never an intent to copy. A blank
      // clipboard and a "Copied" toast for it are both worse than doing nothing.
      if (!text.trim()) return;
      if (text === lastCopied) return;
      // CLAIM IT SYNCHRONOUSLY, before the write starts.
      //
      // Assigning `lastCopied` inside the `.then()` looks equivalent and is not: the guard above is
      // synchronous, and a real double-click dispatches mousedown/mouseup/mousedown/mouseup/dblclick
      // back-to-back with no microtask checkpoint between them. `copyToClipboard` is an IPC round
      // trip, so it has NOT resolved by the time `dblclick` arrives — `lastCopied` would still be
      // null, the guard would pass, and one gesture would write the clipboard twice and, worse,
      // announce twice into the column's single live region (roborev 52648/53010/53088, again).
      //
      // AND THE CLAIM SURVIVES A FAILURE. It used to be rolled back, so that repeating the gesture
      // could retry a genuinely failed write — but a retry does not need the rollback, because
      // `mousedown` below already clears the claim, and a repeated gesture starts with one. What the
      // rollback bought instead was a LIVE-LOCK, once `copyToClipboard`'s fallback began restoring
      // the selection it steals: the restore dispatches `selectionchange` (twice — `removeAllRanges`
      // then `addRange`), which re-arms the 300ms debounce below; the debounce fires, finds the
      // claim cleared, copies the same words, fails again, restores again, re-arms again — for as
      // long as the selection stands, appending a textarea and yanking focus out of whatever the
      // user is typing in on every lap. The success path was never exposed: the claim still matches,
      // so the restore's `selectionchange` early-returns.
      //
      // Keeping the claim breaks that edge at its source. A failed write costs the user one repeat
      // of the gesture; it does not cost them a 300ms loop they cannot escape without clicking.
      lastCopied = text;
      void copyToClipboard(text).then((ok) => {
        // A failed write must not claim success: no toast, no announcement. The claim stays, so the
        // next GESTURE retries (via `mousedown`) while the selection sitting there does not.
        if (!ok) return;
        if (!alive.current) return;
        showToast();
        onCopiedRef.current?.();
      });
    };

    // A press begins a NEW selection, so whatever we copied last is no longer the thing on screen.
    const onMouseDown = () => {
      lastCopied = null;
    };

    // Mouse-driven selections announce their own end. `dblclick` (word) and the third click of a
    // triple-click (paragraph) both land as a `mouseup` here too; the dblclick listener is kept
    // because a double-click can complete without a mouseup we'd recognise on some platforms, and
    // `lastCopied` makes the overlap free.
    const onMouseUp = () => {
      cancelPending();
      copySelection();
    };

    // Keyboard selection (shift+arrows, ⌘A) — no gesture-end event, so settle for a quiet period.
    // Also fires DURING a mouse drag; the `mouseup` above cancels the pending timer, so the drag
    // resolves through the mouse path rather than firing twice.
    const onSelectionChange = () => {
      cancelPending();
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        copySelection();
      }, KEYBOARD_SELECTION_DEBOUNCE_MS);
    };

    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("dblclick", onMouseUp);
    // Document-level because that is the only place `selectionchange` is dispatched.
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      cancelPending();
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("dblclick", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [enabled, containerRef]);

  return copied;
}
