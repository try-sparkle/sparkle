// THE SHARED ROW ANATOMY — THE PART OF IT THAT IS REACT.
//
// WHY THIS FILE EXISTS
//
// The build column is scannable straight down only because every row in it is the SAME row: same
// leading disc slot, same box, same mouths where a selected row opens into its pane. That is a
// rule, and a rule needs somewhere to live that every row type can reach.
//
// It used to live nowhere. `rowBoxFor` and `ActiveFillets` were module-private inside
// `AgentSidebar.tsx` (6,000+ lines), so `AgentRow` and `SparkleAgentRow` honoured the anatomy for
// exactly one reason: they were declared in the same file. `SparkleAgentRow`'s own docstring is the
// written form of the rule — "same disc slot (DOT_SLOT_W / DOT_SIZE), same box (ROW_PAD_*,
// LIST_PAD_X), same title size (AGENT_NAME_FONT_SIZE) and neutral ink, same leading ElapsedTimer"
// — and READ THAT DOCSTRING before adding a row type; it is the authority on what "reads as a row
// in this column" means, and it records which special cases were removed and why.
//
// A `PersonRow` in its own file cannot obey a rule it cannot import. Hence the split, along the
// engine/components line this app already draws:
//
//   engine/rowGeometry.ts  — the NUMBERS and the pure rule (`rowBox`, `ROW_PAD_*`, `LIST_PAD_X`,
//                            `DOT_SLOT_W`, `DOT_SIZE`, `GLYPH_SLOT_H`, `DEPTH_INDENT`,
//                            `ACTIVE_FILLET*`). Deliberately React-free — do not import a component
//                            into it.
//   components/rowAnatomy.tsx (here) — the half that needs React and the theme: the `rowBoxFor`
//                            wrapper that feeds `rowBox` the app's radii and vertical padding, and
//                            the `<ActiveFillets>` chrome, which needs `C.forest`.
//
// Consumers today: `AgentRow` and `SparkleAgentRow` (AgentSidebar.tsx), and the forthcoming
// `PersonRow` (components/PersonRow.tsx). Anything that draws a row in the build column belongs on
// this list; anything that reimplements a number from it is the drift this file exists to stop.
//
// The extraction itself was behaviour-neutral by construction: `AgentSidebar.rowGeometry` and
// `AgentSidebar.sparkleRow` measure both rows in a rendered sidebar and passed UNCHANGED across it.

import { Fragment } from "react";
import { C } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import {
  ACTIVE_FILLET,
  ACTIVE_FILLET_RUN,
  ROW_PAD_Y,
  rowBox,
  type PairSide,
} from "../engine/rowGeometry";

// ── THE SELECTED ROW'S GEOMETRY, IN ONE PLACE ─────────────────────────────────────────────────
// The active row's corners: square on the PANE side (it opens into the terminal — the mouth below
// does that work) and rounded on the concierge side; fully rounded when it isn't selected. WHICH
// physical side each of those is flips with the pair, and the cable squares the concierge end too —
// both decided by `rowBox`, which is why this is now a call rather than two constants.
//
// Shared, because two rows draw it: a build/worker row and the pinned Improve Sparkle row. They were
// literals in both for one commit, which is the one-sided-drift hazard the rest of the row anatomy
// was consolidated to remove — changing one leaves the other on the old geometry with every test
// green. AgentSidebar.sparkleRow.test.tsx compares the two rows' computed radius and mouth paint
// directly, so a change has to land here to satisfy both.
//
// `RADIUS.modal`, not a literal: a stray `10` is both off-scale (theme/scale.test.ts is a ratchet at
// 0) and the kind of local re-derivation blueprintSpec.ts exists to end. The mock's leading radius
// is `--r-lead: 10px` and RADIUS tops out at 6 (`modal`); this holds at the token and the missing
// step is reported rather than hard-coded.
export function rowBoxFor(opts: {
  paneSide: PairSide;
  jointOpen: boolean;
  isActive: boolean;
  depthIndent?: number;
  pinned?: boolean;
}) {
  return rowBox({
    ...opts,
    leadRadius: RADIUS.modal,
    idleRadius: RADIUS.modal,
    padY: ROW_PAD_Y,
  });
}

