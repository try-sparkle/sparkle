// ONE pull tab per column boundary, carrying BOTH gestures — the founder's design, 2026-07-28,
// re-cut to `PRD/sparkle/ui-directions/rev4.html` (`.tabzone` / `.tab`) on 2026-07-29.
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
//   ›    the chevron zone  — OVERLAY. Pull this column out over the column to its right.
//   ⣿    the dot zone      — RESIZE. Drag to move the boundary; arrow keys nudge it.
//
// And the round trip the founder specified: once the column is overlaid, clicking the DOTS snaps it
// back into flow and hands the gesture back to resizing. That is why the dot zone is a button as
// well as a drag surface — in the overlaid state its click means "dock me", and only once docked
// does dragging it move a boundary that the user can actually see.
//
// ── THE REV-4 RE-CUT: SIZE, ANCHOR, AND CLEARANCE ──────────────────────────────────────────────
// The first build of this stacked the two zones flush against each other and centred the whole
// thing on the seam, vertically. The founder's read, in order:
//
//   1. "an arrow above six dots, about twenty percent bigger and bolder, ten pixels apart, at the
//      TOP of the boundary rather than the middle";
//   2. then, having seen it built: "perfect… could be like twenty percent smaller, and it's also a
//      little tight with the plus behind it and some of the text around it."
//
// (2) supersedes (1) wherever they disagree, and `rev4.html` is where (2) was signed off — so every
// number below is lifted from that page rather than re-derived. That is also why the tab no longer
// floats ON the header row: it used to sit at the column's very top, which put it straight over the
// sidebar's `+` and its filter chips — the control you reach FOR was overlapping the controls you
// reach PAST. Dropping the whole hover zone below the header band (`--hd-h`, `HEADER_H` here) keeps
// it "at the top" without competing for the same pixels.
//
// The other half of that clearance is NOT ours: `rev4.html` also gives `.bhd` 20px of padding on
// its seam side so the `+` is never jammed against the boundary in the first place. That lives in
// `AgentSidebar.tsx`, which this component does not own.
//
// ── ONE PER BOUNDARY, INDEPENDENT ──────────────────────────────────────────────────────────────
// Every instance owns its own hover, focus and drag state, and commits through its own `onWidth`.
// Two tabs on two seams therefore resize two columns independently with no shared state and no
// coordination — `ColumnPullTab.test.tsx` pins that, because the failure mode (one module-level
// ref, one shared listener) is invisible until the second instance is mounted.
//
// ⚠ THE SHELL STILL MOUNTS ONLY ONE, on the concierge seam (`Workspace.tsx`). The agent-column
// boundary keeps the legacy pair this file's header says it replaces — a separate `col-resize`
// strip plus a separate overlay button in `AgentSidebar.tsx`, with their own listeners and their
// own persisted width. Converting it is a change to those two files, which this one does not own,
// so `grows: "right"` has no production caller yet. The test's second instance proves the component
// supports the mount; it cannot and does not prove the shell has made it. See
// `PRD/sparkle/blueprint-pull-tab.md` for the exact mount and the handoff.
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

// ── GEOMETRY, TRANSCRIBED FROM rev4.html ───────────────────────────────────────────────────────
// `.tabzone{top:var(--hd-h);width:30px;height:52px}` · `.tab{top:6px;gap:8px;padding:5px 5px}`
// `.tab .dots{grid-template-columns:repeat(2,3px);gap:2px}` · `.tab .dots i{width:3px;height:3px}`
//
// The 8px gap is the mock's, not the "ten pixels apart" of the first ask: the second note asked for
// the whole tab ~20% smaller, and 8 is what the approved page shipped. Ten would re-inflate the one
// dimension the correction was about.

