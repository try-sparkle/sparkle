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

/** THE BUILD COLUMN'S FLOOR — the width below which it stops being a column.
 *
 *  HERE, NOT IN `AgentSidebar`, because the callers that need it are the ones computing a ROW's
 *  reserve, and they must not re-spell it. Putting it on the component made `Workspace` import the
 *  component to learn a number, which every suite that mocks `./AgentSidebar` then had to re-declare —
 *  and a constant two files declare separately is precisely the class of bug this branch keeps
 *  re-finding (roborev 55910). This module already owns the row's other invariants. */
export const BUILD_COLUMN_MIN_WIDTH = 160;
/** What must stay for the terminal beside the build column — the floor its CSS clamp leaves it.
 *  Matches the thin-column hazard `paneVisibility` already carries a backstop for: a terminal driven
 *  to ~0 spawns its PTY at fallback dimensions. */
export const TERMINAL_MIN_WIDTH = 320;

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
