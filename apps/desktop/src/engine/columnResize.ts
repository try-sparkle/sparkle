// A COLUMN DRAG, AS A RULE YOU CAN READ IN A LOG.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────────────
//
// v0.63.0 shipped a report that the columns could not be resized: "the divider registers — the
// cursor changes, the drag is recognised — but nothing moves." Diagnosing it from the logs was
// impossible, because RESIZING WAS COMPLETELY UNINSTRUMENTED. Not one divider, drag, or
// column-width event existed anywhere in the log stream, so the only way to learn what the app had
// done was to ask the user what their cursor looked like.
//
// That is the gap this closes. The clamp is pulled out of the component into a pure function that
// reports WHY it landed where it did, so a drag that goes nowhere says so in one line:
//
//     resize concierge: requested 420 → applied 400, clamped by max (min 280, max 400)
//
// versus a drag that is simply not being applied at all, which produces no `applied` line. Those
// two are indistinguishable on screen and were indistinguishable in the log; they are different
// bugs with different fixes, and telling them apart used to cost a round trip with the user.
//
// ── THE FIVE-COLUMN QUESTION ───────────────────────────────────────────────────────────────────
//
// The cockpit is `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`. PRD 1 §3 set per-column minimums —
// concierge 320, build 240, terminal 400 expanded — when the shell had THREE columns. At five they
// sum to roughly 1600px before dividers and chrome, which is wider than a laptop window: if those
// minimums were enforced as hard floors on the LAYOUT, every column would already be pinned and
// every drag would have nowhere to give. That is exactly the shape of the report.
//
// The answer this file encodes is that a per-column minimum is a floor on what the USER MAY DRAG
// TO, not a floor on what the layout may render. `fitsAtMinimums` says whether the window can
// satisfy every minimum at once; when it cannot, `collapseOrder` names what gives way first. PRD 1
// says terminal collapses to a strip, then build — and that order is preserved here, but it is now
// stated once, for a five-column shell, instead of being re-derived per boundary.
//
// The terminals absorbing the shortfall is what keeps a drag alive on a narrow window: they are
// `flex: 1` against a `min-width` of effectively zero (their panes are `position: absolute`, so
// they contribute no min-content), so they give up space silently and the seams stay draggable.
// A hard `min-width` on a terminal would convert that into the frozen layout described above.

/** Which bound stopped a requested width, if any. `null` means the request was honoured. */
export type ClampedBy = "min" | "max" | null;

export interface ClampResult {
  /** What the drag asked for, rounded — before any bound was applied. */
  requested: number;
  /** What the column will actually be set to. */
  applied: number;
  /** Which bound moved it, or `null` when nothing did. */
  clampedBy: ClampedBy;
}

/**
 * Clamp a requested column width and say which bound did it.
 *
 * The reason is the whole point: `applied === requested` tells you a drag worked, and
 * `clampedBy` tells you which of the two very different "it didn't move" causes you are looking at.
 * A degenerate range (`min > max`) resolves to `min` and reports `min`, rather than silently
 * inverting — a config that cannot be satisfied should be visible, not smoothed over.
 */
export function clampWidth(requested: number, min: number, max: number): ClampResult {
  const want = Math.round(requested);
  if (want < min) return { requested: want, applied: min, clampedBy: "min" };
  if (want > max) return { requested: want, applied: max, clampedBy: "max" };
  return { requested: want, applied: want, clampedBy: null };
}

// ── WHY THE BUDGET IS PROSE HERE AND NOT CODE ──────────────────────────────────────────────────
//
// This file briefly exported `cockpitMinimums` / `minimumShellWidth` / `fitsAtMinimums` /
// `collapseOrder`. They had NO CALLERS: nothing in the layout consulted them, so the budget they
// claimed to enforce was still enforced entirely by the flex rules in `Workspace.tsx` and
// `index.css`, and the numbers could drift from the real column styling with no signal. Their tests
// were worse than useless — `expect(collapseOrder()).toEqual(["terminal","build"])` echoes a
// hardcoded return, and the width assertion re-derived the implementation's own arithmetic — so the
// failure the section exists to prevent (a hard `min-width` landing on a terminal and freezing every
// seam) would have left all of them green. That is the "assertion was already true before the
// change" shape AGENTS.md names as the #1 fleet-wide finding, and shipping it inside the very file
// arguing for honest instrumentation would have been the joke telling itself.
//
// So the reasoning stays as the note above, where it is accurate and costs nothing, and the only
// thing exported is the clamp — which IS wired, on both boundaries and on both the pointer and the
// keyboard paths. When the shell actually needs to arbitrate a shortfall, the rule can come back
// WITH the caller that reads it and a test that asserts the rendered outcome (render at 1280px with
// two pairs; assert the terminals, not the concierge, absorb it).

