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
// MOUNTED ON BOTH SEAMS NOW. This block used to warn that the shell mounted only one instance, on
// the concierge boundary, and that `grows: "right"` had no production caller — so the agent column
// kept the legacy trio this file's header says it replaces (a `col-resize` strip, a mid-height grip,
// a separate overlay button). All three are gone: `AgentSidebar` mounts this on the build/terminal
// boundary, anchored to the pair's pane side, and the LEFT pair is `grows: "right"`'s caller. The
// clearance note above still applies and `.bhd`'s seam-side padding lives in that file.
//
// The dots are SQUARE (no rounding) per the same conversation — "a little bit more square than
// those round dots". A round dot field reads as a generic drag handle; squares match a shell
// whose thesis is that structure is drawn rather than filled.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import { C } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import { log } from "../logger";
import { clampWidth, type ClampedBy } from "../engine/columnResize";

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
  /**
   * A SECOND CEILING THAT IS ONLY KNOWABLE AT GESTURE TIME, consulted at the start of each drag and
   * on each arrow press and INTERSECTED with `max` (never substituted for it — see `readGestureMax`).
   * Return `null` when it cannot be read; `max` then stands alone, exactly as before.
   *
   * WHY A CALLBACK AND NOT A SECOND NUMBER PROP. A column whose real bound is its CONTAINER — the
   * build column, whose paint is `min(width, calc(100% - 320px))` against the pair it lives in —
   * cannot learn that bound from a prop without its owner re-rendering whenever the container moves.
   * For the build column the container moves on every pointer event of the CONCIERGE's drag, and
   * `Workspace.renderCost.test.tsx` holds that drag to zero sidebar re-renders, because the sidebar
   * lists every agent and must not run at pointer rate. Worse, the headline case needs no drag at
   * all: opening the left pair halves the pair, and the right sidebar's props do not change, so
   * `memo` bails out and no render-time value could have noticed (bead sparkle-1kvfy).
   *
   * Reading it lazily costs nothing until the user actually grabs the seam, and at that moment it is
   * exact rather than as-of-the-last-render.
   */
  maxAt?: () => number | null;
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
   * HOW MUCH WIDTH ONE PIXEL OF POINTER TRAVEL BUYS. 1 for an ordinary seam; 2 for a column that
   * grows from BOTH edges at once.
   *
   * THIS KNOWINGLY REVERSES A FIX. Symmetric growth was removed once, as a bug: with both pairs
   * elastic and the concierge's width the only adjustable number in the row, "the column grew about
   * its centre and its left edge slid left every time the user dragged its right edge." The founder
   * was shown that exact sentence and chose symmetric anyway — because the column is now the row's
   * ANCHOR, and an anchor that stays centred is worth an edge that moves with its opposite. So the
   * behaviour the old comment called a defect is the specified behaviour here, and the seam that
   * uses it passes 2: pull either edge out by dx and the concierge gains 2·dx, dx on each side.
   *
   * The BOUNDS are unaffected — `min`/`max` are widths, and the clamp still reports which one
   * stopped a drag. Only the mapping from travel to width changes.
   */
  widthPerPx?: number;
  /**
   * THE CSS CUSTOM PROPERTY THIS TAB PAINTS INTO WHILE DRAGGING — how the gesture stays off React.
   *
   * A drag used to call `onWidth` on every pointer event, so every mousemove re-rendered the whole
   * shell: a measured drag cost 30 `Workspace` renders and 1,668ms of jank, because `Workspace`
   * re-renders the live pane list under it. With a variable, the drag writes one string onto the root
   * element and the browser re-lays-out the row on its own — no React work at all — and `onWidth`
   * fires ONCE, on release.
   *
   * Omit it and the column simply does not move until release. That is a coherent degradation rather
   * than a second code path: the COMMIT is the same either way, and this only decides whether the
   * user sees it happening. Every seam the shell mounts passes one.
   */
  cssVar?: string;
  /**
   * How far down the seam the hover zone starts. Defaults to the header band, which is what keeps
   * the tab clear of the header's own controls; a boundary whose columns have no header can pass 0.
   */
  topOffset?: number;
  testId?: string;
}