/** `--hd-h`. The hover zone starts BELOW the header band so it never overlaps the header's own controls. */
const HEADER_H = 34;
/** The hover zone that straddles the seam — 30px wide, so it overhangs 15px into each column. */
const ZONE_W = 30;
const ZONE_H = 52;
/** The tab's inset from the top of the zone. */
const TAB_TOP = 6;
/** Arrow → dots. */
const TAB_GAP = 8;
const TAB_PAD = 5;
/** The dot field: 2 columns × 3 rows of 3px squares, 2px apart. */
const DOT = 3;
const DOT_GAP = 2;
/** The chevron's box. Drawn at a heavier stroke than Feather's default — the "bolder" of the ask. */
const ARROW = 12;
const ARROW_STROKE = 3;

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
  /**
   * How far down the seam the hover zone starts. Defaults to the header band, which is what keeps
   * the tab clear of the header's own controls; a boundary whose columns have no header can pass 0.
   */
  topOffset?: number;
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
  topOffset = HEADER_H,
  testId = "column-pull-tab",
}: ColumnPullTabProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
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
      // A DROPPED `mouseup` MUST NOT LEAVE THE COLUMN FOLLOWING THE BARE CURSOR. If the release is
      // lost — the pointer leaves the window, a native drag steals it, the button is let go over a
      // surface that swallows the event — `dragging` stays true and every subsequent move resizes.
      // This was documented as degrading to a no-op; it does not, and this is the instance the
      // shell actually mounts, while the control that HAD the guard was mounted nowhere
      // (roborev 54730). `buttons === 0` means no button is held: the gesture is over.
      if (e.buttons === 0) {
        setDragging(false);
        return;
      }
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

  // Visible while hovered, FOCUSED, or mid-drag.
  //  • drag: the pointer leaves the tab on the first pixel of a drag, so a hover-only rule would
  //    hide the control exactly while it is being used.
  //  • focus: hover-only is a mouse rule. A keyboard user tabbing onto the dots would otherwise be
  //    driving a control that paints nothing — the reason this is `shown`, and not merely an
  //    outline, is that there would be nothing on screen for the outline to sit on.
  const shown = hovered || dragging || focused;

  return (
    <div
      data-testid={testId}
      data-shown={String(shown)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={rail}
    >
      {/* The ZONE — the tab's reach area, straddling the seam.
          POINTER-TRANSPARENT AT REST, and this is not a detail. The mock can leave `.tabzone`
          permanently pointer-active because there it is a box hung off an absolutely-positioned
          column with nothing under its overhang; here it overhangs 15px into the sidebar, straight
          over the agent rows at y≈34–86. An always-live rectangle there silently swallows every
          click aimed at a row's left edge — the same hazard AgentSidebar already keeps its own
          overlay tab inside the column to avoid.
          So HOVER IS DETECTED ON THE RAIL, which is the real in-flow gap between the columns and
          overhangs nothing.

          THE ZONE IS NEVER POINTER-ACTIVE. Gating it on `shown` narrowed the window but did not
          close it (roborev 54730): `shown` is entered by crossing the rail, which is the SAME
          trajectory that deposits the pointer 5–15px inside the sidebar — so by the time the
          rectangle went live the pointer was already over an agent row, and a press there was
          still swallowed. The zone is also 30×52 around a ~22×41 tab, so most of what it was
          claiming is dead space with no click of its own to receive.
          Only the VISIBLE TAB takes pointer events now, and only while it is shown. That is a
          control the user can actually see under the cursor, which is the whole test for whether
          something has the right to swallow a press. The tab carries its own hover handlers
          because it overhangs the rail — without them, travelling onto it would leave the rail,
          clear `hovered`, and make the tab vanish under the pointer that was reaching for it. */}
      <div data-testid={`${testId}-zone`} style={{ ...zone, top: topOffset, pointerEvents: "none" }}>
        <div
          data-testid={`${testId}-tab`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            ...tab,
            borderRadius: RADIUS.sm,
            opacity: shown ? 1 : 0,
            // At rest the tab must not take clicks: the zone above it overhangs 15px into each
            // column, and an invisible control that swallows a click is worse than a visible one.
            pointerEvents: shown ? "auto" : "none",
            // THE FOCUS RING. Drawn on the tab rather than on whichever zone holds focus: the two
            // zones are 12px and 8px wide, and a ring that tight around a chevron reads as part of
            // the glyph. Ringing the whole object is also the honest picture — what the keyboard
            // just summoned is the TAB, which was not on screen a moment ago.
            outline: focused ? `2px solid ${C.accentInk}` : "none",
            outlineOffset: focused ? 1 : 0,
          }}
        >
          {/* ── CHEVRON ZONE — overlay this column over the one to its right ─────────────────── */}
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
              style={zoneBtn}
            >
              {overlaid ? (
                <FiChevronLeft size={ARROW} strokeWidth={ARROW_STROKE} aria-hidden />
              ) : (
                <FiChevronRight size={ARROW} strokeWidth={ARROW_STROKE} aria-hidden />
              )}
            </button>
          )}
          {/* ── DOT ZONE — resize while docked; dock again while overlaid ────────────────────── */}
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
            style={{ ...zoneBtn, cursor: overlaid ? "pointer" : "col-resize" }}
          >
            <span aria-hidden style={dotField(2)}>
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} style={dot} />
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * THE 4×2 GRIP — a DIFFERENT control from the pull tab, sharing only its dot vocabulary.
 *
 * `MAPPING.md` puts `.grip` in the concierge header (`.ahd`: wordmark · grip · scope · need-chip)
 * and gives it one job: **drag the concierge between sides**. It is not hover-only and it does not
 * resize anything — it lives in a header the user is already looking at, and a control that moves a
 * whole column has no business appearing only when the pointer happens to graze a seam.
 *
 * Eight dots, four across, is what distinguishes it at a glance from the pull tab's six-in-two: a
 * WIDE field reads as "moves horizontally", a TALL one as "moves this edge".
 *
 * It is exported from here rather than built in `Concierge/` so the two dot fields cannot drift
 * apart — `DOT` and `DOT_GAP` are shared.
 *
 * ⚠ NOT WIRED YET. Nothing in the app mounts this, and no concierge-side state exists for
 * `onSideChange` to write to. `MAPPING.md` puts it in `.ahd` between the wordmark and the scope
 * chip, and `Concierge/ConciergeColumn.tsx` — owned by the concierge agent, not by this change —
 * is what will mount it. Until then this is a tested component with no users; see
 * `PRD/sparkle/blueprint-pull-tab.md` for the handoff.
 */
