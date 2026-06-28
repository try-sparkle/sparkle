// A thin progress LINE (replaces the old Domino's-tracker chevrons). It runs across the bottom of
// an agent row and fills left→right as the work advances Uncommitted → … → Merged, fading from the
// cyan of the sparkle.ai "S" to the blue of its "i" — so both the length AND the color say how far
// along the work is. Collapsed it's just the line (no text). Expanded (row hovered) a status label
// sits to its right, inked the color the line has reached at that stage. Stage logic lives in
// engine/workflowStage.ts; this is purely presentational.
import { stageFraction, stageLineColor, stageMeta, LINE_FROM } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";

// Unfilled track: a faint muted rail so the remaining path reads as "to do" without looking broken.
const TRACK_BG = "rgba(138,160,196,0.22)";

// The sticky "shipped" check is the path's end color — brand success green — so it reads as the same
// "done" signal the full bar lands on, even when the bar itself has reset for a new cycle.
const SHIPPED_COLOR = stageMeta("merged").color;

export function WorkflowLine({
  stage,
  expanded = false,
  shipped = false,
  height = 2,
}: {
  stage: WorkflowStageId;
  /** Row is hovered/expanded → reveal the status label to the right of the line. */
  expanded?: boolean;
  /** This agent's work has reached main at least once — show a persistent ✓ even if the live
   *  stage has since reset to a new cycle. */
  shipped?: boolean;
  height?: number;
}) {
  const frac = stageFraction(stage);
  const end = stageLineColor(stage); // the color the fill has reached (its rightmost pixel)
  const meta = stageMeta(stage);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
      {shipped && (
        <span
          // "Landed", not "shipped to main": stage "main" means merged into the integration branch —
          // local main for a build agent, the orchestrator's branch for a worker — which only implies
          // real origin/main at the "merged" stage. Base-relative wording stays honest for both.
          aria-label="Landed at least once"
          title="Landed at least once"
          style={{
            flex: "0 0 auto",
            fontSize: 11,
            lineHeight: 1,
            fontWeight: 700,
            color: SHIPPED_COLOR,
          }}
        >
          ✓
        </span>
      )}
      <div
        role="img"
        aria-label={`Workflow stage: ${meta.label}`}
        title={meta.label}
        style={{
          position: "relative",
          flex: 1,
          minWidth: 0,
          height,
          borderRadius: 999,
          background: TRACK_BG,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${frac * 100}%`,
            borderRadius: 999,
            // The fill is the left slice of the logo gradient: cyan "S" → the blue it has reached.
            background: `linear-gradient(90deg, ${LINE_FROM}, ${end})`,
            transition: "width 240ms ease",
          }}
        />
      </div>
      {expanded && (
        <span
          style={{
            flex: "0 0 auto",
            fontSize: 11,
            lineHeight: 1.2,
            fontWeight: 600,
            color: end, // inked the line's rightmost color: cyan at Uncommitted, blue at Merged
            whiteSpace: "nowrap",
          }}
        >
          {meta.detail}
        </span>
      )}
    </div>
  );
}