/**
 * Paint a width onto the root element, where every column that consumes it can see it.
 *
 * ON `document.documentElement`, NOT on the column, and that is the whole reason this works. A
 * custom property declared on the element itself would WIN over the inherited one, so React's
 * declaration and the drag's would fight and the drag would lose on the next render. Both writers
 * target the same place instead: the drag writes here at pointer rate, React writes here on commit,
 * and the columns only ever READ `var(--…)`. There is one source of truth and no reconciliation.
 */
export function publishColumnWidthVar(name: string, px: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(name, `${px}px`);
}

/**
 * THE DRAG SHIELD — a full-window sheet under the cursor for the duration of a gesture.
 *
 * A spindump of a real drag put 537 of 1,299 blocking WindowServer samples in WebKit recomputing the
 * cursor: every mouse-move hit-tests the element under the pointer and asks it what cursor to show,
 * and the shell's row is a deep tree of columns, panes and xterm canvases to walk. A single fixed
 * sheet with ONE `cursor` makes that answer constant, which removes about half the blocking time.
 *
 * It earns its place twice over: it also stops text selection and stops the pointer being stolen by
 * a canvas or an iframe mid-drag. It is created and destroyed with the gesture, so nothing is left
 * covering the app if a render happens to land in the middle.
 */
function makeDragShield(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "column-drag-shield");
  el.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;cursor:col-resize;background:transparent";
  document.body.appendChild(el);
  return el;
}

