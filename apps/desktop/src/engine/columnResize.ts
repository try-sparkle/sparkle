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
// The cockpit is `TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM`. PRD 1 §3 set per-column minimums —
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
/**
 * The localStorage key holding the concierge's persisted SINGLE-PAIR width.
 *
 * HERE, NOT IN Workspace.tsx, for the same reason `CONCIERGE_DEFAULT_WIDTH` above is — and it is the
 * same failure a step further along. Workspace re-exports both, so its own readers are unchanged;
 * what moving them buys is a NODE-environment caller that needs the key without the component. The
 * visual harness's fixture module is exactly that: it seeds a narrowed concierge by writing this key
 * before `createRoot`, and its test runs under node. Re-spelling the string there instead would mean
 * a rename silently turning `?concierge=190` into a no-op, and the capture would photograph the
 * 380px default under a filename claiming half that — the mislabelled-screenshot failure the harness
 * exists to prevent (roborev 57506).
 */
export const CONCIERGE_WIDTH_KEY = "sparkle-concierge-width";
/** The TWO-PAIR width, stored separately — see Workspace.tsx's note on why the two modes cannot
 *  share one number. Lives here for the same node-reachability reason as the key above. */
export const CONCIERGE_WIDTH_KEY_PAIRED = "sparkle-concierge-width:2";
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

/**
 * The CSS length a build column actually PAINTS at, as an expression — the live `--build-<side>-w`
 * var, floored at the column minimum and ceilinged so the terminal beside it keeps its own minimum.
 * `100%` resolves against the pair's `.paircols` box, which is the element the var is sized within.
 *
 * IT EXISTS SO THERE IS ONE COPY. `AgentSidebar`'s `SPACER_WIDTH` is the same expression built
 * inline, and the Plan board overlay needs it too: that overlay is `inset: 0` over `.paircols` and
 * has to inset its header to the Build column's edge, which on a `row-reverse` (left) pair is a
 * whole column-width in from the right. Two hand-built copies of a clamp is exactly the drift this
 * repo keeps paying for, and `columnResize.test.ts` pins this against AgentSidebar's own source so
 * they cannot diverge silently.
 *
 * Takes the side rather than the var name so a caller cannot pair the left var with the right
 * column's fallback.
 */
export function BUILD_COLUMN_PAINTED_WIDTH(side: "left" | "right"): string {
  return `max(${BUILD_COLUMN_MIN_WIDTH}px, min(var(${buildWidthVar(side)}, ${BUILD_COLUMN_DEFAULT_WIDTH}px), calc(100% - ${TERMINAL_MIN_WIDTH}px)))`;
}
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

/** Storage for the build column's OVERLAY preference — spelled beside `buildWidthKey` for the same
 *  reason, and scoped one step further than the width is.
 *
 *  PER SIDE **AND PER WINDOW**. Splitting on side alone is not enough: the satellite forces
 *  `pairSide = "right"` (`SATELLITE_PAIR_SIDE`), so a side-only key hands the satellite the SAME
 *  string as the cockpit's right builder — one origin, one `localStorage`, one key. Live that looks
 *  correct, because each `AgentSidebar` owns its own `useState` and nothing listens for `storage`;
 *  the damage lands on the NEXT launch, when both instances seed from the value whichever of them
 *  wrote last. That is the identical latent-until-relaunch shape the per-side split was made to end,
 *  merely one window further out — the same place `ZoomColumnOverride` already found it for zoom.
 *
 *  The satellite is ONE column, so it needs no side of its own: `satellite` replaces the side rather
 *  than extending it. */
export function buildOverlayKey(side: "left" | "right", satellite = false): string {
  return `sparkle-sidebar-overlay:${satellite ? "satellite" : side}`;
}

/** The pre-split overlay key every build before `buildOverlayKey` wrote. Read as the SEED for each
 *  scope so an existing preference survives the upgrade, and never written back — the shape
 *  `LEGACY_BUILD_WIDTH_KEY` already established. Reading never writes, so the scopes diverge from a
 *  common ancestor the first time any one of them is toggled. */
