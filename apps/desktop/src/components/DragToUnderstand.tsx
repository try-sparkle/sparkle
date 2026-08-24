// DRAG-TO-UNDERSTAND, RUNG ONE — the affordance (epic sparkle-0kbf4s).
//
// "I click and drag some text and it gives me a little copy icon." — the founder, describing the
// first rung of a help system whose objective is that "a user is never confused". This is that
// little copy icon, and nothing more than that: it OFFERS, and waits.
//
// ── WHAT THIS ADDS THAT DID NOT EXIST ─────────────────────────────────────────────────────────────
// Two surfaces already answered a text selection: the terminal (auto-copy + the ten-action
// SelectionPopup) and the concierge thread (useCopyOnSelection's silent copy + toast). EVERYWHERE
// ELSE in the app — an agent's goal line, an epic title, a PR body, a status line, a settings
// caption — a drag produced a highlight and no response at all. That is the gap the founder's
// "you can click and drag over ANYTHING" claim is about, so rung one is the gesture becoming
// universal rather than the two tuned surfaces being re-litigated.
//
// Those two stand down by declaring SELECTION_AFFORDANCE_ATTR on themselves; see dragToUnderstand.ts
// for why that is an attribute and not a selector list kept here.
//
// ── WHY MOUSEUP AND NEVER `selectionchange` ───────────────────────────────────────────────────────
// `useCopyOnSelection` had to listen to `selectionchange` because it acts automatically and a
// keyboard selection announces no end. This one never acts, so it only needs the moment a MOUSE
// gesture finishes — and staying off `selectionchange` keeps it structurally clear of the live-lock
// that hook documents at length: `copyToClipboard`'s execCommand fallback tears the selection down
// and rebuilds it, dispatching `selectionchange` twice, which for a `selectionchange`-driven
// consumer re-arms the very thing that just fired.
//
// KEYBOARD SELECTIONS ARE OUT OF SCOPE for rung one, deliberately — the founder described a drag.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiCopy } from "react-icons/fi";
import { copyToClipboard } from "../clipboard";
import { understandGesture } from "./understandGesture";
import { popupPosition } from "./selectionPopupPosition";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";

export const DRAG_TO_UNDERSTAND_TESTID = "drag-to-understand-chip";
export const DRAG_TO_UNDERSTAND_LABEL = "Copy";
export const DRAG_TO_UNDERSTAND_COPIED_LABEL = "Copied";

/** Marks the chip's own subtree, so a press ON the affordance is not read as a press that dismisses
 *  it. Containment via an attribute rather than a ref, because the press is heard on the document
 *  before React has any node to compare against on the very first frame. */
const CHIP_ATTR = "data-drag-to-understand";

/** How long the check-mark stays up before the chip retires. Matches COPY_TOAST_MS in
 *  useCopyOnSelection — the same gesture answered the same way, so it should feel the same. */
export const UNDERSTAND_COPIED_MS = 1200;

/** Rough chip size; only seeds the viewport clamp, which re-measures the real height on layout. */
const WIDTH = 104;
const HEIGHT = 30;

function insideChip(target: EventTarget | null): boolean {
  const node = target instanceof Node ? target : null;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return !!el?.closest(`[${CHIP_ATTR}]`);
}

/** Where the affordance is, and over what. `null` whenever there is nothing to offer. */
interface Offer {
  text: string;
  x: number;
  y: number;
}

/**
 * Watch the document for a finished drag-selection worth answering.
 *
 * Document-level, and that is the whole point: the gesture is supposed to work over ANYTHING, so
 * there is no container to scope it to. The refusals all live in `understandGesture`.
 */
