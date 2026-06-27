// The agent name in the sidebar, rendered at the longest length that fits the column (spec:
// width-fitted agent names). Measures the available width with a ResizeObserver and a canvas
// text metric, then picks short/medium/long via {@link pickFittedVariant}. The full `long`
// form is revealed on hover (same styled card as "Working in:") whenever it adds information
// beyond what's shown. Legacy agents with no variants just render their single `name`.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { FONT, FONT_WEIGHT } from "../theme/colors";
import type { AgentNameVariants } from "../types";
import { pickFittedVariant } from "../services/nameFit";
import { Tooltip } from "./Tooltip";

// One offscreen canvas, reused for every measurement (creating one per call is wasteful and
// the 2d context is the standard way to measure text width without reflowing the DOM).
let measureCtx: CanvasRenderingContext2D | null | undefined;
function makeMeasurer(font: string) {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  return (text: string): number => {
    if (!measureCtx) return 0; // no canvas (e.g. headless) → 0 means "everything fits" → long
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  };
}

const FONT_SIZE = 13;

export function FittedAgentName({
  variants,
  name,
  color,
  active,
  onDoubleClick,
  suppressTooltip = false,
}: {
  variants: AgentNameVariants | null;
  /** Canonical fallback name (also used until the first width measurement lands). */
  name: string;
  color: string;
  /** Selected row uses the semibold weight — must match for an accurate measurement. */
  active: boolean;
  onDoubleClick: (e: ReactMouseEvent) => void;
  /** Don't pop the "Full name:" card — the caller reveals the full name another way (e.g. the
   *  sidebar row's hover slide-out), so a second floating card would be redundant. */
  suppressTooltip?: boolean;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [avail, setAvail] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setAvail(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const weight = active ? FONT_WEIGHT.semibold : FONT_WEIGHT.medium;
  const font = `${weight} ${FONT_SIZE}px ${FONT.ui}`;

  // What to render: until measured (first paint) or with no variants, show the canonical
  // name; once we know the width, pick the longest variant that fits.
  let display = name;
  if (variants) {
    display = avail !== null ? pickFittedVariant(variants, avail, makeMeasurer(font)) : variants.medium || name;
  }

  // Reveal the long form on hover only when it says more than what's currently displayed —
  // a fully-shown name in a wide column gets no redundant tooltip.
  const showTooltip = !suppressTooltip && !!variants && !!variants.long && variants.long !== display;

  // The ResizeObserver watches THIS outer span, which is always rendered (never reparents),
  // so the observer can't go stale. flex:1 + minWidth:0 makes its content box exactly the
  // width available for the name (the pin is a separate flex sibling), which is what we
  // measure candidate widths against.
  return (
    <span ref={wrapRef} style={{ flex: 1, minWidth: 0, display: "block", overflow: "hidden" }}>
      <Tooltip label="Full name:" value={showTooltip ? variants!.long : undefined} mono={false}>
        <span
          // Double-click to rename. A single click must NOT enter edit mode — it just selects
          // the agent (the row's onClick), so clicking a tab never accidentally renames it.
          onDoubleClick={onDoubleClick}
          title={showTooltip ? undefined : "Double-click to rename"}
          style={{
            display: "block",
            color, // the whole name takes its status color
            fontSize: FONT_SIZE,
            fontWeight: weight,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {display}
        </span>
      </Tooltip>
    </span>
  );
}
