// The unified Think→Plan→Build progress line, drawn in PHRASING CONTENT.
//
// ══ WHY THIS EXISTS RATHER THAN `<WorkflowLine>` ════════════════════════════════════════════════
// `BeadCard` is rendered in two chromes, and one of them mounts inside `<Markdown>`'s `<p>`. A
// `<div>` there is invalid nesting that the HTML parser resolves by closing the paragraph and
// reparenting the node — moving the card away from the sentence that referenced it — which is why
// `BeadPill.test.tsx` asserts `p.querySelectorAll("div")` is EMPTY. `components/WorkflowLine.tsx` is
// three nested `<div>`s, so it cannot be the thing the concierge renders.
//
// ══ WHAT IS SHARED, AND WHAT IS NOT ═════════════════════════════════════════════════════════════
// Only the MARKUP is restated. Every value that decides what the line says — how far it fills
// (`stageFraction`), the colour its fill has reached (`stageLineColor`), the gradient's left end
// (`LINE_FROM`), and the label (`stageMeta().short`) — is imported from `engine/workflowStage`, the
// same module `WorkflowLine` reads. So the two cannot drift about the STAGE; they can only drift
// about geometry, and the geometry is six declarations sitting next to this comment.
//
// A `div | span` switch on `WorkflowLine` itself was the other option and was declined on ownership
// grounds: that file is rendered on every agent row in the app, and this change set is scoped to
// `BeadCard/*` + `Concierge/BeadPill.tsx`. If a later pass does add the switch, delete this file and
// pass `as="span"` — nothing else here depends on it.
import { LINE_FROM, stageFraction, stageLineColor, stageMeta } from "../../engine/workflowStage";
import type { WorkflowStageId } from "../../engine/workflowStage";
import { RADIUS, TYPE, WEIGHT } from "../../theme/scale";

/** The unfilled track — copied verbatim from `WorkflowLine`'s `TRACK_BG` so the remaining path reads
 *  as "to do" rather than as broken, in exactly the ink the board already uses. */
const TRACK_BG = "rgba(138,160,196,0.22)";

/**
 * The line plus its stage word, as one row.
 *
 * THE FOUNDER SCREENSHOTTED THIS ON THE CLOSED CARD AND ASKED WHY IT VANISHES WHEN THE CARD OPENS.
 * It is the answer to "how far along is this?", which is the first question a unit of work has to
 * answer, and it was present on the board's collapsed card and on neither of the two expanded
 * renderings. Every surface that draws a bead now draws this.
 */
export function StageLine({
  stage,
  height = 3,
  testId,
}: {
  stage: WorkflowStageId;
  height?: number;
  testId?: string;
}) {
  const frac = stageFraction(stage);
  // The colour the fill has REACHED at this stage — its rightmost pixel — which is also the ink the
  // label takes, so the word and the bar agree without either being told the other's value.
  const end = stageLineColor(stage);
  const meta = stageMeta(stage);
  return (
    <span
      data-testid={testId}
      data-stage={stage}
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}
    >
      <span
        role="img"
        aria-label={`Workflow stage: ${meta.label}`}
        title={meta.label}
        style={{
          display: "block",
          position: "relative",
          flex: 1,
          // The same floor `WorkflowLine` carries: without it the `flex: 1` bar collapses to ~0 next
          // to the nowrap label in a narrow container — and the concierge column IS the narrow
          // container this component was written for.
          minWidth: 48,
          height,
          borderRadius: RADIUS.sm,
          background: TRACK_BG,
          overflow: "hidden",
        }}
      >
        <span
          // NAMED, not reached positionally. The whole card is phrasing content, so EVERY ancestor
          // of this element is also a `<span>` — which makes a structural selector like
          // `span > span > span` match the TRACK above (its own parent chain is spans too) and
          // return an element with no width, comparing '' to '' forever. The width lives here and
          // nowhere else, so the fill says which one it is.
          data-testid={testId === undefined ? undefined : `${testId}-fill`}
          style={{
            display: "block",
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${frac * 100}%`,
            borderRadius: RADIUS.sm,
            background: `linear-gradient(90deg, ${LINE_FROM}, ${end})`,
            transition: "width 240ms ease",
          }}
        />
      </span>
      <span
        data-testid={testId === undefined ? undefined : `${testId}-label`}
        style={{
          flex: "0 0 auto",
          fontSize: TYPE.micro,
          fontWeight: WEIGHT.bold,
          color: end,
          whiteSpace: "nowrap",
        }}
      >
        {meta.short}
      </span>
    </span>
  );
}
