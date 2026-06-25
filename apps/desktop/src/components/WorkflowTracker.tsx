// The Domino's-Pizza-Tracker chevron bar: five interlocking arrows showing how far a unit of work
// has progressed (Uncommitted → Committed → Pull Request → On Main → Merged). Reached stages light
// up in their own color; stages still ahead are grayed out. Purely presentational — the stage is
// decided in engine/workflowStage.ts and passed in. Rendered under each agent in the sidebar.
import { WORKFLOW_STAGES, stageIndex, stageMeta } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import { C } from "../theme/colors";

// Each chevron is a rectangle clipped into a right-pointing arrow. Non-first chevrons also carry a
// concave notch on their LEFT so the previous arrow nests into them (the interlocking look). Depths
// are percentages so the shape scales with the (variable) sidebar width.
const ARROW = "polygon(0 0, 82% 0, 100% 50%, 82% 100%, 0 100%, 18% 50%)";
const ARROW_FIRST = "polygon(0 0, 82% 0, 100% 50%, 82% 100%, 0 100%)"; // flat left edge

export function WorkflowTracker({
  stage,
  height = 13,
  showLabel = true,
  labelPrefix,
}: {
  stage: WorkflowStageId;
  height?: number;
  /** Show the current stage's name under the chevrons (the tracker's text readout). */
  showLabel?: boolean;
  /** Optional text before the stage name in the readout, e.g. "Overall: ". */
  labelPrefix?: string;
}) {
  const current = stageIndex(stage);
  const meta = stageMeta(stage);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, width: "100%" }}>
      <div
        role="img"
        aria-label={`Workflow stage: ${meta.label}`}
        style={{ display: "flex", alignItems: "stretch", width: "100%" }}
      >
        {WORKFLOW_STAGES.map((s, i) => {
          const reached = i <= current;
          const isCurrent = i === current;
          return (
            <span
              key={s.id}
              title={`${s.label}${isCurrent ? " — current" : reached ? " ✓" : ""}`}
              className={isCurrent ? "sparkle-pulse" : undefined}
              style={{
                flex: 1,
                height,
                minWidth: 0,
                // Reached → the stage's own lit color. Not yet reached → a dim grayed slab so the
                // remaining path reads as "to do" without ever looking broken (no red).
                background: reached ? s.color : C.deepForest,
                opacity: reached ? 1 : 0.45,
                border: `1px solid ${reached ? s.color : C.muted}`,
                boxSizing: "border-box",
                clipPath: i === 0 ? ARROW_FIRST : ARROW,
                // Overlap so each arrow tucks into the next chevron's notch.
                marginLeft: i === 0 ? 0 : -5,
              }}
            />
          );
        })}
      </div>
      {showLabel && (
        <span
          style={{
            fontSize: 9.5,
            lineHeight: 1.1,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: meta.color,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {labelPrefix}
          {meta.label}
        </span>
      )}
    </div>
  );
}