// ── THE WINDOW IS A BOUND TOO ──────────────────────────────────────────────────────────────────
//
// A per-column ceiling that ignores the window is how a resize becomes UNRECOVERABLE. Raising the
// build column's hard max to 1200 re-opened exactly the lockout its own comment claimed to prevent:
// that column's pull tab is absolutely positioned at its pair-side edge, so on a 900–1100px window a
// column dragged to 1200 puts its resize tab AND its overlay chevron past the viewport edge, with
// `body { overflow: hidden }` and nothing to reflow them back. The width is persisted, so the state
// survives relaunch and the only ways out are widening the window or editing localStorage
// (roborev 55847).
//
// `reserve` is what must stay on screen beside the column: the other columns' minimums plus the seam
// rails. The `min` floor is deliberate — on a window too narrow to satisfy even that, the answer is
// the column's own minimum, never a value below it, because an inverted range is how a clamp starts
// returning nonsense instead of a bound.

// ── ONE MINIMUM, FOR EVERY COLUMN — AND NOTHING ELSE STOPS A DRAG ──────────────────────────────
//
// THE FOUNDER'S RULE, verbatim: "Nothing should block the other columns from going to any sort of
// width except for maybe a minimum width of 50 pixels for any given column. Besides that it should
// be totally possible to drag any column to any width."
//
// This deliberately overturns the per-column minimums the file previously carried (build 160,
// terminal 320, concierge 280). Those were not arbitrary, but at five columns they summed to ~760px
// of reserve before any column could move — and on a ~890px window that is what a measured session
// actually hit: `agent column: min 160, max 290` (the max is `window - 600`), then `Sparkle column:
// min 280, max 280`, where min EQUALS max and the seam is dead. Three drags in a row moved nothing.
// A minimum that large is not a floor, it is a freeze.
//
// So every column now shares ONE floor, and every ceiling is derived from it: a column may be
// dragged to whatever the window leaves once each OTHER column keeps its 50px and the rails keep
// theirs. Nothing else narrows it.
export const COLUMN_MIN_WIDTH = 50;

/** THE BUILD COLUMN'S FLOOR — the width below which it stops being a column.
 *
 *  HERE, NOT IN `AgentSidebar`, because the callers that need it are the ones computing a ROW's
 *  reserve, and they must not re-spell it. Putting it on the component made `Workspace` import the
 *  component to learn a number, which every suite that mocks `./AgentSidebar` then had to re-declare —
 *  and a constant two files declare separately is precisely the class of bug this branch keeps
 *  re-finding (roborev 55910). This module already owns the row's other invariants. */
export const BUILD_COLUMN_MIN_WIDTH = COLUMN_MIN_WIDTH;

/**
 * The concierge column's default width.
 *
 * Lives HERE rather than in Workspace.tsx because it is read by a pure decision that must not drag a
 * React component in behind it: voice/sendMode's short-label threshold is pinned against it, and
 * that test runs under NODE. Importing Workspace — 61 top-level imports, Tauri APIs, seven stores —
 * to read one integer made a pure logic test hostage to any module-scope `document` added anywhere
 * in that graph (roborev 56223). This module already owns the sibling column widths.
 */
export const CONCIERGE_DEFAULT_WIDTH = 360;
/** What must stay for the terminal beside the build column — the floor its CSS clamp leaves it.
 *
 *  NOW THE SHARED 50px FLOOR, down from 320. The 320 was the single largest contributor to the frozen
 *  row above: it appears TWICE in a two-pair reserve, so it alone spent 640px of any window before a
 *  seam could move.
 *
 *  The hazard it was guarding is real but is NOT enforced here, and never was — a terminal squeezed
 *  toward ~0 would have its PTY spawned or resized at a nonsense width, which bakes hard-wrapped
 *  output into the scrollback permanently. `terminalSize.ts` is the actual guard: `isMeasuredSize`
 *  refuses to hand the child any size below `MIN_PLAUSIBLE_COLS`/`MIN_PLAUSIBLE_ROWS`, so a terminal
 *  dragged very narrow simply stops pushing sizes to its child rather than pushing a bad one. That
 *  backstop sits between the layout and the PTY and is unaffected by this constant.
 *
 *  THE TRADEOFF, STATED: at 50px a terminal is ~7 columns, below `MIN_PLAUSIBLE_COLS` (20), so its
 *  child keeps the last good width while xterm paints narrower. Output written in that window wraps
 *  against the wider size and looks wrong until the column is widened again — recoverable, and the
 *  scrollback written while squeezed stays wrapped. That is the cost of "any column to any width",
 *  and it is the founder's call, made explicitly. */