export const LEGACY_BUILD_OVERLAY_KEY = "sparkle-sidebar-overlay";

/** The stored overlay preference for one scope — the SEED for `AgentSidebar`'s `overlay` state, and
 *  the only reader of the legacy key. Spelled here so the seed order (own key, then the shared
 *  ancestor) cannot be written differently by a second caller. */
export function readStoredOverlay(side: "left" | "right", satellite = false): boolean {
  let own: string | null = null;
  let legacy: string | null = null;
  try {
    own = localStorage.getItem(buildOverlayKey(side, satellite));
    legacy = localStorage.getItem(LEGACY_BUILD_OVERLAY_KEY);
  } catch {
    // A preference we cannot read is a preference we do not have; the column docks, as it did
    // before anyone toggled it.
    return false;
  }
  return (own ?? legacy) === "1";
}

/**
 * THE CONCIERGE'S OVERLAY IS A DIRECTION, NOT A BOOLEAN — and that is the whole difference from the
 * build column's (bead sparkle-7ymve1.3).
 *
 * A build column has ONE outboard neighbour, so "overlaid" is a yes/no. The concierge sits in the
 * MIDDLE of the row and has two seams, so the founder's own examples require two different
 * answers from one column: "the concierge would overlay EPICS" (leftward) and "makes the Build
 * column overlay the terminal" (rightward). The consistent rule behind all of them is OUTBOARD —
 * each column grows AWAY from the centre, over its next neighbour outward — which for a
 * middle column means the seam you pulled decides which way it goes.
 *
 * Encoding that as two booleans would admit a state the layout cannot paint: overlaid left AND
 * right at once, which is not "wider", it is two conflicting positions for one element. One
 * nullable direction makes that unrepresentable rather than merely untested.
 *
 * ONE KEY, because the concierge is ONE column — the opposite of `buildOverlayKey`, which must
 * split because there are two build columns and a satellite sharing a `localStorage` origin
 * (sparkle-7ymve1.5). Splitting a single column's preference per seam would let the two tabs
 * disagree about where their own column is.
 */
export type ConciergeOverlaySide = "left" | "right" | null;

/** Storage for the concierge's overlay DIRECTION — spelled beside the width's key for the same
 *  reason `buildOverlayKey` is: so a second caller cannot respell it. */
export const CONCIERGE_OVERLAY_KEY = "sparkle-concierge-overlay";

/** The stored overlay direction — the SEED for the concierge's overlay state, and the only reader
 *  of that key.
 *
 *  ANYTHING UNRECOGNISED IS `null`, not a throw and not a coerced `true`. The value is a free
 *  string in a store the user can edit and an older build can have written, and the honest reading
 *  of "I do not understand this" is the docked state — the same fail-closed choice
 *  `readStoredOverlay` makes for an unreadable store. */
export function readStoredConciergeOverlay(): ConciergeOverlaySide {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CONCIERGE_OVERLAY_KEY);
  } catch {
    // A preference we cannot read is a preference we do not have; the column docks.
    return null;
  }
  return raw === "left" || raw === "right" ? raw : null;
}

/**
 * WHICH DIRECTION A CLICK ON ONE SEAM SHOULD PRODUCE — the OUTBOARD rule, in one place.
 *
 * Clicking the seam you are already overlaid toward docks the column again (a toggle). Clicking
 * the OTHER seam moves the overlay to that side rather than docking first, because "I want it over
 * there" is one intention and should not cost two clicks.
 */
