import { type CSSProperties } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { useUiStore } from "../stores/uiStore";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { CONCIERGE_LAYOUTS, type ConciergeLayout } from "../engine/pairs";

// THE CONCIERGE LAYOUT PICKER — Settings → Appearance → Layout (epic sparkle-5ua3br).
//
// THREE BUTTONS, ALWAYS VISIBLE, IN THE FOUNDER'S ORDER: right, center, left. This is the
// recovery path as much as the choice: the window's sides used to be opened and closed by a
// hover-only +/− in a build column header, and an accidental − took half the window away with
// nothing on screen to bring it back. Here every layout is one click from every other, and the
// selected one says so (`aria-pressed`, teal fill), so "where did my side go" always has an answer
// in the same place.
//
// The store does the work: `setConciergeLayout` also sends left-side projects back to the right
// when a one-pair layout is chosen, so nothing is left assigned to a pair that is not on screen.

const COPY: Record<ConciergeLayout, { label: string; aria: string }> = {
  right: { label: "Right", aria: "Concierge on the right — epics, build agents and terminal to its left" },
  center: { label: "Center", aria: "Concierge in the center — epics, build agents and terminal on both sides" },
  left: { label: "Left", aria: "Concierge on the left — epics, build agents and terminal to its right" },
};

/** The buttons, in `CONCIERGE_LAYOUTS` order — the founder's right, center, left. The ORDER lives in
 *  engine/pairs so there is one definition of it; this file only owns the words. */
const SEGMENTS = CONCIERGE_LAYOUTS.map((layout) => ({ layout, ...COPY[layout] }));

/** A tiny diagram of the row: the concierge as a filled column, the pair columns as outlines.
 *  Inline SVG (no emoji, no icon-set glyph — there is no "column layout" glyph in Feather). */
function LayoutGlyph({ layout }: { layout: ConciergeLayout }) {
  // Seven slots wide; the concierge is two of them. Each pair is three thin columns.
  const slots: Array<"c" | "p"> =
    layout === "right" ? ["p", "p", "p", "c"] : layout === "left" ? ["c", "p", "p", "p"] : ["p", "p", "p", "c", "p", "p", "p"];
  const W = 30;
  const H = 14;
  const unit = W / slots.reduce((n, k) => n + (k === "c" ? 2 : 1), 0);
  let x = 0;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden focusable="false">
      {slots.map((k, i) => {
        const w = k === "c" ? unit * 2 : unit;
        const rect = (
          <rect
            key={i}
            x={x + 0.5}
            y={0.5}
            width={Math.max(w - 1.5, 1)}
            height={H - 1}
            rx={1}
            fill={k === "c" ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={1}
          />
        );
        x += w;
        return rect;
      })}
    </svg>
  );
}

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const seg: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.modal,
  padding: "6px 0",
  cursor: "pointer",
  fontSize: TYPE.body,
  fontFamily: FONT_UI,
};

export function ConciergeLayoutToggle() {
  const layout = useUiStore((s) => s.conciergeLayout);
  const setLayout = useUiStore((s) => s.setConciergeLayout);
  return (
    <div role="group" aria-label="Concierge layout" data-testid="concierge-layout-toggle" style={row}>
      {SEGMENTS.map((s) => {
        const selected = layout === s.layout;
        return (
          <button
            key={s.layout}
            type="button"
            data-testid={`concierge-layout-${s.layout}`}
            aria-label={s.aria}
            title={s.aria}
            aria-pressed={selected}
            onClick={() => setLayout(s.layout)}
            style={{
              ...seg,
              background: selected ? C.teal : "transparent",
              // On-teal foreground stays light in both themes (C.cream flips to navy in light).
              color: selected ? ON_BRAND_FILL : C.muted,
              borderColor: selected ? C.teal : C.muted,
            }}
          >
            <LayoutGlyph layout={s.layout} />
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
