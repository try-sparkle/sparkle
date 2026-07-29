// A thin progress LINE (replaces the old Domino's-tracker chevrons). It runs across the bottom of
// an agent row and fills left→right as the work advances Uncommitted → … → Merged, fading from the
// cyan of the sparkle.ai "S" to the blue of its "i" — so both the length AND the color say how far
// along the work is. Collapsed it's just the line (no text). Expanded (row hovered) a status label
// sits to its right, inked the color the line has reached at that stage. Stage logic lives in
// engine/workflowStage.ts; this is purely presentational.
import { memo } from "react";
import { stageFraction, stageLineColor, stageMeta, LINE_FROM } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import { RADIUS } from "../theme/scale";

// Unfilled track: a faint muted rail so the remaining path reads as "to do" without looking broken.
const TRACK_BG = "rgba(138,160,196,0.22)";

// THE STICKY "LANDED" ✓ IS GONE, along with the `shipped` prop that drove it. It marked an agent
// whose work had reached its base at least once, and it was worth its space back when the sidebar
// was an unordered list where nothing else said so. The column is GROUPED BY STAGE now — a landed
// agent sits under a section header that says as much in words — so the glyph was a second, smaller
// rendering of a fact already stated above it, competing for room on a row stripped to a title.
// The card's own detail lines still carry "Landed" in words. Don't re-add it here.

// memo: all props are primitives, so the default shallow compare bails correctly. Defense-in-depth —
// the parent AgentRow is itself memoized (agentRowPropsEqual), so this only re-renders when the row
// does; the memo keeps an unrelated prop change on the row from repainting an unchanged progress line.
export const WorkflowLine = memo(function WorkflowLine({
  stage,
  expanded = false,
  height = 2,
}: {
  stage: WorkflowStageId;
  /** Row is hovered/expanded → reveal the status label to the right of the line. */
  expanded?: boolean;
  height?: number;
}) {
  const frac = stageFraction(stage);
  const end = stageLineColor(stage); // the color the fill has reached (its rightmost pixel)
  const meta = stageMeta(stage);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
      <div
        role="img"
        aria-label={`Workflow stage: ${meta.label}`}
        title={meta.label}
        style={{
          position: "relative",
          flex: 1,
          // A floor so the bar stays visible even when a long nowrap status label (expanded) shares
          // the flex row in a narrow container — without it the flex:1 bar collapses to ~0 and the
          // progress bar vanishes behind the label (the bug where expanded workers showed no bar).
          minWidth: 48,
          height,
          borderRadius: RADIUS.sm,
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
            borderRadius: RADIUS.sm,
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
            fontSize: 12,
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
});
