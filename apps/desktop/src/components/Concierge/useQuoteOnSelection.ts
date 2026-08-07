// "Quote in response": releasing a selection inside a concierge thread offers to carry it into the
// compose box. Mounted ONCE on the thread's scroll container, BESIDE `useCopyOnSelection` rather
// than inside it — the two are independent answers to the same gesture (one writes the clipboard,
// one stages a reply) and the copy hook's behaviour is delicate enough that PRD
// `concierge-copy-selection` records three roborev rounds of regressions caused by editing it.
//
// THE SNAPSHOT IS THE LOAD-BEARING DECISION. `pending.text` is captured when the affordance APPEARS
// and never re-read from the live Selection when it is activated. Two separate things destroy the
// selection between those moments, and each one alone would make a click-time read return "":
//
//   • `clipboard.ts`'s execCommand fallback — the path this webview actually takes — tears the live
//     selection down with `removeAllRanges` and rebuilds it with `addRange`. `useCopyOnSelection`
//     fires on the very same `mouseup` that raises this chiclet.
//   • FOCUSING the chiclet clears the document selection in Chrome, which is what Tab-ing to it
//     does. Snapshotting is therefore also the thing that makes the KEYBOARD path work at all: the
//     founder asked for a focusable chiclet, and without the snapshot, Tab-then-Enter would quote
//     an empty string every time.
//
// SCOPE: the concierge column's threads — its own answers, the user's own past messages, and
// build-agent messages (see MountedAgentThread). NOT the terminal, which has its own selection card
// (SelectionPopup) and was explicitly excluded.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { selectionWithin } from "./useCopyOnSelection";
import { matchesChord } from "../../keyboardHints/keybindings";
import { useKeybindingsStore } from "../../stores/keybindingsStore";
import type { QuoteSource } from "./composeQuote";

/** Quiet period after the last `selectionchange` before a KEYBOARD selection counts as finished.
 *  Mirrors `useCopyOnSelection`'s: shift+arrow has no gesture-end event, so the affordance would
 *  otherwise flicker once per keystroke. */
export const QUOTE_SELECTION_DEBOUNCE_MS = 300;

/** Marks the chiclet in the DOM. A press inside it must not be read as the start of a new selection
 *  (which would dismiss the very affordance being clicked), and an attribute keeps that check free
 *  of ref plumbing between the hook and the portalled component. */
export const QUOTE_CHICLET_ATTR = "data-quote-chiclet";

/** A staged selection: the words, where they came from, and where to draw the affordance. */
export interface PendingQuote {
  text: string;
  sourceId: string;
  source: QuoteSource;
  /** Only for `source: "agent"` — the chip's caption. */
  agentName?: string;
  /** Viewport coords to hang the chiclet off. */
  x: number;
  y: number;
}

/**
 * Which message a selection was taken FROM.
 *
 * Answered from where the selection STARTS, not where it ends. A drag that runs off the end of an
 * answer — the overshoot `selectionWithin` exists to tolerate — finishes on the compose box or the
 * column edge, so the focus end routinely names nothing at all. The anchor is the message the reader
 * aimed at.
 *
 * Exported for its own test: it is the one piece of this hook that can be checked without a gesture.
 */
export function quoteSourceOf(node: Node | null): { sourceId: string; source: QuoteSource; agentName?: string } | null {
  const start = node instanceof Element ? node : (node?.parentElement ?? null);
  const row = start?.closest<HTMLElement>("[data-message-id]");
  const sourceId = row?.getAttribute("data-message-id");
  if (!row || !sourceId) return null;
  // Declared by the row rather than parsed out of the id's prefix. Ids are minted as
  // `${prefix}-${seq}` ("you-14", "sparkle-15", "err-…", "recap-…"), so a prefix test would quietly
  // mis-caption every kind nobody thought to enumerate — and would break outright on rehydrate,
  // which REINDEXES ids by position.
  const declared = row.getAttribute("data-quote-source");
  const source: QuoteSource =
    declared === "you" || declared === "agent" || declared === "sparkle" ? declared : "sparkle";
  const agentName = row.getAttribute("data-quote-label") ?? undefined;
  return agentName ? { sourceId, source, agentName } : { sourceId, source };
}