export function useUnderstandOffer(): { offer: Offer | null; dismiss: () => void } {
  const [offer, setOffer] = useState<Offer | null>(null);
  const dismiss = useCallback(() => setOffer(null), []);

  useEffect(() => {
    /**
     * What this gesture began on — and the ONE question that disqualifies a control drag.
     *
     * ── WHY IT IS TAKEN AT `pointerdown`, IN CAPTURE ───────────────────────────────────────────
     * The founder's rule (bead sparkle-bjbhw6, DEFECT 4) is that a drag aimed at a control is not a
     * text selection. Answering it needs the press, and `mouseup` cannot supply one: a drag that
     * overshoots ends on whatever the pointer happens to be over, which for a selection dragged
     * past its surface is routinely some other surface entirely.
     *
     * `mousedown` cannot be trusted to supply one either, and that is the subtle half. A control
     * that calls `preventDefault()` on `pointerdown` SUPPRESSES the compatibility `mousedown`
     * (ColumnPullTab and the compose-box handle both do exactly that) while the release still
     * arrives — so a press recorded at `mousedown` is simply never written for those gestures, and
     * the scrubber drag that swept a selection across the text underneath would be offered a copy
     * chip. `pointerdown` is the one press event every such control still emits, and CAPTURE on the
     * document runs before any handler bound deeper, so nothing can hide it with `stopPropagation`.
     *
     * ── WHY THE SHARED `controlGesture.ts` LATCH IS NOT READ HERE ──────────────────────────────
     * That latch exists for consumers of `selectionchange`, which carries no target at all. This
     * component keys on a gesture's own press and release, so it can ask the target directly — and
     * a latch read would be strictly redundant with that: the latch is armed FROM the `pointerdown`
     * target, so at any moment this component could sample it, it holds the same bit
     * `isControlGestureTarget(pressTarget)` already returns. Reading it anyway would be a guard
     * that cannot decide a case the target test does not, with a comment implying otherwise —
     * and, sampled at `mouseup`, it would be worse than redundant: `controlGesture.ts` releases on
     * `pointerup`, which UI Events orders BEFORE `mouseup`, so the read is always `false` while a
     * jsdom test still passes it (jsdom fires no compatibility pointer events — AGENTS.md, bead
     * sparkle-40va0, "the test picks a reading order the browser does not produce").
     */
    let pressTarget: EventTarget | null = null;
    // Did this gesture begin ON the chip? Then it is a click on the affordance, not a new selection,
    // and the release must not re-evaluate (which would re-offer over the still-standing selection).
    let pressOnChip = false;

    const onPointerDown = (e: Event) => {
      pressOnChip = insideChip(e.target);
      // A press on the chip leaves the offer standing so the click can land on it.
      if (pressOnChip) return;
      pressTarget = e.target;
      // ANY other press retires the current offer: the user has moved on, and an affordance that
      // outlived the selection it describes would copy words that are no longer highlighted.
      setOffer(null);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (pressOnChip) {
        pressOnChip = false;
        return;
      }
      const gesture = understandGesture({ selection: window.getSelection(), pressTarget });
      pressTarget = null;
      if (!gesture) return;
      setOffer({ text: gesture.text, x: e.clientX, y: e.clientY });
    };

    // CAPTURE on both, so a control handling its own press cannot hide the gesture from this
    // listener — see the note on `pressTarget` above.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
    };
  }, []);

  return { offer, dismiss };
}

function UnderstandChip({ x, y, text, onDismiss }: Offer & { onDismiss: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x + 8, top: y + 8 });
  const [copied, setCopied] = useState(false);

  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // The retire timer, and whether this chip is still mounted — `copyToClipboard` is an IPC round
  // trip, so its `.then` can land after the chip is gone.
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight || HEIGHT;
    setPos(popupPosition({ x, y }, { w: WIDTH, h }, { w: window.innerWidth, h: window.innerHeight }));
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismissRef.current();
    };
    // `wheel`, NOT `scroll` — the hazard SelectionPopup and QuoteChiclet both document: surfaces in
    // this app scroll themselves programmatically as content streams, and a `scroll` listener would
    // destroy the chip the instant it appeared over a live one.
    const onWheel = (e: WheelEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onDismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, []);

  const onCopy = () => {
    // THE TEXT IS SNAPSHOTTED, not re-read from the live Selection. Clicking a button can clear the
    // document selection, so a click-time read would copy "" — the same trap QuoteChiclet documents.
    void copyToClipboard(text).then((ok) => {
      if (!alive.current) return;
      // A failed write must not claim success. The chip stays up, so the gesture can be repeated.
      if (!ok) return;
      setCopied(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (alive.current) onDismissRef.current();
      }, UNDERSTAND_COPIED_MS);
    });
  };

  return createPortal(
    <button
      ref={ref}
      type="button"
      {...{ [CHIP_ATTR]: "yes" }}
      data-testid={DRAG_TO_UNDERSTAND_TESTID}
      aria-label={copied ? DRAG_TO_UNDERSTAND_COPIED_LABEL : DRAG_TO_UNDERSTAND_LABEL}
      onClick={onCopy}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 9999,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 11px",
        border: `1px solid color-mix(in srgb, ${C.teal} 60%, transparent)`,
        borderRadius: RADIUS.input,
        cursor: "pointer",
        fontFamily: FONT_UI,
        fontSize: TYPE.small,
        fontWeight: FONT_WEIGHT.semibold,
        background: C.teal,
        color: ON_BRAND_FILL,
        boxShadow: "0 8px 22px rgba(0,0,0,0.4)",
        whiteSpace: "nowrap",
        animation: "sparkle-tooltip-in 90ms ease-out",
      }}
    >
      {copied ? <FiCheck size={14} aria-hidden="true" /> : <FiCopy size={14} aria-hidden="true" />}
      {copied ? DRAG_TO_UNDERSTAND_COPIED_LABEL : DRAG_TO_UNDERSTAND_LABEL}
    </button>,
    document.body,
  );
}

/**
 * Mount once, near the top of the app. Renders nothing until a drag-selection asks for help.
 */
export function DragToUnderstand() {
  const { offer, dismiss } = useUnderstandOffer();
  if (!offer) return null;
  return <UnderstandChip {...offer} onDismiss={dismiss} />;
}
