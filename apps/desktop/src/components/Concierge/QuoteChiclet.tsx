// The floating pill the founder asked for: highlight some of the concierge's output and a chiclet
// appears offering to carry it into the compose box.
//
// A REAL <button>, not a styled div, and that is what makes the keyboard half of the request work.
// He asked for both a shortcut and a focusable chiclet; Tab-ing to a button clears the document
// selection in Chrome, which would leave a click-time read of the Selection returning "". The text
// is snapshotted when this mounts (see useQuoteOnSelection's header), so Tab-then-Enter quotes the
// right words even though the highlight is gone by the time Enter lands.
//
// PORTALLED, like every other floating surface in this app (SelectionPopup, Tooltip, the popovers in
// ModelPill/AgentInboxBadge). The thread is an `overflow-y: auto` scroller, so an in-flow affordance
// near the bottom edge would be clipped by it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCornerUpLeft } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import { popupPosition } from "../selectionPopupPosition";
import { QUOTE_CHICLET_ATTR } from "./useQuoteOnSelection";

export const QUOTE_CHICLET_TESTID = "quote-chiclet";
export const QUOTE_CHICLET_LABEL = "Quote in response";

/** Roughly the pill's rendered width. Only feeds the viewport clamp, which re-measures the real
 *  height in a layout effect; being a few pixels out shifts nothing the user can see. */
const WIDTH = 168;
const HEIGHT = 30;

export function QuoteChiclet({
  x,
  y,
  onQuote,
  onDismiss,
}: {
  x: number;
  y: number;
  onQuote: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x + 8, top: y + 8 });

  // Stable ref so the dismiss effect subscribes once. The thread re-renders several times a second
  // while a reply streams; re-attaching window listeners on every one of those is listener churn the
  // rest of this column is careful to avoid.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight || HEIGHT;
    setPos(popupPosition({ x, y }, { w: WIDTH, h }, { w: window.innerWidth, h: window.innerHeight }));
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismissRef.current();
    };
    const onDocDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismissRef.current();
    };
    // `wheel`, NOT `scroll` — the identical hazard SelectionPopup documents. The concierge thread
    // auto-follows as a reply streams, firing `scroll` continuously; a scroll listener would destroy
    // this pill the instant it appeared over a live answer. `wheel` only fires on real user input.
    const onWheel = (e: WheelEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onDismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDocDown, true);
    window.addEventListener("wheel", onWheel, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDocDown, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, []);

  return createPortal(
    <button
      ref={ref}
      type="button"
      {...{ [QUOTE_CHICLET_ATTR]: "yes" }}
      data-testid={QUOTE_CHICLET_TESTID}
      // Stop the press reaching the thread, which would collapse the selection this is offering to
      // quote before the click resolves.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onQuote}
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
        // NOT A CAPSULE ANY MORE. Founder, 2026-08-12: *"Make this quote response button less
        // rounded I can't stand the rounded buttons like that."*
        //
        // `RADIUS.input` — the scale's own workhorse, described there as "inputs, buttons, cards,
        // the chat bubble" — rather than a number chosen by eye for this one control. It was
        // `PILL`, and the comment that stood here argued the capsule was deliberate; it was, and it
        // has been overruled. The smaller `RADIUS.sm` is not the right answer either: that step is
        // for "swatches, ticks, the smallest chips", so taking it would make this button the ONLY
        // button in the app at that radius — a different way of being bespoke.
        borderRadius: RADIUS.input,
        cursor: "pointer",
        fontFamily: FONT_UI,
        fontSize: TYPE.small,
        fontWeight: FONT_WEIGHT.semibold,
        // The solid brand fill, where the copy toast beside it is a translucent wash: this one is
        // actionable and that one is a receipt, and they can be on screen together.
        background: C.teal,
        color: ON_BRAND_FILL,
        boxShadow: "0 8px 22px rgba(0,0,0,0.4)",
        whiteSpace: "nowrap",
        animation: "sparkle-tooltip-in 90ms ease-out",
      }}
    >
      <FiCornerUpLeft size={13} aria-hidden />
      {QUOTE_CHICLET_LABEL}
    </button>,
    document.body,
  );
}
