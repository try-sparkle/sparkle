// THE EPIC ROW'S SQUARE. One presentational leaf; every decision it renders is made in
// `engine/epicHealth`, which is where the reasoning lives.
//
// ══ SQUARE IS LOAD-BEARING, NOT DECORATION ═════════════════════════════════════════════════════
// The founder asked for it twice in one breath — *"status icons for the epics ... They should be
// square instead of circle"* — and the reason is that the build column's rows are DISCS. Shape is
// what tells him, at a glance across two columns, whether he is looking at an epic's health or an
// agent's. Rounding this off to match `StatusDot` would delete the distinction he asked for.
//
// SHAPE IS THE ONLY THING THAT MAY DIFFER — and that is the whole design. The founder, 2026-08-22:
// *"I do want it to work exactly like the Build Agent. That's the hard rule. The colors work the
// same between the two and don't let any instruction ever override that."* So: same five values
// (`EpicHealth` IS `RollupDot`), same five colours, read from the same table the build row reads.
// Different geometry, so you can tell which column you are looking at. Nothing else.
//
// THE CORNERS ARE HARD (`borderRadius: 0`), for two reasons that happen to agree. It is the most
// unmistakably NOT-a-disc a 9px mark can be, which is the property the founder named; and `0` is one
// of the three values `theme/scale.test.ts`'s radius ratchet exempts (alongside `PILL` and `50%`,
// the idiomatic circle). That ratchet's ceiling is now **0** — the migration off hand-typed radii is
// COMPLETE — so a softening 1px here is not a nicety, it is a fleet-red on a finished ratchet. Do
// not add one.
//
// ══ IT IS A READOUT WITH NO HANDLER, AND THAT IS ENFORCED ══════════════════════════════════════
// `EpicRow` is ONE `<button>`, and `Workspace.epicsColumn.test.tsx` clicks EVERY descendant of it
// asserting the row's own click still fires. A clickable child here would swallow that click, which
// is the exact live bug the epic goal span shipped (`sparkle-huw924.3`, fixed in PR #2285). So this
// takes no `onClick`, has no `role`, and stops no propagation — same contract `BeadPriorityChip`
// follows one slot over.
//
// ══ COLOURS COME FROM `ROLLUP_DOT_COLOR`, THE BUILD ROW'S OWN TABLE ════════════════════════════
// Not from a local map, and emphatically not from a re-typed hex. `components/rowClock` is where the
// build column decides what a rolled-up disc is filled with; reading the SAME record here is what
// makes "the colors work the same between the two" a structural fact rather than a promise two files
// have to keep independently. A copied hex is a difference waiting to happen, which is the exact
// failure mode the founder's hard rule legislates against.
//
// (That table also explains why the values are raw tier colours rather than `statusInk`: this is a
// FILLED SHAPE, not text. A rolled-up epic green is therefore pixel-identical to a working agent's
// dot, which is what "just like the build agents" means.)
import { ROLLUP_DOT_COLOR } from "./rowClock";
import { epicHealthLabel, type EpicHealth } from "../engine/epicHealth";

/** 9px. Small enough that it costs the (already ellipsised) epic title almost nothing in a 280px
 *  column, large enough to read a colour at. */
const SIDE = 9;

/**
 * The health square for one epic row.
 *
 * ── WHY `gray` IS A SOLID GRAY SQUARE AND NOT A HOLLOW AMBER ONE ────────────────────────────────
 * It used to be hollow amber, and this comment used to argue for that at length. The argument rested
 * on an earlier rule of the founder's (2026-08-19) — *"Nothing should ever be gray unless it has
 * been effectively finished"* — from which it followed that an epic nobody is building must not be
 * gray, because it is unstarted rather than finished.
 *
 * HE HAS RETIRED THAT READING HIMSELF, 2026-08-22, and replaced it with a rule that outranks every
 * other consideration on this file:
 *
 *   *"For the gray I do want it to work exactly like the Build Agent. That's the hard rule. The
 *   colors work the same between the two and don't let any instruction ever override that. When I
 *   say 'effectively finished' I just meant that turn is finished or whatever. Where it's not active
 *   right now, however gray currently works, just make it the same."*
 *
 * So gray does not mean "finished". It means NOT ACTIVE RIGHT NOW — which is exactly what it means
 * on a build row, and exactly what is true of an epic with no agent working on it. The reasoning
 * that produced the hollow amber is recorded above rather than deleted, so the next reader can see
 * that it was overruled by the founder rather than lost in an edit.
 *
 * The practical consequence: there is no `hollow` variant left, no epic-only ink, and no `Exclude<>`
 * in the fill lookup. All five marks are solid squares filled straight from `ROLLUP_DOT_COLOR`.
 */
export function EpicHealthSquare({
  health,
  label,
}: {
  health: EpicHealth;
  /** Hover/announced text, when the caller's noun is not "epic".
   *
   *  The MARK is identical on every surface (the founder's colour-parity rule); only the WORDS
   *  differ, and this repo treats user-facing copy as code. A child-task row passes
   *  `engine/beadHealth.beadHealthLabel`, which is the same five values with "this task" in place
   *  of "this epic". Omitted, an epic row keeps `epicHealthLabel` — so the default is the surface
   *  this component was written for and no existing caller changes. */
  label?: string;
}) {
  const text = label ?? epicHealthLabel(health);
  // The ONE lookup, in the build column's own table. `EpicHealth` is `RollupDot`, so this is a total
  // index with nothing to map and nothing to fall back to — which is the point.
  const ink = ROLLUP_DOT_COLOR[health];
  return (
    <span
      data-testid="epic-health"
      data-health={health}
      title={text}
      // The square carries the row's only statement about progress, so it is announced rather than
      // hidden: the row's `aria-pressed` says whether the card is open, not whether anyone is
      // building the epic.
      role="img"
      aria-label={text}
      style={{
        flex: "0 0 auto",
        // The row is `alignItems: "baseline"` for the title/chiclet/count; a 9px box has no useful
        // baseline of its own, so it centres against the row instead of hanging off the text's.
        alignSelf: "center",
        width: SIDE,
        height: SIDE,
        borderRadius: 0,
        background: ink,
        boxSizing: "border-box",
      }}
    />
  );
}
