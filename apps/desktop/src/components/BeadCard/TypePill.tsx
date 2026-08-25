// THE TYPE PILL — ONE treatment, drawn by every surface that says what KIND of thing a bead is.
//
// ══ WHY IT MOVED OUT OF `BoardView` ════════════════════════════════════════════════════════════
// It was a module-private `function EpicPill()` in `BoardView.tsx`, reachable only by the board's
// COLLAPSED card. The founder then asked for it on the OPEN card too — [10:08] *"the yellow or gold
// epic pill should still be here like it is when the card is closed. So it should look the same
// when it's open as it does when it's closed"* — and a second surface needing it leaves exactly two
// options: share this one, or draw a second gold pill by eye.
//
// Two treatments of one indicator is the drift `BeadCard` itself exists to end (a bead was once
// drawn by three components that shared no code, and each showed a different subset of the same
// fields). `BeadPriorityChip` is shared for the same reason and is the local precedent. So this is
// the pill, and `BoardView` imports it rather than owning it.
//
// ══ WHY IT IS THE *TYPE* PILL AND NOT THE EPIC PILL ════════════════════════════════════════════
// It shipped as `EpicPill`, and the founder's next screenshot was of an OPEN card for a bead of type
// `bug`: its type rendered as PLAIN LOWERCASE TEXT mid-way along the metadata row, while the pill
// slot in the top-left sat empty. His ruling (bead `sparkle-huw924.8`) is that the pill is the
// general treatment for the type field — *"an epic reads EPIC, a bug reads BUG, a task reads TASK"*
// — so epic-ness is a COLOUR decision inside this component and not a gate around it. There is now
// exactly one place in the app where a bead's type is drawn, and the metadata row no longer prints
// it a second time in lowercase prose.
//
// ══ WHY THE EPIC FILL IS `epicPillFill` AND NOT `goldFill` ═════════════════════════════════════
// Blueprint retired gold: the four `gold*` tokens carry BLUE now, so a `goldFill` pill would be
// blue-on-blue against the epic card and invisible — the one thing an identity badge may not be.
// `epicPillFill` / `onEpicPillFill` are the themed warm pair, and their contrast against BOTH epic
// surfaces is measured in `theme/epicCardContrast.test.ts`. `typePillFill` / `onTypePillFill` are
// the cool slate pair every OTHER type takes, measured in the same file against all three of
// `BeadCard`'s chrome surfaces. Warm-versus-cool is what keeps the epic's badge the loud one on a
// board where most cards are tasks.
import { C } from "../../theme/colors";
import { TAG } from "../labelTreatment";
import { isTypedEpic } from "../../services/beads";

/**
 * The bead's TYPE, as a filled pill — `EPIC`, `BUG`, `TASK`, or whatever else bd carries.
 *
 * Renders NOTHING when the bead has no type: bd's type field is optional, and an empty pill in the
 * card's top-left corner would be a worse answer than the corner staying empty.
 *
 * A `<span>`, which is not incidental: `BeadCard` is phrasing content end to end because one of its
 * chromes mounts inside `<Markdown>`'s `<p>`, where a `<div>` is invalid nesting the parser resolves
 * by reparenting the node out of the sentence that referenced it.
 *
 * `testId` DEFAULTS to `type-pill` for the board's collapsed card; `BeadCard` passes its own
 * chrome-prefixed id, the convention every other control on that card follows. The node also
 * carries `data-bead-type`, so a caller that needs to ask "is THIS an epic card" reads the value
 * rather than inferring it from the presence of a pill that now appears on every card.
 *
 * TAKES THE TYPE, NOT THE BEAD, and that is load-bearing for the board. `BoardView`'s collapsed
 * card labels a STRUCTURAL epic — a bead with children, whose own type field may say `task` — and
 * it has always drawn EPIC on those. Passing the bead would silently relabel them.
 */
export function TypePill({
  type,
  testId = "type-pill",
}: {
  type: string | undefined;
  testId?: string;
}) {
  const label = (type ?? "").trim();
  if (label === "") return null;
  // `isTypedEpic`, never a hand-written comparison against the type field: "epic" has had three
  // competing meanings in this codebase and `services/beads.ts` is the one place allowed to say
  // which is meant. `scripts/lib/epic-membership-guard.sh` fails CI on a second definition
  // ANYWHERE, and it greps line-wise without skipping comments — which is why the forbidden
  // comparison is described here rather than quoted.
  const epic = isTypedEpic({ type: label });
  return (
    <span
      data-testid={testId}
      data-bead-type={label.toLowerCase()}
      // `TAG`, not a hand-rolled box. It already carries every value this needs — uppercase, the
      // spec's 0.1em tracking, mono at TYPE.micro, RADIUS.sm — and two tree-wide ratchets
      // (theme/scale.test.ts on off-scale fontSize, labelTreatment.test.ts on hand-typed
      // letterSpacing) exist precisely to stop a new badge re-deriving them by eye. Both caught
      // this pill's first draft.
      //
      // FILLED rather than outlined, so `tag(ink)` is the wrong helper: this is a solid identity
      // badge, and its fill/ink pair is themed and measured in theme/epicCardContrast.test.ts.
      style={{
        ...TAG,
        alignSelf: "flex-start",
        background: epic ? C.epicPillFill : C.typePillFill,
        color: epic ? C.onEpicPillFill : C.onTypePillFill,
      }}
    >
      {label.toUpperCase()}
    </span>
  );
}
