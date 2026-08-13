// The bead's priority as a READ-ONLY chip for a card face — the thing the founder asked to see on
// every card in the columns, not only after opening one.
//
// ══ THIS IS `PriorityPill` WITH THE CONTROL REMOVED, ON PURPOSE ═════════════════════════════════
// `PriorityPill` is the editable version: a button that opens a portaled pick-one-of-N menu and
// writes the choice back. On a board of hundreds of cards that is the wrong thing to mount per card
// — it carries Escape/scroll/resize listeners and a body portal, all to change a value the card
// face only needs to SHOW. So this shares the pill's VISUAL LANGUAGE (the `tag()` treatment, the
// urgent dot, `priorityShort`) and nothing of its machinery: it is a plain `<span>`, no state, no
// listeners, no write. Editing still lives in the detail overlay's `PriorityPill`.
//
// The colour is BANDED, not per-level, and that is deliberate — see `isUrgentPriority`'s docstring.
// P0/P1 ("do it now / next") wear the danger ink; the rest take the neutral ink every other
// metadatum on the card already uses, so a board where everything is red never happens.
import { C } from "../../theme/colors";
import { tag } from "../labelTreatment";
import { isUrgentPriority, priorityShort } from "./beadPriority";

export function BeadPriorityChip({
  priority,
  testId = "bead-priority-chip",
}: {
  /** The bead's priority (`undefined` renders as `P?` — an unset priority is the one most worth
   *  seeing, not hiding). */
  priority: number | undefined;
  testId?: string;
}) {
  const urgent = isUrgentPriority(priority);
  const ink = urgent ? C.dangerInk : C.muted;
  return (
    <span
      data-testid={testId}
      data-priority={priority === undefined ? "" : String(priority)}
      // No title/click: it is a readout. The editable pill in the detail overlay carries the
      // "click to change" affordance, so a second one here would promise an action this cannot do.
      style={{
        ...tag(ink),
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flex: "0 0 auto",
        background: "transparent",
        padding: "1px 6px",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 6,
          height: 6,
          // A dot is a circle — exempt from the radius ratchet, same as every other status dot.
          borderRadius: "50%",
          // `sienna` as FILL only (it can't be text ink at 3.83:1); the label above is `dangerInk`.
          background: urgent ? C.sienna : C.muted,
        }}
      />
      {priorityShort(priority)}
    </span>
  );
}