export const TERMINAL_MIN_WIDTH = COLUMN_MIN_WIDTH;

/**
 * The largest width a column may be dragged to given the live window — its hard ceiling, lowered so
 * that `reserve` px are still left for everything else, and never below `min`.
 */
export function windowAwareMax(
  hardMax: number,
  windowWidth: number,
  reserve: number,
  min: number,
): number {
  return Math.max(min, Math.min(hardMax, windowWidth - reserve));
}

// ── THE CONCIERGE IS THE ANCHOR — THE FIVE-COLUMN GEOMETRY, AS ARITHMETIC ──────────────────────
//
// Everything below is new, and it exists because the row's geometry USED to be a set of flex rules
// that no test could evaluate. jsdom has no layout engine: `min()`/`calc()` never resolve and
// `getBoundingClientRect` is all zeros, so "is the concierge centred" was literally unaskable of the
// rendered DOM. The rules were therefore only ever asserted as *strings* — which is how the row came
// to be asymmetric in a way nobody noticed until a window spanned three monitors.
//
// So the layout is stated ONCE, here, as a function of five numbers, and the components are wired to
// express exactly this and nothing else:
//
//     row:        [ left half: flex 1 1 0 ][ rail ][ concierge: var ][ rail ][ right half: flex 1 1 0 ]
//     left half:  [ terminal: flex 1 1 0 ][ build: var ]        (mirrored — terminal outboard)
//     right half: [ build: var ][ terminal: flex 1 1 0 ]
//
// THE CENTRING IS A THEOREM, NOT A TUNING. Two halves that are `flex: 1 1 0` against the SAME
// remaining space are equal by the flex algorithm, so the concierge's centre is
// `half + rail + C/2` and the row's centre is `(2·half + 2·rail + C)/2` — the same expression, for
// EVERY window width, every concierge width and every pair of build widths. That is what
// `cockpitGeometry` computes and what the tests assert, rather than a table of numbers that would
// have to be re-derived every time a constant moved.
//
// WHAT THIS DELIBERATELY OVERTURNS: the row was asymmetric on purpose. The left pair carried its own
// pinned width and the RIGHT pair was the only `flex: 1`, so it absorbed every change — on a 5760px
// span that left the right pair ~4,700px, two and a half displays, while the concierge sat wherever
// the left pair's width happened to put it. The founder asked for the concierge to be the anchor
// instead, and accepted the consequence the old model was built to avoid (see `widthPerPx` in
// `ColumnPullTab`: one edge now moves the other).

/** The in-flow seam between the concierge and a half. `ColumnPullTab`'s rail is 6px wide. */
export const RAIL_WIDTH = 6;

// ── THE THREE WIDTHS, AS CSS CUSTOM PROPERTIES ─────────────────────────────────────────────────
//
// Named here because three different components write and read them and a variable spelled in three
// files is the same drift this module exists to prevent. They live on `document.documentElement`:
// during a drag the pull tab writes one at pointer rate with no React work at all, and on release
// React writes the same property with the committed value. One target, one source of truth, nothing
// to reconcile — see `publishColumnWidthVar` in `ColumnPullTab`.

/** The concierge column's live width. */
export const CONCIERGE_WIDTH_VAR = "--concierge-w";
/** Emitted by `AgentSidebar` on mount and on every width change.
 *
 *  NO LISTENER TODAY. It existed so the row could re-reserve for a build column's real width, back
 *  when the concierge's ceiling reserved `2 * max(left, right)`. That reserve is gone — it made
 *  widening one column silently un-widen another — so `Workspace` no longer mirrors these widths and
 *  nothing subscribes. Retained because it is the only channel that reports a build width to the rest
 *  of the app and a future consumer would otherwise have to reinvent it; delete it with the emitter
 *  if none appears. Do NOT read the old rationale as describing live behaviour. */
export const BUILD_WIDTH_EVENT = "sparkle:build-width";
/** A build column's live width. Per side, because the two builders are independent. */
export function buildWidthVar(side: "left" | "right"): string {
  return side === "left" ? "--build-l-w" : "--build-r-w";
}