export function nextConciergeOverlay(
  current: ConciergeOverlaySide,
  seam: "left" | "right",
): ConciergeOverlaySide {
  return current === seam ? null : seam;
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

// ── THE EPICS COLUMN ───────────────────────────────────────────────────────────────────────────
//
// The founder asked for epics as "a full column, just like the Build column is a full column …
// its own draggable seam and yes, mirrored left and right exactly". So it is a real `ColumnKey`
// pair with its own storage, its own floor and its own live ceiling — every constant below is the
// build column's twin, deliberately spelled out rather than aliased.
//
// WHY IT SITS INBOARD OF BUILD. The row reads
// `TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM`: you pick an epic beside the concierge
// you are talking to, and the orchestrators it selects are in the very next column out. Putting it
// outboard of Build would separate the click from the thing the click filters.

/** The epics column's floor — the shared 50px every column in this row answers to. The founder's
 *  rule is that only these floors narrow a column; everything else is window-aware. */
export const EPICS_COLUMN_MIN_WIDTH = COLUMN_MIN_WIDTH;

/** The epics column's width when nothing has been stored.
 *
 *  280 rather than the build column's 220: every row here carries a stage label and a count as well
 *  as a title, and the ladder's longest label ("Building") plus a two-digit count needs the extra
 *  60px before titles start ellipsing on first launch. It is a starting point, not a bound — the
 *  seam moves it and the value persists. */
export const EPICS_COLUMN_DEFAULT_WIDTH = 280;

/** Per-side storage, exactly like the build column's — the two epics columns are INDEPENDENT, which
 *  is what "mirrored left and right exactly" means for a width: the mirror is the geometry, not the
 *  number. Spelled HERE and not in `EpicsColumn` for the same reason `buildWidthKey` is: `Workspace`
 *  reads both sides to seed the row, and a key spelled in two files is the drift this module exists
 *  to prevent.
 *
 *  A BARE NEW KEY IS SAFE WITH NO MIGRATION, and that is worth stating because widths here have no
 *  store, no version and no migration at all. `localStorage.getItem` returns `null` for a key that
 *  has never been written, `Number(null)` is `0` — not `NaN` — and 0 fails the `>= ` test below, so
 *  an upgrading install falls to the default rather than painting a zero-width column. */
export function epicsWidthKey(side: "left" | "right"): string {
  return `sparkle-epics-width:${side}`;
}

/** The live CSS custom property a drag writes, so the column repaints without a React commit —
 *  the same mechanism, and the same reason, as `buildWidthVar`. */
export function epicsWidthVar(side: "left" | "right"): string {
  return `--epics-${side}-w`;
}

/** What must stay beside the epics column when it is dragged: the concierge at its floor, the build
 *  column beside it at its floor, ONE terminal, and both rails.
 *
 *  ONE MORE TERM THAN `BUILD_COLUMN_ROW_RESERVE`, and the extra term is the build column itself —
 *  which is the whole difference between the two. Build is the outermost column that can be dragged
 *  against the concierge, so nothing sits between them; epics has Build outboard of it and must
 *  leave it its floor or a drag would swallow a column whole. */
export const EPICS_COLUMN_ROW_RESERVE =
  COLUMN_MIN_WIDTH + BUILD_COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH + 2 * RAIL_WIDTH;

/** The epics column's live ceiling — ONE spelling, read by `EpicsColumn` (which bounds the gesture)
 *  and by the storage reader below (which rejects a width saved on a bigger display). */
export function epicsColumnMax(windowWidth: number): number {
  return windowAwareMax(
    COLUMN_HARD_MAX,
    windowWidth,
    EPICS_COLUMN_ROW_RESERVE,
    EPICS_COLUMN_MIN_WIDTH,
  );
}

/**
 * A side's stored epics width, validated against the live window — the SEED for `EpicsColumn`'s
 * width state, and its only caller.
 *
 * READING NEVER WRITES: an out-of-range stored width is DISCARDED rather than clamped, exactly as
 * `readStoredBuildWidth` documents at length. Clamping would put the reduced number into state, and
 * the first drag after that would persist it — destroying a preference set on a bigger display.
 *
 * There is no legacy key to seed from: this column has never existed before, so a missing key is
 * simply the first launch and the default is the right answer.
 */
export function readStoredEpicsWidth(side: "left" | "right", windowWidth: number): number {
  const max = epicsColumnMax(windowWidth);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(epicsWidthKey(side));
  } catch {
    // Storage can be unavailable outright; the default is a fine answer and must not throw a render.
  }
  const saved = Number(raw);
  if (saved >= EPICS_COLUMN_MIN_WIDTH && saved <= max) return saved;
  return Math.min(EPICS_COLUMN_DEFAULT_WIDTH, max);
}