/**
 * Offer to quote the user's selection when they finish making it.
 *
 * @param containerRef the thread's scroll container — the selection must reach INSIDE it.
 */
export function useQuoteOnSelection(
  containerRef: RefObject<HTMLElement | null>,
  { enabled = true }: { enabled?: boolean } = {},
): { pending: PendingQuote | null; dismiss: () => void } {
  const [pending, setPending] = useState<PendingQuote | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => setPending(null), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    let dragging = false;

    const cancelPending = () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    };

    /** Raise the affordance for whatever is selected right now, or take it down. `at` is the release
     *  point for a mouse gesture; the keyboard path has none and falls back to the range's own box. */
    const offer = (at?: { x: number; y: number }) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPending(null);
        return;
      }
      // The SAME clamp the copy path uses, so the two affordances can never disagree about whether a
      // gesture belongs to this column. Cutting the range at the container's bounds is what makes an
      // overshoot past the last line quotable instead of being dropped on the floor.
      const text = selectionWithin(sel, container);
      // Whitespace-only selections are an accident of dragging, never an intent to quote.
      if (!text.trim()) {
        setPending(null);
        return;
      }
      const from = quoteSourceOf(sel.anchorNode);
      // A selection that reaches into the thread but names no message — the enclosure drag whose
      // anchor sits in the column header — has nothing to attribute the quote to. The founder chose
      // attribution that the brain can RESOLVE; a quote with no id would silently be the one kind he
      // did not ask for.
      if (!from) {
        setPending(null);
        return;
      }
      // A mouse gesture names its own release point; the keyboard path has none and falls back to
      // the end of the selection's own box.
      //
      // GUARDED, because `Range.prototype.getBoundingClientRect` is NOT UNIVERSAL — jsdom does not
      // implement it at all (it is absent, not zero), and an exception thrown inside a keydown
      // handler would take the whole shortcut down rather than merely mis-place the pill. Position is
      // the one thing here that can be wrong without the feature being broken: `popupPosition` clamps
      // {0,0} into the viewport, so the worst case is a chiclet in the corner instead of no chiclet
      // at all. (This is also why the tests assert PRESENCE and leave coordinates to
      // `selectionPopupPosition`'s own unit tests.)
      let x = at?.x ?? 0;
      let y = at?.y ?? 0;
      if (!at) {
        const range = sel.getRangeAt(sel.rangeCount - 1);
        const rect =
          typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
        if (rect) {
          x = rect.right;
          y = rect.bottom;
        }
      }
      setPending({ ...from, text, x, y });
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // A press INSIDE the chiclet is the activation, not the start of a new selection. Without this
      // the affordance would tear itself down on the way to being clicked.
      if ((e.target as Element | null)?.closest?.(`[${QUOTE_CHICLET_ATTR}]`)) return;
      dragging = true;
      cancelPending();
      // A new gesture begins: whatever was offered is about to stop matching what is on screen.
      setPending(null);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      cancelPending();
      offer({ x: e.clientX, y: e.clientY });
    };

    // Keyboard selection (shift+arrows) — no gesture-end event, so settle for a quiet period.
    // Suppressed while the button is down for the same reason the copy hook suppresses it: this
    // fires on every mousemove of a drag, and re-offering mid-gesture would make the chiclet chase
    // the pointer.
    const onSelectionChange = () => {
      cancelPending();
      if (dragging) return;
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        offer();
      }, QUOTE_SELECTION_DEBOUNCE_MS);
    };

    // ══ THE KEYBOARD PATH ═══════════════════════════════════════════════════════════════════════
    // The founder asked for a shortcut as well as the chiclet, so the gesture never forces a reach
    // for the mouse. This raises the affordance IMMEDIATELY rather than through the debounce above —
    // a chord is an explicit "I am done selecting", which is exactly the gesture-end event a keyboard
    // selection otherwise lacks.
    //
    // Read through `getState()` at press time, not subscribed: a rebind takes effect on the next
    // press without re-attaching this listener, which matches how Terminal and Workspace read the
    // other chords.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesChord(e, useKeybindingsStore.getState().bindings.quoteSelection)) return;
      e.preventDefault();
      cancelPending();
      offer();
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelPending();
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, containerRef]);

  return { pending, dismiss };
}