export interface ConciergeDragGripProps {
  /** Which side the concierge is on today. */
  side: "left" | "right";
  /** Commit the other side. Called only when the side actually changes. */
  onSideChange: (side: "left" | "right") => void;
  /** Human name of the column being moved, for the accessible name. */
  label?: string;
  testId?: string;
}

/**
 * How far the pointer must travel before a drag counts. Below this, the gesture is a click on a
 * header control the user was aiming past — and silently teleporting the whole concierge because
 * someone twitched is not a recoverable mistake at a glance.
 */
const GRIP_THROW = 24;

export function ConciergeDragGrip({
  side,
  onSideChange,
  label = "Sparkle column",
  testId = "concierge-drag-grip",
}: ConciergeDragGripProps) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);

  const move = useCallback(
    (next: "left" | "right") => {
      if (next !== side) onSideChange(next);
    },
    [side, onSideChange],
  );

  useEffect(() => {
    if (!dragging) return;
    const onUp = (e: MouseEvent) => {
      setDragging(false);
      const dx = e.clientX - origin.current;
      if (Math.abs(dx) >= GRIP_THROW) move(dx > 0 ? "right" : "left");
    };
    // THE RELEASE CAN GO MISSING, and here that is not a harmless no-op. Throwing the column to the
    // other side is a gesture that invites releasing OUTSIDE the window, and no `mouseup` arrives
    // for that. Without this, `dragging` stays true with a stale `origin`, and the NEXT click
    // anywhere in the app — an ordinary press on an unrelated control — reads as the end of that
    // drag and, being almost certainly ≥24px away, teleports the concierge.
    // So: the first move with no button held cancels the drag outright. `buttons` is a bitmask of
    // what is currently down, which is exactly the "did the release happen while I wasn't looking"
    // question; the pull tab's own effect has the same shape but degrades to a no-op, so only this
    // one needs it.
    const onMove = (e: MouseEvent) => {
      if (e.buttons === 0) setDragging(false);
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
    };
  }, [dragging, move]);

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={testId}
      data-side={side}
      aria-label={`Move the ${label} to the other side`}
      title={`Drag to move the ${label} to the other side (or focus it and use ← →)`}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        origin.current = e.clientX;
        setDragging(true);
      }}
      onKeyDown={(e) => {
        // The keyboard path is ABSOLUTE, not relative: ← means "put it on the left", which is the
        // only spelling that stays unambiguous when the control has already moved with the column.
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          move("left");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          move("right");
        }
      }}
      style={{ ...grip, cursor: dragging ? "grabbing" : "grab" }}
    >
      <span aria-hidden style={dotField(4)}>
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} style={dot} />
        ))}
      </span>
    </div>
  );
}

