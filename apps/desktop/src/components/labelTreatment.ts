// ── THE LABEL AND THE CHIP: the two marks that make the shell read as an instrument ────────────
//
// `theme/scale.ts` ships the type steps, the radii and `LABEL`. This file is where `LABEL` becomes
// a thing components can actually spread, plus its sibling for counts and tags — the two treatments
// the approved spec repeats on every surface.
//
// WHY A SHARED CONSTANT RATHER THAN SPREADING `LABEL` AT EACH CALL SITE. The app arrived at this
// sweep with about twenty hand-typed near-copies of one idea: `fontSize: 12, textTransform:
// "uppercase", letterSpacing: 1, color: C.muted, fontWeight: semibold` in CreditsPanel, ToolsPane,
// SpendPane, CloudAuthPane, MobileDevicesPane, KeyboardShortcutsMenu, OnePasswordPane and
// StageColumnHeader — each one independently arrived at, each one slightly different (letterSpacing
// 0.4 / 0.5 / 0.6 / 0.8 / 1). None of them was wrong on its own; together they were twenty
// decisions where the design has one. A token in `scale.ts` does not prevent that — you still have
// to type `...LABEL, color: C.muted` correctly in twenty places. A named treatment does.
//
// The ink lives HERE and not in `scale.ts` on purpose: `scale.ts` is geometry and type, deliberately
// free of colour so it can be read as the spec's numbers. This is where the two meet.
import type { CSSProperties } from "react";
import { C } from "../theme/colors";
import { FONT_MONO, LABEL, RADIUS, TYPE, WEIGHT } from "../theme/scale";

/**
 * THE SECTION LABEL — the spec's `.grp` and `.rail b`: mono, uppercase, tracked 0.1em, at
 * `--t-micro`, in the faint ink.
 *
 * `scale.ts` calls this "the single most characteristic mark of the direction… what makes the shell
 * read as an instrument", and the reason the running app did not read that way is that it used the
 * UI face here. A tracked uppercase run in the *body* face is just small shouty body copy; the same
 * run in MONO reads as a machine label, because the even advance width is what your eye scores as
 * "this is a field name, not a sentence".
 *
 * NOTE ON THE INK. The spec has THREE ink steps — `--k-ink`, `--k-muted`, `--k-faint` — and the app
 * has ported two. `C.muted` is the faintest text token that exists here, so labels sit one step
 * brighter than the design draws them. That is a missing scale step, not a choice; see
 * `PRD/sparkle/blueprint-type-scale.md`.
 */
export const SECTION_LABEL: CSSProperties = { ...LABEL, color: C.muted };

/**
 * THE CHIP — a count, a tag, a stage tick. The spec's `.row .stg`: mono at `--t-micro` inside a
 * hairline box with `--r-sm`, which is a near-SQUARE corner and emphatically not a capsule.
 *
 * `borderRadius: 999` was everywhere. It is not a smaller sin than the wrong font: the spec's thesis
 * is *structure is drawn, not filled — panels are outlines, and the registers separate by line
 * weight*, and a pill is the one shape that cannot read as drawn. `PILL` still exists in `scale.ts`
 * for the shapes that genuinely need it (a status DOT, an avatar — a circle is not a radius
 * decision), which is exactly why reaching for it here is the wrong instinct rather than a typo.
 *
 * `tabular-nums` is load-bearing, not polish. These chips carry COUNTS that change while you watch
 * — agents per lane, unread approvals, tokens spent. In a proportional face `1` is narrower than
 * `8`, so the chip resizes and its neighbours shuffle every time a number ticks. Tabular figures
 * are all one width, so the chip is as wide as its digit count and nothing moves.
 */
export const CHIP: CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: TYPE.micro,
  fontWeight: WEIGHT.med,
  fontVariantNumeric: "tabular-nums",
  borderRadius: RADIUS.sm,
  padding: "1px 5px",
  whiteSpace: "nowrap",
};

/** `CHIP` as an outline in a given ink — the spec draws these, so the ink is both text and edge. */
export function chip(ink: string): CSSProperties {
  return { ...CHIP, color: ink, border: `1px solid ${ink}` };
}

/**
 * A FIELD-NAME tag — `DEFAULT`, `THIS MAC`, `UNPRICED`. `CHIP` plus the label's casing and tracking.
 *
 * WHY THIS IS A SECOND NAME RATHER THAN A PROPERTY ON `CHIP` (roborev 54739). The two are different
 * registers and the spec spells them differently: `.grp` and `.rail b` are `text-transform:
 * uppercase` with `--ls-label`, while `.row .stg` — the stage chip — sets neither, because it
 * carries a live PHRASE ("2 delivered today") rather than a field name, and uppercasing a sentence
 * is how a UI starts shouting.
 *
 * Folding uppercase into `CHIP` is what caused the finding: the first cut of this file dropped it,
 * and three tags that had been explicitly uppercase silently began rendering `default`, `This Mac`
 * and `unpriced` in source casing. The distinction is real, so it gets a name instead of a default
 * that half the call sites have to undo.
 */
export const TAG: CSSProperties = {
  ...CHIP,
  textTransform: "uppercase",
  letterSpacing: LABEL.letterSpacing,
};

/** `TAG` drawn in a given ink, the way `chip()` draws `CHIP`. */
export function tag(ink: string): CSSProperties {
  return { ...TAG, color: ink, border: `1px solid ${ink}` };
}

/**
 * A COUNT with no box — the tally at the right of a `.grp` header. Mono and tabular for the same
 * reason as `CHIP`; no border, because a section header is a divider and not a control.
 */
export const COUNT: CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: TYPE.micro,
  fontVariantNumeric: "tabular-nums",
  fontWeight: WEIGHT.med,
  color: C.muted,
  // BOTH OF THESE ARE UNDOING INHERITANCE, and they belong to the treatment rather than to each
  // call site. A count lives INSIDE a `SECTION_LABEL` container — that is what a `.grp` is, label
  // then rule then tally — so CSS hands it the label's 0.1em tracking and uppercase unless it says
  // otherwise, and a tracked number reads as a code rather than a quantity. `StageColumnHeader`
  // had worked this out and reset it locally; `StageSectionHeader` had not, so every Build-column
  // section header rendered its tally with the spacing this file calls wrong (roborev 54739).
  letterSpacing: 0,
  textTransform: "none",
};