/** The build column's width when nothing has been stored — `AgentSidebar`'s historical default. */
export const BUILD_COLUMN_DEFAULT_WIDTH = 220;
/** A SANITY CEILING, not the operative bound — the window is what actually stops the drag.
 *
 *  Set above the widest span the app is plausibly centred on (3×1920 = 5760) so it never binds in
 *  practice; the founder's rule is that only the 50px floors narrow a column. The lockout this
 *  number used to guard against (roborev 55847 — a column dragged wider than the window puts its
 *  pull tab past the viewport edge, unrecoverably, because the width is persisted) is closed by the
 *  window-aware bound below instead: a column can never exceed `windowWidth - reserve`, so the seam
 *  always stays at least `reserve` px inside the window and remains grabbable. */
export const COLUMN_HARD_MAX = 8000;
/** @deprecated Prefer {@link COLUMN_HARD_MAX}; kept as the build column's spelling of it. */
export const BUILD_COLUMN_HARD_MAX = COLUMN_HARD_MAX;
/** What must stay beside the build column: the concierge at its floor, ONE terminal, and both rails.
 *
 *  NOT every other column — and the difference is deliberate rather than an oversight in the wording.
 *  This bounds the GESTURE against the WINDOW. The other half of the row is bounded separately and
 *  more precisely by `RENDERED_WIDTH`'s container clamp in `AgentSidebar`, which measures the pair
 *  this column actually lives in; adding the far half here would double-count it and narrow the drag
 *  for no gain. Spelled here so the gesture bound and the storage reader cannot disagree — the two
 *  callers of `buildColumnMax`. (It fed a ROW reserve once; that consumer is gone.) */
export const BUILD_COLUMN_ROW_RESERVE = COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH + 2 * RAIL_WIDTH;

/** The build column's live ceiling. ONE spelling, read by `AgentSidebar` (which bounds the gesture)
 *  and by the storage reader below (which rejects a width saved on a bigger display). */
export function buildColumnMax(windowWidth: number): number {
  return windowAwareMax(
    BUILD_COLUMN_HARD_MAX,
    windowWidth,
    BUILD_COLUMN_ROW_RESERVE,
    BUILD_COLUMN_MIN_WIDTH,
  );
}

/** Per-side storage for the build column — the two builders are INDEPENDENT, which is the founder's
 *  "one doesn't change when the other changes". The key is spelled HERE rather than in `AgentSidebar`
 *  because `Workspace` has to read both sides to know what the concierge may be dragged to, and a
 *  key spelled in two files is the drift this module already exists to prevent. */
export function buildWidthKey(side: "left" | "right"): string {
  return `sparkle-sidebar-width:${side}`;
}

/** The pre-split key every build before the per-side keys wrote. Read as the SEED for both sides so
 *  an existing width survives rather than silently resetting to the default. */
const LEGACY_BUILD_WIDTH_KEY = "sparkle-sidebar-width";

/**
 * A side's stored build width, validated against the live window — the SEED for `AgentSidebar`'s
 * width state, and its only caller.
 *
 * It was once shared with `Workspace`, which mirrored the result into the concierge's reserve; that
 * reserve is the shared 50px floors now, so nothing else reads this. The old rationale (keeping the
 * row from re-implementing the restore rules) is retracted rather than merely stale — see the body's
 * note on why the default's clamp is defensive today.
 */