/**
 * The in-flow seam. It stays a 6px band in the column flow — the gap between the two columns —
 * and everything visible hangs off it absolutely, so the tab can overhang into both columns
 * without the shell having to make room for it.
 */
/** The rail's stacking level, EXPORTED so the columns it sits between can be pinned below it
 *  rather than merely commented as being below it.
 *
 *  The tab this rail carries is ~17px wide and centred in a 6px band, so it OVERHANGS the columns
 *  on both sides by ~5px. Any neighbour that outranks this value paints over that overhang and
 *  swallows its hit area — the control loses part of both its chrome and its click target, with
 *  nothing thrown and nothing to see in a unit test of either component alone. The concierge column
 *  did exactly that when its lift arrived (roborev 54712), which is why this is a shared constant
 *  now: `ConciergeColumn.CONCIERGE_LIFT_Z` is asserted against it. */
export const PULL_TAB_RAIL_Z = 4;

/** The full-height hit rail. 6px is the smallest band a pointer reliably lands on. */
const rail: CSSProperties = {
  flex: "0 0 auto",
  width: 6,
  position: "relative",
  // Above the sticky in-column furniture, so the boundary is never shadowed by something that
  // stops short of it.
  zIndex: 4,
};

/**
 * `.tabzone`. Centred on the seam and anchored near the TOP of the boundary — NOT vertically
 * centred, which is what the founder rejected. `translateX(-50%)` is the symmetric spelling of the
 * mock's `left:-15px` / `right:-15px`: our rail already sits ON the seam, so one rule serves both
 * boundaries instead of the mock's two edge cases.
 */
const zone: CSSProperties = {
  position: "absolute",
  left: "50%",
  transform: "translateX(-50%)",
  width: ZONE_W,
  height: ZONE_H,
  zIndex: 20,
};

/** The tab itself — one object holding both zones, stacked vertically. Arrow ABOVE dots. */
const tab: CSSProperties = {
  position: "absolute",
  top: TAB_TOP,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: TAB_GAP,
  padding: TAB_PAD,
  background: C.barSurface,
  border: `1px solid ${C.hairline}`,
  zIndex: PULL_TAB_RAIL_Z,
  transition: "opacity 120ms ease",
};

const zoneBtn: CSSProperties = {
  display: "grid",
  placeItems: "center",
  padding: 0,
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
};

/** `n` columns of squares. Six dots in 2 columns is the pull tab; eight in 4 is the grip. */
const dotField = (columns: number): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(${columns}, ${DOT}px)`,
  gap: DOT_GAP,
  // The field is wider than the band that owns the drag, so it must not take pointer events —
  // otherwise it eats every mousedown over the only visible part of the control.
  pointerEvents: "none",
});

/** SQUARE, not round. The founder asked for "a little bit more square than those round dots"; at
 *  3px there is no meaningful middle ground, and a crisp square is also the only spelling on the
 *  scale — the smallest real radius is 3px, which on a 3px box is just a circle again. It suits a
 *  shell whose thesis is that structure is drawn rather than filled. */
const dot: CSSProperties = {
  width: DOT,
  height: DOT,
  borderRadius: 0,
  background: C.muted,
};

const grip: CSSProperties = {
  display: "grid",
  placeItems: "center",
  padding: TAB_PAD,
  background: "transparent",
  border: "none",
  color: C.muted,
};
