// THE GOLD `EPIC` PILL — ONE treatment, drawn by every surface that says "this is an epic".
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
// ══ WHY THE FILL IS `epicPillFill` AND NOT `goldFill` ══════════════════════════════════════════
// Blueprint retired gold: the four `gold*` tokens carry BLUE now, so a `goldFill` pill would be
// blue-on-blue against the epic card and invisible — the one thing an identity badge may not be.
// `epicPillFill` / `onEpicPillFill` are the themed warm pair, and their contrast against BOTH epic
// surfaces is measured in `theme/epicCardContrast.test.ts`.
import { C } from "../../theme/colors";
import { TAG } from "../labelTreatment";

/**
 * The gold EPIC pill.
 *
 * A `<span>`, which is not incidental: `BeadCard` is phrasing content end to end because one of its
 * chromes mounts inside `<Markdown>`'s `<p>`, where a `<div>` is invalid nesting the parser resolves
 * by reparenting the node out of the sentence that referenced it.
 *
 * `testId` DEFAULTS to the board's existing `epic-pill` so the board's assertions keep addressing
 * the same node after the extraction; `BeadCard` passes its own chrome-prefixed id, the convention
 * every other control on that card follows.
 */
export function EpicPill({ testId = "epic-pill" }: { testId?: string } = {}) {
  return (
    <span
      data-testid={testId}
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
        background: C.epicPillFill,
        color: C.onEpicPillFill,
      }}
    >
      EPIC
    </span>
  );
}
