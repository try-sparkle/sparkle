// ONE pull tab per column boundary, carrying BOTH gestures — the founder's design, 2026-07-28.
//
// ── WHAT THIS REPLACES, AND WHY IT READ AS JANKY ───────────────────────────────────────────────
// The agent column shipped TWO stacked controls on its edge: a 4×28 grey bar that resized, and a
// separate arrow button below it that popped the column out as an overlay. Both were painted at
// rest, so the shell's most prominent seam always carried two grey marks, and the founder's read
// was exactly that — "very janky, there's that secondary arrow pull tab below it… it should also
// only show on hover."
//
// So: one tab, two ZONES, revealed on hover.
//
//   ‹›   the chevron zone  — OVERLAY. Pull this column out over the column to its right.
//   ⣿    the dot zone      — RESIZE. Drag to move the boundary; arrow keys nudge it.
//
// And the round trip the founder specified: once the column is overlaid, clicking the DOTS snaps it
// back into flow and hands the gesture back to resizing. That is why the dot zone is a button as
// well as a drag surface — in the overlaid state its click means "dock me", and only once docked
// does dragging it move a boundary that the user can actually see.
//
// The dots are SQUARE (no rounding) per the same conversation — "a little bit more square than
// those round dots". A round dot field reads as a generic drag handle; squares match a shell
// whose thesis is that structure is drawn rather than filled.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import { C } from "../theme/colors";
import { RADIUS } from "../theme/scale";

/** Keyboard step, and the larger step when Shift is held. */
const STEP = 8;
const BIG_STEP = 32;

/** The dot field: 2 columns × 3 rows of 2px squares, 3px apart. */
const DOT = 2;
const DOT_GAP = 3;

export interface ColumnPullTabProps {
  /** Current width of the column this tab owns, in px. */
  width: number;
  /** Commit a new width (already clamped by this component). */
  onWidth: (next: number) => void;
  min: number;
  max: number;
  /** Human name of the column, for the accessible names. */
  label: string;
  /**
   * Overlay state + toggle. OMIT `onOverlayToggle` and the chevron zone is not rendered at all —
   * a boundary whose column has no overlay mode must not advertise one. It is not disabled or
   * hidden-but-present: an affordance that does nothing is worse than an absent one.
   */
  overlaid?: boolean;
  onOverlayToggle?: () => void;
  /** Which side the owned column sits on. `left` means dragging right grows it. */
  grows?: "left" | "right";
  testId?: string;
}

export function ColumnPullTab({
  width,
  onWidth,
  min,
  max,
  label,
  overlaid = false,
  onOverlayToggle,
  grows = "left",
  testId = "column-pull-tab",
}: ColumnPullTabProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width: 0 });

  const commit = useCallback(
    (next: number) => onWidth(Math.min(max, Math.max(min, Math.round(next)))),
    [onWidth, min, max],
  );

  // While OVERLAID there is no boundary to drag: the column floats over its neighbour and its width
  // comes from the viewport, so a drag would silently move an edge the user cannot see. The dots
  // become a plain "dock me" button in that state — which is the founder's round trip.
  const startResize = (e: { button?: number; clientX: number; preventDefault: () => void }) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button only
    if (overlaid) return;
    e.preventDefault();
    origin.current = { x: e.clientX, width };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - origin.current.x;
      commit(origin.current.width + (grows === "left" ? dx : -dx));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, commit, grows]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (overlaid) return;
    const step = e.shiftKey ? BIG_STEP : STEP;
    const sign = grows === "left" ? 1 : -1;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      commit(width + step * sign);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      commit(width - step * sign);
    }
  };

  // Visible while hovered OR mid-drag. The pointer leaves the tab on the first pixel of a drag, so
  // a hover-only rule would hide the control exactly while it is being used.
  const shown = hovered || dragging;

  return (
    <div
      data-testid={testId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...rail, opacity: shown ? 1 : 0 }}
    >
      <div style={{ ...tab, borderRadius: RADIUS.sm }}>
        {/* ── CHEVRON ZONE — overlay this column over the one to its right ───────────────────── */}
        {onOverlayToggle && (
          <button
            type="button"
            onClick={onOverlayToggle}
            aria-pressed={overlaid}
            data-testid={`${testId}-chevron`}
            aria-label={
              overlaid
                ? `Dock the ${label} back into the layout`
                : `Pull the ${label} out over the pane beside it`
            }
            title={overlaid ? `Dock the ${label}` : `Overlay the ${label}`}
            style={zone}
          >
            {overlaid ? <FiChevronLeft size={11} aria-hidden /> : <FiChevronRight size={11} aria-hidden />}
          </button>
        )}
        {/* ── DOT ZONE — resize while docked; dock again while overlaid ──────────────────────── */}
        <div
          role={overlaid ? "button" : "separator"}
          aria-orientation={overlaid ? undefined : "vertical"}
          aria-label={overlaid ? `Dock the ${label} and resize it` : `Resize the ${label}`}
          aria-valuenow={overlaid ? undefined : width}
          aria-valuemin={overlaid ? undefined : min}
          aria-valuemax={overlaid ? undefined : max}
          tabIndex={0}
          title={
            overlaid
              ? `Dock the ${label} so it can be resized`
              : `Drag to resize the ${label} (or focus it and use ← →)`
          }
          data-testid={`${testId}-dots`}
          onMouseDown={startResize}
          onClick={() => {
            // Only meaningful while overlaid — this is the snap-back half of the round trip.
            if (overlaid) onOverlayToggle?.();
          }}
          onKeyDown={onKeyDown}
          style={{ ...zone, cursor: overlaid ? "pointer" : "col-resize" }}
        >
          <span aria-hidden style={dotField}>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} style={dot} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The full-height hit rail. 6px is the smallest band a pointer reliably lands on. */
const rail: CSSProperties = {
  flex: "0 0 auto",
  width: 6,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // Above the sticky in-column furniture, so the boundary is never shadowed by something that
  // stops short of it.
  zIndex: 4,
  transition: "opacity 120ms ease",
};

/** The tab itself — one object holding both zones, stacked vertically on the seam. */
const tab: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  background: C.barSurface,
  border: `1px solid ${C.hairline}`,
  overflow: "hidden",
};

const zone: CSSProperties = {
  display: "grid",
  placeItems: "center",
  padding: "5px 2px",
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
};

const dotField: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `repeat(2, ${DOT}px)`,
  gap: DOT_GAP,
  // The field is wider than the 6px rail that owns the drag, so it must not take pointer events —
  // otherwise it eats every mousedown over the only visible part of the control.
  pointerEvents: "none",
};

/** SQUARE, not round. The founder asked for "a little bit more square than those round dots"; at
 *  2px there is no meaningful middle ground, and a crisp square is also the only spelling on the
 *  scale — the smallest real radius is 3px, which on a 2px box is just a circle again. It suits a
 *  shell whose thesis is that structure is drawn rather than filled. */
const dot: CSSProperties = {
  width: DOT,
  height: DOT,
  borderRadius: 0,
  background: C.muted,
};
