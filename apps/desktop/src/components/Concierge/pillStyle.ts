// rev4's `.pill` — the concierge header's ONE chip shape, in one place.
//
// It lived as a private helper in `ConciergeColumn.tsx` while it had a single caller (the needs-you
// filter). It has two now: `OpenPrMenu`'s compact PR badge sits in the same header, one slot over,
// and the founder asked for it as "a little chiclet" — i.e. the same kind of object as its
// neighbour, not a second chip shape with its own geometry. Two hand-copied literals in two files
// is how the two drift, and a header carrying two nearly-identical-but-not chips is precisely the
// "mishmash of shades and colours" the Blueprint pass exists to end.
//
// A squared 19px chip, NOT a capsule: the direction draws boxes.
import { C, FONT_WEIGHT } from "../../theme/colors";

/**
 * The chip's geometry and its resting (unfilled) paint, for a given `edge` colour.
 *
 * Callers override `color`/`background` to say STATE — the needs-you pill fills itself when the
 * filter is engaged, the PR badge takes the edge colour on its ink when something is green. What
 * they must not override is the box: that is the part that has to match.
 */
export const pillStyle = (edge: string) =>
  ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    flex: "0 0 auto",
    height: 19,
    padding: "0 6px",
    borderRadius: 3,
    border: `1px solid ${edge}`,
    background: "transparent",
    font: "inherit",
    fontSize: 10,
    fontWeight: FONT_WEIGHT.bold,
    lineHeight: 1,
    color: C.conciergeMuted,
    cursor: "pointer",
  }) as const;