/**
 * The CSS length the epics column actually PAINTS at, as an expression — the twin of
 * {@link BUILD_COLUMN_PAINTED_WIDTH}, and it exists for the same reason: so there is ONE copy.
 *
 * `100%` resolves against the pair's `.paircols` box. The reserve subtracted is the build column's
 * floor plus the terminal's, because those are the two columns that share this half with it.
 */
export function EPICS_COLUMN_PAINTED_WIDTH(side: "left" | "right"): string {
  return `max(${EPICS_COLUMN_MIN_WIDTH}px, min(var(${epicsWidthVar(side)}, ${EPICS_COLUMN_DEFAULT_WIDTH}px), calc(100% - ${BUILD_COLUMN_MIN_WIDTH + TERMINAL_MIN_WIDTH}px)))`;
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
  // THE TWO EPICS FLOORS ARE PART OF THIS SUM, and leaving them out is not a rounding error — it is
  // the concierge being draggable straight OVER both epics columns until they vanish. Every column
  // the row contains has to be named here or the drag is bounded against a row that no longer
  // exists.
  return (
    2 * BUILD_COLUMN_MIN_WIDTH +
    2 * EPICS_COLUMN_MIN_WIDTH +
    2 * TERMINAL_MIN_WIDTH +
    2 * RAIL_WIDTH
  );
}

/** A SANITY CEILING, not the operative bound — the reserve above is what actually stops the drag.
 *
 *  `CONCIERGE_MAX_WIDTH` was 560, which blocked the founder's two target layouts (~1100 and ~1920 on
 *  a 3×1920 span) by 2–3.5×. This number exists only so a corrupt or hand-edited stored width cannot
 *  name something absurd; every real limit comes from `conciergePairedReserve` against the live
 *  window. Shares `COLUMN_HARD_MAX` so no column carries a tighter sanity cap than any other. */
export const CONCIERGE_PAIRED_HARD_MAX = COLUMN_HARD_MAX;

/** The concierge's own floor — the shared 50px floor every column answers to. It was 280, which on
 *  a ~890px window put this column's ceiling AT its floor (`min 280, max 280` in the log) and left
 *  the seam dead through three consecutive drags. */
export const CONCIERGE_MIN_WIDTH = COLUMN_MIN_WIDTH;
/** The single-pair ceiling. The shared sanity cap rather than a bare 560: the founder's rule is that
 *  only the 50px floors narrow a column, and the window-aware max keeps the seam inside the window. */
export const CONCIERGE_MAX_WIDTH = COLUMN_HARD_MAX;

/**
 * Whether a width read back from storage is one this app will HONOUR — the single authority, called
 * by everyone who needs the answer.
 *
 * A PREDICATE RATHER THAN THREE EXPORTED BOUNDS, and the difference is the whole point. `Workspace`
 * validated a stored width inline against two PRIVATE aliases of the column constants, while
 * `dev/visualFixtures` — which SEEDS that storage for the capture harness — bounded its own
 * parameter on the column constants directly. Those agree only because the aliases are currently
 * identity, which nothing enforces and which has already been false once: this ceiling was 560 until
 * recently. Tighten either and the fixture accepts a width the app then rejects — `?concierge=1000`
 * is written to both keys, the initialiser refuses it, the app falls back to
 * `CONCIERGE_DEFAULT_WIDTH`, and `open-pr-menu-narrow` files a 360px capture under a name claiming
 * 1000. Sharing the BOUNDS would still leave two call sites free to compare them differently; a
 * shared PREDICATE leaves nothing to drift.
 *
 * `paired` picks the ceiling: the two-pair shell stores its width separately and answers to
 * {@link CONCIERGE_PAIRED_HARD_MAX}, because in that layout the concierge is the ANCHOR rather than
 * a reading column. A non-finite input (an absent key reads back as `NaN` or `0`) is refused by the
 * comparisons anyway; it is named so the intent is not left to coercion.
 *
 * NOTE ON SCOPE, because a comment elsewhere once claimed more: this answers "will the state
 * initialiser KEEP this number". The shell clamps AGAIN at paint time against a window-aware max,
 * so a width accepted here can still be painted narrower on a small window.
 */