export function ColumnPullTab({
  width,
  onWidth,
  min,
  max,
  maxAt,
  label,
  overlaid = false,
  onOverlayToggle,
  grows = "left",
  widthPerPx = 1,
  cssVar,
  topOffset = HEADER_H,
  testId = "column-pull-tab",
}: ColumnPullTabProps) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  /** The live gesture: where it started, from what width, on which pointer, and the last width it
   *  painted. `null` between drags. A REF because none of it may re-render anything. */
  const drag = useRef<{ pointerId: number; x: number; width: number; applied: number } | null>(null);

  // EVERYTHING THE DRAG READS, IN ONE REF THAT IS NEVER A DEPENDENCY.
  //
  // The listeners used to be keyed on `[dragging, commit, grows, endDrag]`, and `commit` is rebuilt
  // whenever `onWidth`, `min`, `max` or `label` changes — which for the concierge seam is every time
  // `Workspace` re-renders, i.e. on every projectStore write. So the LIVE drag's own listeners were
  // torn down and re-added mid-gesture, repeatedly, on the exact hot path the instrumentation exists
  // to keep honest. Reading config through a ref instead lets the effect depend on `dragging` alone,
  // so the listeners are installed once per gesture and removed once.
  const cfg = useRef({ min, max, label, grows, widthPerPx, cssVar, onWidth, maxAt });
  cfg.current = { min, max, label, grows, widthPerPx, cssVar, onWidth, maxAt };

  /** THE CEILING THIS GESTURE IS RUNNING AGAINST — `maxAt`'s reading, latched for the duration.
   *
   *  LATCHED, not re-read per pointer event, for the two reasons `cfg` above exists: measuring the
   *  container on every move would make the drag pay a forced layout at pointer rate, and a bound
   *  that moved MID-gesture would make one pointer position mean two different widths.
   *  `null` = no reading; `cfg.current.max` then stands alone, which is every seam without `maxAt`. */
  const gestureMax = useRef<number | null>(null);
  // ── WHY `aria-value*` STILL NAMES THE WINDOW CEILING, AND NOT THE PAIR'S ──────────────────────
  //
  // It is wrong, it is KNOWN to be wrong, and it is deliberately left that way — bead sparkle-xbnw7.
  //
  // The separator advertises `max` while a gesture may enforce something tighter, so with the left
  // pair open it announces a range roughly twice the one the seam will honour. That is a real defect
  // for AT users, who have no other channel for the value. It was fixed here, five times, and every
  // version had a state STRICTLY WORSE than this one:
  //
  //   • a `measuredMax` state feeding the tab's width  → a click that committed nothing cached a
  //     narrow bound and the next drag started from a width that was not on screen (roborev 56159);
  //   • a ref written by `readGestureMax`              → a pointer gesture has no following blur, so
  //     the reading outlived its layout and under-reported while unfocused (57044);
  //   • a ref written only on focus                    → the announced POSITION froze while the
  //     boundary moved, because a keyboard user resizing never blurs (57046);
  //   • a ref written on focus and on gestures         → written-without-repaint on a pinned press
  //     (no state change → no render), and repainted-without-write on any unrelated store write,
  //     since this component is not memoised (57050).
  //
  // The last two are the two failure modes of reading a ref during render, and they are inherent to
  // it rather than bugs in it. Mirroring into state fixes the first and not the second. What all
  // five share is the same root: THIS COMPONENT CANNOT LEARN ITS CONTAINER CHANGED. Only a
  // render-time measurement or a ResizeObserver can, and both re-render the sidebar at pointer rate,
  // which `Workspace.renderCost.test.tsx` holds to zero — and the observer would be invisible to
  // that ratchet, since jsdom never lays out.
  //
  // So the honest state is the pre-existing one: a range that is consistently too wide, rather than
  // one that is sometimes right and sometimes under-reports a column's actual width. Doing it
  // properly means giving the tab a live bound from `Workspace`, which means revisiting that
  // ratchet — a real change with a real budget, not a comment. The GESTURE is correct either way:
  // `readGestureMax` re-reads before every drag and every arrow, and no announcement feeds it.
  /**
   * Take a fresh reading and return the bound now in force.
   *
   * IT INTERSECTS THE TWO CEILINGS, IT DOES NOT REPLACE ONE WITH THE OTHER — and the difference is a
   * lockout, not a nicety. `max` carries a HARD cap (the build column's 1200) whose whole job is to
   * stop a column being dragged over everything else; the container reading only says how much room
   * the pair has. On any window wide enough for `max` to saturate at that cap — ~1800px and up, i.e.
   * an ordinary external display — the container is the LARGER of the two, so taking the reading
   * neat would discard the cap entirely and let the column be dragged to ~1880 on a 2560px screen.
   * That width then persists, `aria-valuemax` and the tab's own width still report the capped
   * number, and the next mousedown starts 680px inward and destroys it: the very stored-vs-painted
   * split this reading exists to close, re-opened from the other side.
   *
   * A non-finite or non-positive answer is UNKNOWN, not a bound of zero — a container that has not
   * been laid out yet (the first frame of a mount, a test environment with no layout engine) must
   * not silently pin the column to its minimum.
   */
  /** The intersected bound, or `null` for "unknown" — with NO side effects, so both the gesture path
   *  and the announcement path can take a reading without one implying the other. */
  const measureBound = useCallback(() => {
    const hard = cfg.current.max;
    const m = cfg.current.maxAt?.();
    const usable = typeof m === "number" && Number.isFinite(m) && m > 0;
    return usable ? Math.min(m, hard) : null;
  }, []);
  const readGestureMax = useCallback(() => {
    gestureMax.current = measureBound();
    return gestureMax.current ?? cfg.current.max;
  }, [measureBound]);
  /** The bound in force right now: the gesture's latched reading, else the render-time prop. Reads
   *  only refs, so its identity is stable and it can never be the reason a listener is re-installed. */
  const ceiling = useCallback(() => gestureMax.current ?? cfg.current.max, []);

  // The last clamp state we reported, so a drag that sits pinned against a bound logs ONCE rather
  // than once per pointer event. Edge-triggered on purpose: `onMove` fires at pointer rate, and
  // every forwarded log line costs a JSON render plus a synchronous IPC → disk write on the main
  // thread (see logger.ts). Instrumenting a drag must not become its own source of jank — that
  // would be indistinguishable from the bug it was added to diagnose.
  const lastClamp = useRef<ClampedBy | "start">("start");
  // The last width we actually applied, for the drag-end line. A REF rather than reading the
  // `width` prop in the effect below: `width` in that dep array would tear down and re-add the
  // window listeners on every pointer event of the drag, which is churn on the exact hot path this
  // instrumentation exists to keep honest.
  const lastApplied = useRef<number | null>(null);
  /** Are we inside a RUN of arrow presses that are no longer moving the boundary? Separate from
   *  `lastClamp`, which belongs to the drag — see the note in `onKeyDown` for why one ref cannot
   *  serve both. */
  const keyPinned = useRef(false);

  const commit = useCallback(
    /**
     * @param apply `false` logs the clamp but writes NOTHING — the keyboard's answer to `endDrag`'s
     *        "only if it moved" guard, and it is load-bearing rather than tidy. Once the keyboard
     *        steps from `base = min(width, bound)` instead of from `width`, a press in the pinned
     *        direction resolves to `base` — which is NOT `width` — so an unconditional `onWidth`
     *        hands the owner a number that differs from its state and gets persisted. Stored 700
     *        with the pair bounding at 294: one ArrowRight moves nothing on screen and silently
     *        rewrites the preference to 294 (roborev 56171). The two input paths must agree that a
     *        gesture which moves nothing may not rewrite a stored width.
     */
    (next: number, apply = true) => {
      // The gesture's reading when one was taken — see `readGestureMax`. This is the KEYBOARD path's
      // commit; the pointer path settles through `preview` + `endDrag`, which read the same latch.
      const max = ceiling();
      const { requested, applied, clampedBy } = clampWidth(next, min, max);
      // WHY THIS LINE EXISTS: resizing was completely uninstrumented, so "the divider registers but
      // nothing moves" could not be told apart from "the divider moves it and something downstream
      // refuses to paint". `requested` vs `applied` answers exactly that, and `clampedBy` names the
      // bound when they differ.
      if (clampedBy !== lastClamp.current) {
        lastClamp.current = clampedBy;
        log.info(
          "resize",
          clampedBy
            ? `${label}: requested ${requested} → applied ${applied}, clamped by ${clampedBy} (min ${min}, max ${max})`
            : `${label}: requested ${requested} → applied ${applied}, unclamped`,
        );
      }
      lastApplied.current = applied;
      if (apply) onWidth(applied);
    },
    [onWidth, min, ceiling, label],
  );

  /** One line at the end of a gesture, so a drag is a bracketed span in the log rather than a
   *  scatter of width changes. `reason` distinguishes an ordinary release from a release the app
   *  never saw (`buttons === 0`), which is a real failure mode this component already guards.
   *
   *  AND IT IS WHERE THE WIDTH IS COMMITTED NOW — the one `onWidth` call a drag makes. See `cssVar`:
   *  the moves paint a CSS variable and do no React work at all, so the state change that used to
   *  happen hundreds of times per gesture happens exactly once, here. */
  const endDrag = useCallback((reason: "release" | "release-lost") => {
    const g = drag.current;
    const settled = g?.applied ?? lastApplied.current;
    log.info(
      "resize",
      `${cfg.current.label}: drag end (${reason}) at ${settled ?? "unchanged"}${
        settled == null ? "" : "px"
      }`,
    );
    drag.current = null;
    lastApplied.current = null;
    // The reading belonged to THIS gesture. Holding it past the release would let a stale container
    // width bound the next one — including an arrow press, which takes its own.
    gestureMax.current = null;
    setDragging(false);
    // ONLY IF IT MOVED. A press-and-release on the dots with no travel is a click, not a resize, and
    // committing there would mark the width dirty and persist a value the user never chose.
    if (g && settled != null && settled !== g.width) cfg.current.onWidth(settled);
  }, []);

  /** Paint an intermediate width WITHOUT touching React. Clamps and logs exactly as a commit does —
   *  the log is about the gesture, not about the state write — but the only side effect is the CSS
   *  variable the columns read. */
  const preview = useCallback((next: number) => {
    const { min: lo, label: name, cssVar: v } = cfg.current;
    // The gesture's latched ceiling, not `cfg.current.max` — for a container-bounded column those
    // are different numbers, and the preview is what the user is watching.
    const hi = gestureMax.current ?? cfg.current.max;
    const { requested, applied, clampedBy } = clampWidth(next, lo, hi);
    if (clampedBy !== lastClamp.current) {
      lastClamp.current = clampedBy;
      log.info(
        "resize",
        clampedBy
          ? `${name}: requested ${requested} → applied ${applied}, clamped by ${clampedBy} (min ${lo}, max ${hi})`
          : `${name}: requested ${requested} → applied ${applied}, unclamped`,
      );
    }
    lastApplied.current = applied;
    if (drag.current) drag.current.applied = applied;
    if (v) publishColumnWidthVar(v, applied);
  }, []);

  // While OVERLAID there is no boundary to drag: the column floats over its neighbour and its width
  // comes from the viewport, so a drag would silently move an edge the user cannot see. The dots
  // become a plain "dock me" button in that state — which is the founder's round trip.
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button only
    if (overlaid) return;
    e.preventDefault();
    // THE BOUND FIRST, THEN THE ORIGIN — and the origin is clamped to it. `width` is what the owner
    // painted as of its last render, which for a container-bounded column can exceed what is on
    // screen right now (the pair shrank without re-rendering the column). Starting from that number
    // is the "divider registers but nothing moves" bug: the first `width - bound` px of travel all
    // clamp to the same value, so the seam is dead for exactly the amount the reading just corrected.
    // The same rule every seam follows at render time — drag from what is PAINTED — applied at the
    // one moment the container bound is knowable.
    const bound = readGestureMax();
    const start = Math.min(width, bound);
    drag.current = { pointerId: e.pointerId, x: e.clientX, width: start, applied: start };
    // A drag is a new gesture too, so it must not inherit a latched keyboard run.
    keyPinned.current = false;
    // The START of the gesture, named. Without it a log shows widths changing with no way to tell
    // WHICH seam the user grabbed, and — more importantly for the v0.63.0 report — a drag that
    // produces no width lines at all is silent about whether it was ever recognised.
    lastClamp.current = "start";
    // The width the drag ACTUALLY starts from and the bound actually in force — not the props. When
    // the reading corrected either, that correction is the first thing the log has to show, or the
    // widths that follow look like they came from nowhere.
    log.info("resize", `${label}: drag start at ${start}px (min ${min}, max ${bound}, grows ${grows})`);
    // CAPTURE, so the gesture survives leaving the window — which a column drag does constantly,
    // since the seam can be dragged all the way to either edge. See the note on the listeners below
    // for why this does not replace them.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom and some synthetic pointers have no capture. The window listeners still deliver the
      // gesture; it just stops tracking once the pointer leaves the window, which is the behaviour
      // this component had before capture existed.
    }
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    // THE SHIELD GOES UP WITH THE GESTURE AND COMES DOWN WITH IT — tied to the effect's lifetime so
    // there is no path where a stuck flag leaves the app covered by an invisible sheet.
    const shield = makeDragShield();

    // WINDOW LISTENERS, STILL — pointer capture is an ADDITION to them, not a replacement.
    //
    // The original comment here explained that a dropped release must not leave the column following
    // the bare cursor, and window-level listening is what guaranteed the events arrive at all.
    // Capture makes them keep arriving OUTSIDE the window, which the old `mousemove` on `window`
    // could not do; but capture is also the part that silently does nothing in jsdom and under some
    // synthetic pointers. Listening on `window` keeps the gesture working when capture is absent,
    // and the captured element's events bubble to `window` anyway when it is present. Both, not
    // either.
    const onMove = (e: PointerEvent) => {
      const g = drag.current;
      if (!g || (e.pointerId !== undefined && g.pointerId !== e.pointerId)) return;
      // A DROPPED release must not leave the column following the bare cursor: if the button went up
      // somewhere the app never saw it, `buttons === 0` is how we find out (roborev 54730).
      if (e.buttons === 0) {
        endDrag("release-lost");
        return;
      }
      const dx = e.clientX - g.x;
      preview(g.width + (cfg.current.grows === "left" ? dx : -dx) * cfg.current.widthPerPx);
    };
    const onUp = () => endDrag("release");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A cancelled pointer (the OS taking over, a touch turning into a scroll) ends the gesture too —
    // without this the drag would hang with no release ever arriving.
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      shield.remove();
    };
    // `dragging` ALONE. Everything else the handlers read comes through `cfg`/`drag` refs, which is
    // what stops a shell re-render from re-installing these mid-gesture.
  }, [dragging, endDrag, preview]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (overlaid) return;
    // A KEYPRESS DURING A LIVE DRAG TOUCHES NOTHING (roborev 56159). The dots are `tabIndex={0}` and
    // `focused` is explicitly a supported state, so a user mid-drag can absolutely press a key — and
    // before this guard either outcome was wrong. A NON-arrow cleared `gestureMax`, so every
    // remaining `preview` of that drag clamped against the looser window ceiling and `endDrag`
    // committed a width the pair cannot paint: the bug being fixed, re-entered mid-gesture. An arrow
    // re-latched a fresh reading, which breaks `gestureMax`'s own contract that one pointer position
    // means one width, and fired a measurement on the drag's hot path.
    if (drag.current) return;
    // THE SAME MAPPING THE POINTER USES. An arrow key moves the EDGE by `step`, so on a symmetric
    // seam the column gains `step * widthPerPx` — otherwise the two input paths would disagree about
    // what one nudge means, and a keyboard user would find the concierge growing half as fast as the
    // mouse moves it.
    const step = (e.shiftKey ? BIG_STEP : STEP) * widthPerPx;
    const sign = grows === "left" ? 1 : -1;
    // EVERY NON-ARROW LEAVES BEFORE ANYTHING HAPPENS, and this one line now carries two rules that
    // used to be enforced separately further down.
    //
    //  • THE EDGE STATE. Arrowing outward after a drag that ended pinned at `max` must still log —
    //    `clampedBy` never changes, so the reported symptom would happen in silence — but resetting
    //    on EVERY keydown meant Tab, Enter or any character cleared the drag's edge state too,
    //    re-arming per-event logging on a key that moves nothing. That used to be spelled as "the
    //    reset lives inside the arrow branches"; the branches are gone, so the guard is here.
    //  • THE READING. `readGestureMax` performs a layout read. Taking it before this check meant any
    //    keypress on a focused tab measured the container and latched a bound no gesture asked for
    //    (roborev 56159).
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    // A KEYPRESS IS A GESTURE TOO, so it takes its own reading and steps from the same corrected base
    // a drag would. Without this the arrows walk down from an off-screen width one step at a time —
    // not dead, which is worse: it looks alive while every press before the first in-range one
    // paints nothing.
    const bound = readGestureMax();
    const base = Math.min(width, bound);
    const target = e.key === "ArrowRight" ? base + step * sign : base - step * sign;
    e.preventDefault();
    // TWO RULES PULL OPPOSITE WAYS HERE, and the keyboard needs its own edge state to satisfy both.
    //
    //  • A NEW GESTURE that goes nowhere must SAY SO. Arrowing outward after a drag that already
    //    ended pinned used to emit nothing at all — `clampedBy` never changed — so the reported
    //    symptom happened in silence. That is why the arrow re-arms `lastClamp` (the DRAG's edge
    //    state) rather than inheriting it.
    //  • A HELD arrow must not say so thirty times a second. OS auto-repeat is ~30/s and each line
    //    costs a JSON render plus a synchronous IPC → disk write on the main thread, so re-arming
    //    unconditionally turned the instrumentation into the jank it exists to diagnose.
    //
    // `keyPinned` is what separates them: it tracks a RUN of arrows that are no longer moving the
    // boundary, so the first one reports and the repeats are quiet — while a drag's pinned state,
    // which lives in `lastClamp`, cannot silence the first keypress that follows it.
    // Against `base` and `bound`, not `width` and `max`: the question is whether this press moves the
    // boundary the user can SEE, and after a correction those are different numbers.
    const moves = clampWidth(target, min, bound).applied !== base;
    if (moves) {
      keyPinned.current = false;
      lastClamp.current = "start";
    } else if (!keyPinned.current) {
      keyPinned.current = true;
      lastClamp.current = "start";
    }
    // LOG ALWAYS, WRITE ONLY IF IT MOVED — the same rule `endDrag` applies to the pointer. See
    // `commit`'s `apply` parameter for why an unconditional write here destroys a stored width.
    commit(target, moves);
    // AND THE GESTURE ENDS HERE, exactly as `endDrag` ends the pointer's. `gestureMax` is documented
    // as belonging to ONE gesture and `endDrag` says so in as many words; the keyboard used to latch
    // a reading and leave it set forever. That is inert only by an accident of the current call
    // graph — `preview` needs `drag.current` and `ceiling` is reached only from `commit` — so the
    // stated invariant was simply false, and any future caller of either outside a gesture would
    // silently inherit a container bound measured against a layout that no longer exists
    // (roborev 56182).
    gestureMax.current = null;
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
          something has the right to swallow a press.

          HOVER IS OWNED SOLELY BY THE RAIL, and the tab must NOT carry its own enter/leave.
          I added a pair here on the premise that the tab overhangs the rail geometrically, so
          travelling onto it would fire the rail's leave. That is not how React synthesises these:
          it walks the DOM path to the common ancestor, not the visual geometry, and the tab is a
          DESCENDANT (rail > zone > tab). So the enter was redundant and the LEAVE was actively
          harmful — moving tab → rail dispatched leave on the tab with no matching enter, clearing
          `hovered` while the pointer was still on the rail. The tab then vanished, and because a
          hidden tab is `pointerEvents:"none"` the pointer could not get back to it: it was already
          inside the rail, so no enter would ever fire again until the user left the seam entirely.
          A dead reveal, introduced by the fix for roborev 54691/54730 (roborev 54850). */}
      <div data-testid={`${testId}-zone`} style={{ ...zone, top: topOffset, pointerEvents: "none" }}>
        <div
          data-testid={`${testId}-tab`}
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
              {/* THE ARROW POINTS AT THE THING IT WILL DO, and that mirrors with the pair. Docked,
                  it points ACROSS the boundary — the direction the column is about to expand over.
                  Overlaid, it points BACK — the direction it will dock into. `grows` already
                  encodes which side of the seam the owned column sits on, so the mirror is read off
                  that rather than off a second prop that could disagree with it.

                  Hardcoding `FiChevronRight` here read correctly for years because the only
                  boundary that mounted this was the concierge's, on the right of the shell. The
                  left pair makes it wrong the same way every other unmirrored number in the row box
                  was wrong: the affordance points away from the pane it acts on. */}
              {(grows === "left") !== overlaid ? (
                <FiChevronRight size={ARROW} strokeWidth={ARROW_STROKE} aria-hidden />
              ) : (
                <FiChevronLeft size={ARROW} strokeWidth={ARROW_STROKE} aria-hidden />
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
            onPointerDown={startResize}
            onClick={() => {
              // Only meaningful while overlaid — this is the snap-back half of the round trip.
              if (overlaid) onOverlayToggle?.();
            }}
            onKeyDown={onKeyDown}
            // THE RUN ENDS WITH THE KEY. `keyPinned` used to be cleared only by an arrow that
            // MOVED the boundary, so it stayed latched indefinitely: press ArrowRight at `max`
            // once (line logged), release, press again minutes later — a genuinely new gesture
            // that goes nowhere — and nothing was logged, which is the silent symptom the whole
            // instrumentation exists to remove. OS auto-repeat emits no intervening `keyup`, so
            // this ends a run without ending a repeat.
            onKeyUp={() => {
              keyPinned.current = false;
            }}
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
  // THE RAIL is the flex sibling of the concierge column, so ITS z-index is what decides who
  // paints over the ~5px overhang. The merge left this hardcoded and moved
  // PULL_TAB_RAIL_Z onto `tab` — a grandchild inside `zone`, which has its own stacking
  // context, so that number was purely local and had no relationship to the concierge.
  // The pairing guard (CONCIERGE_LIFT_Z < PULL_TAB_RAIL_Z) was therefore inert: you could
  // satisfy it by bumping the constant while the rail stayed at 4 and the lift went back
  // to eating the tab's hit area — the exact roborev 54712 regression (roborev 54841).
  zIndex: PULL_TAB_RAIL_Z,
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
  // Local to `zone`, which is `position:absolute` with its own stacking context — this number
  // has no relationship to the concierge and must NOT be the exported rail constant.
  zIndex: 1,
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