/** THE MOUTH: a concave fillet where a selected row opens into the pane — NOT a corner.
 *
 *  A `border-radius` curves the corner IN. It cuts material away, so the row NECKS DOWN as it
 *  reaches the pane — the exact opposite of what a junction should do. A mouth curves OUT, the way a
 *  river opens into a delta: the channel widens and the bank sweeps away from it. NO radius value
 *  produces that at any size; it is a different construction, and the distinction cost ~20 review
 *  rounds (MAPPING.md, "Geometry vocabulary"). If a review says "rounded the wrong way / backwards",
 *  changing the number is not converging.
 *
 *  The construction, straight from the mock's `--m-tr` / `--m-br`: an `--m-run` × `--r-delta` box
 *  sitting just above / below the row at its pane-side end, filled with the PANE's colour, with an
 *  ELLIPTICAL quadrant bitten out of the corner FURTHEST from the junction — `radial-gradient(ellipse
 *  farthest-side at <far corner>, transparent 0 calc(100% - .5px), <pane> 100%)`. Read it as "inside
 *  the ellipse → transparent, so the build column shows through; outside → pane colour". It rounds
 *  the BUILD COLUMN's corner away from the row, never the row's own.
 *
 *  `farthest-side` is what makes the box's own dimensions the radii, so the 26 × 9 shape falls out of
 *  `width`/`height` rather than being restated. The `-0.5px` is the mock's antialias feather: without
 *  it the gradient's hard stop lands on a pixel boundary and the arc renders as a stair.
 *
 *  The two documented ways to make a CORRECT mouth invisible, so neither is re-diagnosed as bad
 *  geometry: an ancestor `overflow:hidden` clipping the overhang, and the pane painting over it
 *  because it is later in the DOM (needs z-index on the columns). Both live outside this file — see
 *  PRD/sparkle/blueprint-agent-sidebar.md.
 *
 *  `pointerEvents:none` so they never eat clicks; `aria-hidden` since they are pure chrome. The
 *  caller positions them by making its own box `position: relative`, and is responsible for any
 *  suppression rule of its own (the build row hides them behind its open hover card). */
export function ActiveFillets({ ends, paneSide }: { ends: PairSide[]; paneSide: PairSide }) {
  return (
    <>
      {ends.map((end) => {
        // The arc is bitten out of the corner FURTHEST from the junction, so an end that opens to
        // the RIGHT anchors its ellipse on the left and vice versa. Mirroring the anchor with the
        // end is the whole of the left pair's fix: keep it at `left` and the left pair's bank
        // sweeps the wrong way, hooking back into the row instead of away from it.
        const far = end === "right" ? "left" : "right";
        // `row-mouth-*` is the PANE end — the one every selected row has had since this shipped, and
        // the id the existing geometry tests read. `row-joint-*` is the concierge end, which exists
        // only while this pair holds the cable. Two names because they are two different claims: one
        // says "this row feeds its terminal", the other says "…and the concierge is plugged in".
        const id = end === paneSide ? "mouth" : "joint";
        return (
          <Fragment key={end}>
            <div
              aria-hidden
              data-testid={`row-${id}-top`}
              style={{
                position: "absolute",
                top: -ACTIVE_FILLET,
                [end]: 0,
                width: ACTIVE_FILLET_RUN,
                height: ACTIVE_FILLET,
                background: `radial-gradient(ellipse farthest-side at top ${far}, transparent 0 calc(100% - .5px), ${C.forest} 100%)`,
                pointerEvents: "none",
              }}
            />
            <div
              aria-hidden
              data-testid={`row-${id}-bottom`}
              style={{
                position: "absolute",
                bottom: -ACTIVE_FILLET,
                [end]: 0,
                width: ACTIVE_FILLET_RUN,
                height: ACTIVE_FILLET,
                background: `radial-gradient(ellipse farthest-side at bottom ${far}, transparent 0 calc(100% - .5px), ${C.forest} 100%)`,
                pointerEvents: "none",
              }}
            />
          </Fragment>
        );
      })}
    </>
  );
}