export function acceptsStoredConciergeWidth(width: number, opts: { paired: boolean }): boolean {
  if (!Number.isFinite(width)) return false;
  const max = opts.paired ? CONCIERGE_PAIRED_HARD_MAX : CONCIERGE_MAX_WIDTH;
  return width >= CONCIERGE_MIN_WIDTH && width <= max;
}

/** The widest the concierge may be dragged in a TWO-PAIR row: whatever the window leaves once every
 *  other column keeps its 50px floor and both rails keep theirs, and never below `min`. */
export function conciergePairedMax(windowWidth: number, min: number): number {
  return windowAwareMax(CONCIERGE_PAIRED_HARD_MAX, windowWidth, conciergePairedReserve(), min);
}

/** The columns of the cockpit, outboard-left to outboard-right.
 *
 *  `epics-*` sits INBOARD of `build-*`, between it and the rail — so the row reads
 *  `TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM`. The order in this union is the order
 *  on screen, and `cockpitGeometry` below is the only thing that enforces it.
 *
 *  NOT DATA-DRIVEN, and worth knowing before you add the next one: there is no `COLUMN_ORDER`, no
 *  `Record<ColumnKey, …>` and no `isLeft`/`isRight`. The order is hand-written TWICE inside
 *  `cockpitGeometry` (once per pair count), the widths arrive as NAMED fields on `CockpitInput`,
 *  and `columnZoom`'s `ZoomColumn` is a separate union whose `satisfies` bridge breaks on a RENAME
 *  but not on an ADDITION. A new member therefore compiles cleanly while being invisible in the
 *  row and silently non-zoomable; every one of those sites has to be edited by hand. */
export type ColumnKey =
  | "terminal-left"
  | "build-left"
  | "epics-left"
  | "rail-left"
  | "concierge"
  | "rail-right"
  | "epics-right"
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
  /** The left epics column's stored width. Ignored when `pairCount` is 1. */
  epicsLeftWidth: number;
  /** The right epics column's stored width. */
  epicsRightWidth: number;
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
 * The epics column's PAINTED width inside a half of the given size — `paintedBuildWidth`'s twin,
 * and the arithmetic form of the CSS `EPICS_COLUMN_PAINTED_WIDTH` sets.
 *
 * IT IS RESOLVED FIRST, BEFORE THE BUILD COLUMN, and that ordering is the collapse order rather
 * than an accident of where the lines sit. A half narrows in this sequence: the terminal yields to
 * a strip (it is `flex: 1` against effectively no min-content), then the build column pins at its
 * floor, and only then does epics give anything up. That is what the founder's "a full column, just
 * like the Build column" buys — the column he is selecting from is the last thing to disappear, not
 * the first. `halfWidth` is reduced by BOTH neighbours' floors so neither can be swallowed whole.
 *
 * The STORED width is untouched by any of this: a column squeezed by a wide concierge springs back
 * to the width its owner chose as soon as the concierge narrows again. Only the pixels yield.
 */
export function paintedEpicsWidth(storedWidth: number, halfWidth: number): number {
  return Math.max(
    EPICS_COLUMN_MIN_WIDTH,
    Math.min(storedWidth, halfWidth - BUILD_COLUMN_MIN_WIDTH - TERMINAL_MIN_WIDTH),
  );
}

