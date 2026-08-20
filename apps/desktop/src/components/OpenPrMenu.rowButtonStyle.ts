// The open-PR panel's PER-ROW ACTION CLUSTER — one button shape, in one place.
//
// A PR row ends in a ranked line of controls: "Open agent", the GitHub link, Dismiss, and then
// exactly one of the merge family (Merge / its override / the probe override). They are the same
// KIND of object — small transparent-boxed row actions sitting shoulder to shoulder — and until
// this module existed each of the six call sites hand-rolled its own copy of the identical
// literals (`borderRadius: 6`, `fontSize: 12`, `padding`, `flex`, `whiteSpace`, the `1px solid`
// border). Six hand-copied boxes is the same failure `Concierge/pillStyle.ts` was written to end,
// one surface over: they agree only for as long as nobody edits one of them.
//
// ── WHY THIS IS *NOT* `pillStyle` (roborev 65621) ────────────────────────────────────────────
// The first pass at this re-pointed only the GitHub button at the concierge header's `pillStyle`,
// on the reasoning that both are chiclets. That removed drift against a chip in a DIFFERENT
// surface while creating drift against the four controls the button actually touches: a 19px
// squared chiclet wedged between ~24px rounded siblings, with its click target dropping under the
// 24×24 minimum that `dismiss` beside it still met. `pillStyle`'s own docstring scopes it to "the
// concierge header's ONE chip shape", and this row is not that header.
//
// A control's peers are the controls BESIDE IT. The header chip and the row button are two
// systems, and each is internally consistent; this module is the row's half of that.
//
// ── THE TWO VARIANTS ─────────────────────────────────────────────────────────────────────────
// `secondary` (the default) is the row's quiet half — Open agent, the GitHub link, Dismiss.
// `action` is the merge family: a wider box and a heavier label, because it is the one control on
// the row that changes `main`, and the panel's whole grammar is that it must never be mistaken for
// its neighbours. That difference is DELIBERATE HIERARCHY, not drift — which is exactly why it
// belongs in the shared helper as a named variant rather than in six inline literals where nobody
// can tell the two apart.
import type { CSSProperties } from "react";
import { FONT_WEIGHT } from "../theme/colors";

export type RowButtonTone = {
  /** The box's stroke. */
  edge: string;
  /** The label/icon colour — what the user READS, which is rarely the stroke. */
  ink: string;
  /** A filled box. Only the ready Merge button takes one; everything else stays transparent. */
  fill?: string;
  /** `action` for the merge family, `secondary` (default) for the rest. See the note above. */
  emphasis?: "action" | "secondary";
  /**
   * `false` paints the resting cursor. This is about the POINTER only — a button that cannot act
   * must also carry the DOM `disabled` attribute at its call site; this helper never sets it,
   * because whether a control is disabled is behaviour and this module owns paint.
   */
  interactive?: boolean;
};

/** The one radius the whole cluster shares, exported so a test can name it without re-typing it. */
export const ROW_BUTTON_RADIUS = 6;

/**
 * The row action's geometry plus the paint the caller asked for.
 *
 * Callers pass STATE through the tone (armed goes sienna, disabled goes muted, ready fills teal)
 * and override nothing else. The box — radius, font size, padding, flex, whitespace — is the part
 * that has to match across the cluster, so it is not a parameter.
 */
export const rowButtonStyle = (tone: RowButtonTone): CSSProperties => {
  const action = tone.emphasis === "action";
  return {
    flex: "0 0 auto",
    background: tone.fill ?? "transparent",
    color: tone.ink,
    border: `1px solid ${tone.edge}`,
    borderRadius: ROW_BUTTON_RADIUS,
    // The action variant is WIDER, not taller: the row is a single flex line whose hard constraint
    // is that the primary action never truncates, so emphasis is bought horizontally.
    padding: action ? "3px 10px" : "3px 8px",
    fontSize: 12,
    // Only the merge family declares a weight. The quiet half inherits the row's, so a future
    // change to the row's type doesn't have to be re-applied here to keep them agreeing.
    ...(action ? { fontWeight: FONT_WEIGHT.semibold } : {}),
    cursor: tone.interactive === false ? "default" : "pointer",
    whiteSpace: "nowrap",
  };
};
