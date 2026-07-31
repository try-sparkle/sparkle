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

/**
 * The selection, CUT to the parts of it that lie inside `container`. Empty string when it does not
 * reach in here at all.
 *
 * This replaces a both-ends-inside test that copied NOTHING whenever either end fell outside, and
 * the difference is the whole of "selecting to the end of an answer". Selecting the last line of a
 * reply means overshooting past it, so the drag ends on the compose box or the column edge — a
 * shape the strict guard read as foreign text and dropped on the floor, leaving the user with a
 * highlight, no clipboard write, and no reason given.
 *
 * Clamping keeps the guard's actual promise (no words from another surface ever reach the
 * clipboard through this path) because the range is cut at the container's own bounds. What it
 * gives up is only the refusal. A selection with NEITHER end in here — the drag that lives entirely
 * in the compose box — still copies nothing; that one is not this column's gesture at all.
 */
export function selectionWithin(sel: Selection, container: HTMLElement): string {
  if (sel.rangeCount === 0) return "";
  // WAS THIS GESTURE AIMED AT THIS COLUMN AT ALL? Asked against the concierge ROOT rather than the
  // thread, because the enclosure case this function exists to serve — anchor in the column header,
  // focus in the compose box — has both endpoints outside the thread but both inside the column.
  //
  // A pure intersection test cannot tell that apart from `⌘A` with focus on the body, whose range
  // spans the whole document and therefore straddles the thread as well. That is a select-all aimed
  // at whatever the user was looking at, and treating it as this column's gesture would silently
  // replace their clipboard with the entire transcript. Falls back to the thread itself when there
  // is no root above it, so this can only ever narrow what is accepted, never widen it.
  const scope = container.closest<HTMLElement>("[data-concierge-root]") ?? container;
  const { anchorNode, focusNode } = sel;
  const aimedHere =
    (!!anchorNode && scope.contains(anchorNode)) || (!!focusNode && scope.contains(focusNode));
  if (!aimedHere) return "";
  const bounds = document.createRange();
  bounds.selectNodeContents(container);
  let out = "";
  for (let i = 0; i < sel.rangeCount; i++) {
    // Cloned: `setStart`/`setEnd` mutate, and mutating the live range would move the user's
    // highlight — the exact class of damage this hook is being fixed for.
    const r = sel.getRangeAt(i).cloneRange();
    // DOES THIS RANGE OVERLAP THE THREAD AT ALL? Asked as a range intersection rather than as "is
    // either endpoint inside the container", because an endpoint test misses the selection that
    // ENCLOSES the thread — anchor in the column header, focus in the compose box, which is what
    // dragging from the top of the column to the bottom produces. That shape has neither end inside,
    // so an endpoint test rejected it: the whole transcript highlighted, nothing copied, nothing
    // said. It is the clamp's easiest case once it gets past the guard.
    //
    // Overlap is `r.end > bounds.start && r.start < bounds.end`. A selection wholly above or wholly
    // below the thread — the drag that lives entirely in the compose box — fails one of the two and
    // still copies nothing, which is the containment promise this guard exists for.
    const endsAfterThreadStarts = r.compareBoundaryPoints(Range.START_TO_END, bounds) > 0;
    const startsBeforeThreadEnds = r.compareBoundaryPoints(Range.END_TO_START, bounds) < 0;
    if (!endsAfterThreadStarts || !startsBeforeThreadEnds) continue;
    if (r.compareBoundaryPoints(Range.START_TO_START, bounds) < 0)
      r.setStart(bounds.startContainer, bounds.startOffset);
    if (r.compareBoundaryPoints(Range.END_TO_END, bounds) > 0)
      r.setEnd(bounds.endContainer, bounds.endOffset);
    out += r.toString();
  }
  return out;
}

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

    /**
     * Is the primary button DOWN — i.e. is the user still dragging out their selection?
     *
     * THE FOUNDER'S ANCHOR BUG LIVES HERE ("when I copy boxes sometimes the part where I started
     * copying loses its initial anchor location"). Dragging across several messages is slow: the
     * reader pauses to read, or holds at the edge waiting for the thread to auto-scroll. Every one
     * of those pauses used to outlast the keyboard debounce below, which fired a copy MID-GESTURE —
     * and `copyToClipboard`'s execCommand fallback (the path this webview actually takes whenever
     * `navigator.clipboard` is unavailable) tears the live selection down with `removeAllRanges`
     * and rebuilds it with `addRange`. Doing that under a held mouse button relocates the anchor
     * the browser is extending from, so the highlight jumps back to where the restore put it and
     * the user watches their start point move.
     *
     * The debounce exists for KEYBOARD selections, which have no gesture-end event. A mouse drag
     * has one, so it never needed the debounce — it only ever suffered from it.
     */
    let dragging = false;

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
      // THE GUARD THAT KEEPS FOREIGN TEXT OUT — now by CUTTING the range at this container's bounds
      // rather than refusing anything that crosses them. Without some form of it, a drag that starts
      // in the thread and ends in the compose box copies whatever the range swept up on the way,
      // silently replacing the user's clipboard with text they never highlighted in this column.
      // See `selectionWithin` for why clamping replaced the both-ends-inside refusal.
      //
      // PLAIN TEXT — the rendered words, not the markdown behind them. See this file's header.
      const text = selectionWithin(sel, container);
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

    // A press begins a NEW selection, so whatever we copied last is no longer the thing on screen —
    // and from here until the release, the user owns the selection and this hook must not touch it.
    // Primary button only: a right-click opens the context menu over a selection the reader means
    // to keep, and a secondary press is not the start of a drag.
    //
    // ON THE DOCUMENT, matching the release. Bound to the container this was ASYMMETRIC, and the
    // clamp above is what made that dangerous: a drag that starts in the COMPOSE BOX and comes up
    // into the transcript — the mirror of the overshoot case — never set this flag, so the debounce
    // was not suppressed and a mid-drag pause fired a copy under the held button. That shape used to
    // be harmless only because the both-ends-inside guard refused to copy it at all; now that the
    // clamp makes it copyable, leaving the press container-scoped would re-open the very bug this
    // hook is being fixed for. Nothing downstream needs the press to have landed in the thread —
    // `copySelection` refuses selections that do not reach in.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      // NO CLAIM RESET HERE — see `onSelectionChange`. Keying it on the press location cannot work:
      // scoped to the container it misses every gesture that BEGINS outside the thread (the
      // header→compose enclosure, compose→transcript), and widened to the column it lets a press on
      // the mention picker clear it. The honest trigger is "a new selection is actually being made",
      // which is an event about the selection, not about the press.
    };

    // Mouse-driven selections announce their own end. `dblclick` (word) and the third click of a
    // triple-click (paragraph) both land as a `mouseup` here too; the dblclick listener is kept
    // because a double-click can complete without a mouseup we'd recognise on some platforms, and
    // `lastCopied` makes the overlap free.
    //
    // ON THE DOCUMENT, not the container. Selecting through to the end of an answer means dragging
    // PAST it, so the release routinely lands on the compose box or the column edge — and a
    // container-bound listener simply never heard those gestures, which is a large part of "it's
    // very hard to copy content in the concierge window": the highlight was made, nothing was
    // copied, and nothing said so. The clamp in `copySelection` is what makes hearing every release
    // safe; a mouseup with no selection reaching into the thread still copies nothing.
    const onMouseUp = () => {
      dragging = false;
      cancelPending();
      copySelection();
    };

    // Keyboard selection (shift+arrows, ⌘A) — no gesture-end event, so settle for a quiet period.
    //
    // SUPPRESSED ENTIRELY WHILE THE BUTTON IS DOWN (see `dragging`). This event also fires on every
    // mousemove of a drag, and a reader who pauses mid-drag for longer than the debounce used to get
    // a copy fired underneath them — which is what moved their anchor. The release path above owns
    // the mouse gesture; this one owns only the keyboard, which is all it was ever written for.
    const onSelectionChange = () => {
      cancelPending();
      if (dragging) {
        // WHERE THE DE-DUPE CLAIM IS RELEASED: the selection is changing under a held button, so a
        // NEW one is being made by hand and whatever we copied last is no longer what is on screen.
        //
        // This is the only trigger that gets all three cases right at once. It fires for every
        // hand-made drag no matter where it started — including the ones that begin outside the
        // thread, which a container-scoped press missed, leaving a repeat of that same gesture a
        // silent no-op (the reader copies something else in another app, comes back, drags the same
        // words again, and gets nothing). It does NOT fire for a click that leaves the selection
        // standing, because such a click dispatches no `selectionchange` — which is what keeps a
        // press on another surface from re-copying a stale range. And it cannot fire for
        // `copyToClipboard`'s fallback restore, which happens with the button UP, so the roborev
        // 55075 live-lock stays closed.
        lastCopied = null;
        return;
      }
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        copySelection();
      }, KEYBOARD_SELECTION_DEBOUNCE_MS);
    };

    container.addEventListener("dblclick", onMouseUp);
    // Document-level: a drag can START and END anywhere (see `onMouseDown`/`onMouseUp`), and
    // `selectionchange` is only ever dispatched here.
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      cancelPending();
      container.removeEventListener("dblclick", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [enabled, containerRef]);

  return copied;
}