/** How much WIDER than its docked width an overlaid column becomes.
 *
 *  A BOOST, NOT A CEILING, and that distinction is the whole bug this replaces. The overlay used to
 *  be `max(280px, min(480px, 100%))` — an absolute cap — so a column already dragged to 480 or wider
 *  popped out at the SAME width or narrower, in the same place, while its spacer held the full
 *  docked slot so nothing beside it moved either. Position, size and neighbours all unchanged: the
 *  control did nothing, which is exactly how it was reported. `PRD/feat/sidebar-pull-tabs.md`
 *  predicted it in writing at ship time ("when the column is already dragged to 480 the pop-out is
 *  the same width and differs only by floating") and named `OVERLAY_MAX_W` as the knob; the answer
 *  is that no absolute knob can work, because the docked width has no upper bound worth speaking of
 *  (`COLUMN_HARD_MAX` is 8000). Expressed as a delta, the overlay is strictly wider at EVERY
 *  starting width, which is the only property that makes the affordance honest. */
export const OVERLAY_WIDTH_BOOST = 280;

/** How much of the container an overlaid column must leave UNCOVERED.
 *
 *  So the pane underneath still peeks out. An overlay that reaches the far edge is indistinguishable
 *  from a mode switch: nothing on screen says the thing it covered is still there, and there is no
 *  click-away or Escape dismissal (deliberately — see the PRD), so the only way back is the tab you
 *  have to remember is under your cursor. Leaving a strip visible keeps it reading as a LAYER. */
export const OVERLAY_EDGE_RESERVE = 120;

/** The floor, so a narrow window yields a usable panel rather than a sliver. Carried over unchanged
 *  from the expression this replaces, which is where the 280 comes from. */
export const OVERLAY_MIN_WIDTH = 280;

/**
 * AN OVERLAID COLUMN'S WIDTH — the arithmetic form of the CSS `AgentSidebar` actually sets.
 *
 * Same contract as `paintedBuildWidth` above: the component builds its `calc()` from these very
 * constants and a test asserts the string it renders matches this rule, rather than re-spelling the
 * numbers in two places that can drift.
 *
 * THE INVARIANT WORTH TESTING IS `result > dockedWidth`, not any particular number. That is the one
 * property whose absence made the feature inert, and the one no test in the repo asserted — the
 * suite pinned the exact clamp STRING, which is green whether the column was 220px or 900px before
 * the click. A rule that can return the docked width is a no-op by construction.
 *
 * The edge reserve can only lose to the floor on a container too narrow to honour both; that is the
 * same precedence the old expression had (`max` outermost), and it is deliberate — a sliver is worse
 * than an overhang.
 *
 * AND THE DOCKED WIDTH IS A FLOOR TOO, which is the half the first version missed (roborev 65324).
 * The dock is clamped to `container - TERMINAL_MIN_WIDTH` and `TERMINAL_MIN_WIDTH` is 50, while the
 * overlay's ceiling is `container - OVERLAY_EDGE_RESERVE` = container - 120. So for any docked width
 * in `(container-120, container-50]` — a band an ordinary drag-to-max lands in, since the container
 * clamp binds before `buildColumnMax` does — the reserve pulled the overlay BELOW the dock, and the
 * column visibly SHRANK by up to 70px while its spacer held the full slot. That is the reported
 * symptom again, one notch worse than inert. Taking the dock as a floor means the reserve can cost
 * the overlay its growth in that band, but can never make it narrower than the thing it overlays.
 */
export function overlaidColumnWidth(dockedWidth: number, containerWidth: number): number {
  return Math.max(
    OVERLAY_MIN_WIDTH,
    dockedWidth,
    Math.min(dockedWidth + OVERLAY_WIDTH_BOOST, containerWidth - OVERLAY_EDGE_RESERVE),
  );
}