export function readStoredBuildWidth(side: "left" | "right", windowWidth: number): number {
  const max = buildColumnMax(windowWidth);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(buildWidthKey(side)) ?? localStorage.getItem(LEGACY_BUILD_WIDTH_KEY);
  } catch {
    // Storage can be unavailable outright; the default is a fine answer and must not throw a render.
  }
  const saved = Number(raw);
  if (saved >= BUILD_COLUMN_MIN_WIDTH && saved <= max) return saved;
  // THE DEFAULT IS A WIDTH TOO, so it answers to the same ceiling — but this clamp is now DEFENSIVE
  // rather than load-bearing, and saying so is more useful than inventing a consequence for it.
  //
  // It used to matter: `Workspace` mirrored this value into the concierge's reserve, so an over-large
  // default lowered the concierge's ceiling for a column that painted narrower. That consumer is
  // gone — the reserve is the shared floors now, a constant. And it is NOT what keeps a drag on
  // screen: `AgentSidebar` computes its gesture bound as `buildColumnMax(windowWidth)` independently
  // of this return, and hands the tab `min(width, MAX_WIDTH)`, which is the roborev-55993
  // painted-not-stored fix. Remove the clamp and the seeded column would paint and drag identically.
  //
  // What it still buys, scoped precisely: the value RETURNED here is within `buildColumnMax(
  // windowWidth)` AT SEED TIME. It says nothing after that, and deliberately so — `AgentSidebar`
  // never reconciles `width` against `MAX_WIDTH` again, so `width > MAX_WIDTH` is that column's
  // normal steady state after a window shrink and is exactly what makes the preference survive
  // (see its painted-not-stored block). The container clamp in a two-pair row is a separate bound
  // again, which a seed inside `buildColumnMax` can still exceed with no window resize at all.
  //
  // So: do NOT read this as "`data-width` never exceeds the window ceiling". It routinely does, by
  // design. (Three earlier attempts at this comment each claimed a consequence that did not survive
  // inspection — roborev 57344, 57371, 57385, 57399. The clamp is cheap and keeps the seed honest;
  // that is the whole of it.)
  //
  // AN OUT-OF-RANGE STORED WIDTH IS STILL DISCARDED RATHER THAN CLAMPED, deliberately. Clamping it
  // would put the reduced number into `AgentSidebar`'s state, and the first drag after that would
  // persist it — destroying a preference set on a bigger display, which is the exact failure the
  // rendered-vs-stored split exists to prevent (roborev 55883/55897). Reading never writes.
  return Math.min(BUILD_COLUMN_DEFAULT_WIDTH, max);
}

/**
 * What the concierge must leave for the rest of a TWO-PAIR row: every other column at the shared
 * 50px floor, plus both rails. Nothing else.
 *
 * THE MINIMUMS, NOT THE LIVE WIDTHS — and this reverses the previous rule deliberately. It used to
 * reserve `2 × max(buildLeft, buildRight)`, on the reasoning that reserving less "would let the
 * concierge be dragged straight over a build column the user had deliberately widened" (roborev
 * 56070). That reasoning holds only if being squeezed is damage. It is not: `paintedBuildWidth`
 * below clamps a build column to `half - TERMINAL_MIN_WIDTH` for PAINT while its STORED width is
 * left untouched, so a builder squeezed by a wide concierge springs back to the width its owner
 * chose as soon as the concierge narrows again. The preference survives; only the pixels yield.
 *
 * What the old rule cost instead was the founder's actual request. Reserving live widths means a
 * neighbour you widened silently lowers this column's ceiling — so widening one column makes another
 * un-widenable, which is exactly the "nothing moves" report. With both builders at 316 on an ~890px
 * window the concierge's ceiling landed at its own floor, and `min === max` made the seam dead.
 *
 * Single-pair rows do NOT use this. That path keeps its own reserve, because the one thing this
 * change must not do is move a layout the founder says is already working.
 */
export function conciergePairedReserve(): number {
  return 2 * BUILD_COLUMN_MIN_WIDTH + 2 * TERMINAL_MIN_WIDTH + 2 * RAIL_WIDTH;
}

/** A SANITY CEILING, not the operative bound — the reserve above is what actually stops the drag.
 *
 *  `CONCIERGE_MAX_WIDTH` was 560, which blocked the founder's two target layouts (~1100 and ~1920 on
 *  a 3×1920 span) by 2–3.5×. This number exists only so a corrupt or hand-edited stored width cannot
 *  name something absurd; every real limit comes from `conciergePairedReserve` against the live
 *  window. Shares `COLUMN_HARD_MAX` so no column carries a tighter sanity cap than any other. */
export const CONCIERGE_PAIRED_HARD_MAX = COLUMN_HARD_MAX;

/** The widest the concierge may be dragged in a TWO-PAIR row: whatever the window leaves once every
 *  other column keeps its 50px floor and both rails keep theirs, and never below `min`. */
export function conciergePairedMax(windowWidth: number, min: number): number {
  return windowAwareMax(CONCIERGE_PAIRED_HARD_MAX, windowWidth, conciergePairedReserve(), min);
}

/** The columns of the cockpit, outboard-left to outboard-right. */
export type ColumnKey =
  | "terminal-left"
  | "build-left"
  | "rail-left"
  | "concierge"
  | "rail-right"
  | "build-right"
  | "terminal-right";

/** Where a column paints and how wide it is, in row coordinates. */
export interface ColumnRect {
  key: ColumnKey;
  x: number;
  width: number;
}

