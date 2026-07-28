// A draggable vertical boundary between two columns, with the 2×3 dot grip that appears on hover.
//
// ── WHY THIS IS SHARED RATHER THAN COPIED ──────────────────────────────────────────────────────
// The agent column already had a resize strip: drag, arrow keys, a 160–480 clamp and a persisted
// width. The concierge column had none — it took a fixed `width = 380` prop and there was no way to
// move that boundary at all, which is what the founder's "resizable columns 1 and 2" is about. The
// obvious move is to copy the strip; this file exists so nobody does. A resize boundary is a
// keyboard-accessible `separator` with a value range, a clamp and persistence, and every one of
// those is a thing that regresses quietly when it exists twice.
//
// ── THE GRIP IS A 2×3 DOT FIELD, AND IT ONLY APPEARS ON HOVER ──────────────────────────────────
// The agent column's grip was a 4×28 rounded bar: legible, but it reads as a scrollbar, and it was
// always painted so it drew a permanent grey tick on the shell's most prominent seam. A dot field
// reads as "grab me" the way a drag handle does everywhere else, and hiding it until the pointer is
// near the boundary keeps the resting shell clean — the seam is carried by the plane step (see the
// seam rule in theme/colors) and does not need a marker sitting on it.
//
// The dots are `aria-hidden` and `pointerEvents: none`. This is the bug the agent column's tests
// already record: the grip is INSIDE the strip and wider than it, so while it accepted pointer
// events it swallowed every mousedown over the one part of the control a user can actually see.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { C } from "../theme/colors";

/** Keyboard step, and the larger step when Shift is held. */
const STEP = 8;
const BIG_STEP = 32;

/** The dot field: 2 columns × 3 rows, 2px dots, 3px apart. */
const DOT = 2;
const DOT_GAP = 3;

export interface ColumnResizeTabProps {
  /** Current width of the column being resized, in px. */
  width: number;
  /** Commit a new width. The caller clamps and persists — see `clampWidth`. */
  onWidth: (next: number) => void;
  min: number;
  max: number;
  /** Human name of the column, used in the accessible name and title. */
  label: string;
  /**
   * Which side of the boundary the resized column is on. `"left"` means dragging RIGHT grows it
   * (the concierge and agent columns); `"right"` means dragging right SHRINKS it. Getting this
   * wrong inverts the drag, which is the kind of thing that feels broken and reads as correct.
   */
  grows?: "left" | "right";
  /** Test hook + DOM handle. */
  testId?: string;
}

export function ColumnResizeTab({
  width,
  onWidth,
  min,
  max,
  label,
  grows = "left",
  testId = "column-resize-tab",
}: ColumnResizeTabProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The pointer position and width at mousedown, so the drag is a DELTA rather than an absolute
  // read of clientX — the latter jumps the boundary to the cursor on the first pixel of movement.
  const origin = useRef({ x: 0, width: 0 });

  const commit = useCallback(
    (next: number) => onWidth(Math.min(max, Math.max(min, Math.round(next)))),
    [onWidth, min, max],
  );

  const startResize = (e: { clientX: number; preventDefault: () => void }) => {
    e.preventDefault(); // no text selection while dragging
    origin.current = { x: e.clientX, width };
    setDragging(true);
  };

  // Window-level listeners while dragging: a pointer that leaves the 6px strip mid-drag (which it
  // will, immediately) must keep driving the resize, and the mouseup that ends it can land anywhere.
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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    // ← and → always mean "narrower" and "wider" for the column this tab owns, regardless of which
    // side it sits on — the arrow follows the BOUNDARY, which is what the user is looking at.
    const sign = grows === "left" ? 1 : -1;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      commit(width + step * sign);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      commit(width - step * sign);
    }
  };

  // Shown while hovered OR dragging: the pointer leaves the strip the instant a drag starts, so a
  // hover-only rule makes the grip vanish exactly when it is being used.
  const showGrip = hovered || dragging;

  return (
    <div
      onMouseDown={startResize}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={onKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`Drag to resize the ${label} (or focus it and use ← →)`}
      data-testid={testId}
      style={strip}
    >
      <div
        aria-hidden
        data-testid={`${testId}-grip`}
        style={{
          ...grip,
          opacity: showGrip ? 1 : 0,
        }}
      >
        {/* 2 across × 3 down. Rendered rather than drawn so it inherits the themed ink and needs no
            asset; six spans is cheaper than an SVG and cannot go stale against the palette. */}
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} style={dot} />
        ))}
      </div>
    </div>
  );
}

/** The full-height hit area. 6px is the smallest band a pointer reliably lands on; the cursor is
 *  what tells the user it is grabbable before the grip fades in. */
const strip: CSSProperties = {
  flex: "0 0 auto",
  width: 6,
  cursor: "col-resize",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // Above the sticky in-column furniture (the agent column's "+ New Build Agent" wrapper is z3), so
  // the boundary is never shadowed by something that stops short of it.
  zIndex: 4,
};

const grip: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `repeat(2, ${DOT}px)`,
  gap: DOT_GAP,
  // The grip is WIDER than the 6px strip that owns the drag, so it must not take pointer events —
  // otherwise it eats every mousedown over the only visible part of the control.
  pointerEvents: "none",
  transition: "opacity 120ms ease",
};

const dot: CSSProperties = {
  width: DOT,
  height: DOT,
  borderRadius: "50%",
  background: C.hairline,
};