/**
 * THE ROW, SOLVED — every column's position and width, from the five numbers that determine them.
 *
 * Widths are left unrounded on purpose. An odd `windowWidth - conciergeWidth - 2·RAIL` splits into
 * two half-pixel halves, exactly as the browser does with `flex: 1 1 0`, and rounding here would
 * manufacture an off-by-one asymmetry the real layout does not have.
 */
export function cockpitGeometry(input: CockpitInput): ColumnRect[] {
  const {
    windowWidth,
    pairCount,
    conciergeWidth,
    buildLeftWidth,
    buildRightWidth,
    epicsLeftWidth,
    epicsRightWidth,
  } = input;

  if (pairCount === 1) {
    // THE SINGLE-PAIR SHELL: concierge on the left with ONE rail, and the sole pair taking the rest.
    // It is not centred and is not meant to be — there is no left half to balance against, and the
    // founder's report is explicitly that this layout already works.
    //
    // IT GAINS THE EPICS COLUMN, and that is not a contradiction of "unchanged". This shell is one
    // pair, and the epics column belongs to a PAIR, not to the two-pair layout: the founder's
    // requirement (5) is that epics "would be showing if I have any projects open on the left side"
    // — i.e. one per pair, appearing exactly when its pair does. A single-pair install that never
    // opens a left pair still gets an epics column beside its concierge, which is the only reading
    // under which "a full column, just like the Build column" is true. What is unchanged is the
    // GEOMETRY: the concierge is still pinned left with one rail and the pair still takes the rest.
    const half = Math.max(0, windowWidth - conciergeWidth - RAIL_WIDTH);
    const epics = paintedEpicsWidth(epicsRightWidth, half);
    const build = paintedBuildWidth(buildRightWidth, half - epics);
    const xEpics = conciergeWidth + RAIL_WIDTH;
    return [
      { key: "concierge", x: 0, width: conciergeWidth },
      { key: "rail-right", x: conciergeWidth, width: RAIL_WIDTH },
      { key: "epics-right", x: xEpics, width: epics },
      { key: "build-right", x: xEpics + epics, width: build },
      {
        key: "terminal-right",
        x: xEpics + epics + build,
        width: Math.max(0, half - epics - build),
      },
    ];
  }

  // TWO EQUAL HALVES. This single division is the whole centring guarantee — both halves are
  // `flex: 1 1 0` against the same free space, so neither can absorb a change the other does not.
  // Adding a third column INSIDE each half cannot disturb that: the halves are still equal, and
  // what changes is only how each one is subdivided.
  const half = (windowWidth - conciergeWidth - 2 * RAIL_WIDTH) / 2;
  // Epics first, then build against what is left — see `paintedEpicsWidth` for why that order IS
  // the collapse order rather than an accident of line order.
  const epicsL = paintedEpicsWidth(epicsLeftWidth, half);
  const epicsR = paintedEpicsWidth(epicsRightWidth, half);
  const buildL = paintedBuildWidth(buildLeftWidth, half - epicsL);
  const buildR = paintedBuildWidth(buildRightWidth, half - epicsR);
  const termL = Math.max(0, half - epicsL - buildL);
  const termR = Math.max(0, half - epicsR - buildR);

  const rails = RAIL_WIDTH;
  const xBuildL = termL;
  const xEpicsL = xBuildL + buildL;
  const xRailL = xEpicsL + epicsL;
  const xConcierge = xRailL + rails;
  const xRailR = xConcierge + conciergeWidth;
  const xEpicsR = xRailR + rails;
  const xBuildR = xEpicsR + epicsR;
  const xTermR = xBuildR + buildR;

  return [
    { key: "terminal-left", x: 0, width: termL },
    { key: "build-left", x: xBuildL, width: buildL },
    { key: "epics-left", x: xEpicsL, width: epicsL },
    { key: "rail-left", x: xRailL, width: rails },
    { key: "concierge", x: xConcierge, width: conciergeWidth },
    { key: "rail-right", x: xRailR, width: rails },
    { key: "epics-right", x: xEpicsR, width: epicsR },
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