export interface CockpitInput {
  /** The row's width — the window, since the shell is `width: 100vw` with no horizontal chrome. */
  windowWidth: number;
  /** 2 is the five-column cockpit; 1 is the historical right-half-only shell. */
  pairCount: 1 | 2;
  /** The concierge's width AS PAINTED — the caller has already lowered it to its live ceiling. */
  conciergeWidth: number;
  /** The left build column's stored width. Ignored when `pairCount` is 1. */
  buildLeftWidth: number;
  /** The right build column's stored width. */
  buildRightWidth: number;
}

/**
 * A build column's PAINTED width inside a half of the given size.
 *
 * This is the arithmetic form of the CSS `AgentSidebar` actually sets —
 * `max(160px, min(<stored>px, calc(100% - 320px)))` — where `100%` is the half. The two must agree,
 * so the component builds its expression from these same constants and a test asserts the string it
 * renders matches this rule rather than re-spelling the numbers.
 *
 * The terminal absorbing the remainder is what keeps every seam draggable on a narrow window: it is
 * `flex: 1` against effectively no min-content, so it yields silently. Below a 480px half the build
 * column pins at its floor and the terminal takes the whole shortfall — the collapse order this
 * module has always documented (terminal to a strip first, then build).
 */
export function paintedBuildWidth(storedWidth: number, halfWidth: number): number {
  return Math.max(BUILD_COLUMN_MIN_WIDTH, Math.min(storedWidth, halfWidth - TERMINAL_MIN_WIDTH));
}

/**
 * THE ROW, SOLVED — every column's position and width, from the five numbers that determine them.
 *
 * Widths are left unrounded on purpose. An odd `windowWidth - conciergeWidth - 2·RAIL` splits into
 * two half-pixel halves, exactly as the browser does with `flex: 1 1 0`, and rounding here would
 * manufacture an off-by-one asymmetry the real layout does not have.
 */
export function cockpitGeometry(input: CockpitInput): ColumnRect[] {
  const { windowWidth, pairCount, conciergeWidth, buildLeftWidth, buildRightWidth } = input;

  if (pairCount === 1) {
    // THE SINGLE-PAIR SHELL, UNCHANGED: concierge on the left with ONE rail, and the sole pair
    // taking the rest. It is not centred and is not meant to be — there is no left half to balance
    // against, and the founder's report is explicitly that this layout already works.
    const half = Math.max(0, windowWidth - conciergeWidth - RAIL_WIDTH);
    const build = paintedBuildWidth(buildRightWidth, half);
    return [
      { key: "concierge", x: 0, width: conciergeWidth },
      { key: "rail-right", x: conciergeWidth, width: RAIL_WIDTH },
      { key: "build-right", x: conciergeWidth + RAIL_WIDTH, width: build },
      {
        key: "terminal-right",
        x: conciergeWidth + RAIL_WIDTH + build,
        width: Math.max(0, half - build),
      },
    ];
  }

  // TWO EQUAL HALVES. This single division is the whole centring guarantee — both halves are
  // `flex: 1 1 0` against the same free space, so neither can absorb a change the other does not.
  const half = (windowWidth - conciergeWidth - 2 * RAIL_WIDTH) / 2;
  const buildL = paintedBuildWidth(buildLeftWidth, half);
  const buildR = paintedBuildWidth(buildRightWidth, half);
  const termL = Math.max(0, half - buildL);
  const termR = Math.max(0, half - buildR);

  const rails = RAIL_WIDTH;
  const xBuildL = termL;
  const xRailL = xBuildL + buildL;
  const xConcierge = xRailL + rails;
  const xRailR = xConcierge + conciergeWidth;
  const xBuildR = xRailR + rails;
  const xTermR = xBuildR + buildR;

  return [
    { key: "terminal-left", x: 0, width: termL },
    { key: "build-left", x: xBuildL, width: buildL },
    { key: "rail-left", x: xRailL, width: rails },
    { key: "concierge", x: xConcierge, width: conciergeWidth },
    { key: "rail-right", x: xRailR, width: rails },
    { key: "build-right", x: xBuildR, width: buildR },
    { key: "terminal-right", x: xTermR, width: termR },
  ];
}

/** The centre of a column, in row coordinates — what "the concierge is dead centre" is asserted on. */
export function centreOf(columns: readonly ColumnRect[], key: ColumnKey): number {
  const c = columns.find((col) => col.key === key);
  if (!c) throw new Error(`no such column: ${key}`);
  return c.x + c.width / 2;
}
