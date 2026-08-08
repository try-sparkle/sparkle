import { useState } from "react";
import { FONT_WEIGHT, statusInk } from "../theme/colors";
import { stageFraction } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import type { BuildSectionId } from "../engine/buildSections";
import type { BranchStatus } from "../services/branchStatus";
import type { AgentTabStatus } from "../types";

/**
 * The per-worker view-model an ORCHESTRATOR row renders its workers from, and the two leaves that
 * read it. Moved verbatim out of AgentSidebar.tsx; no logic change.
 *
 * The type is the contract across the seam this decomposition creates: the root component computes
 * these (where stageOf / status / branchStatus are in scope) and threads them down, so both sides
 * need to name the same shape without importing each other.
 */

// The minimal per-worker view-model an orchestrator row needs to render its workers itself: one
// bare indented progress line per worker collapsed, and a stacked Location/Status/Progress block
// per worker in the hover overlay. Computed in AgentSidebar (where stageOf/status/branchStatus are
// in scope) and threaded down so workers share the orchestrator's single hover target. `onLand`
// fires the same merge as a standalone worker row's green pill did. `[]` for non-orchestrator rows.
export type WorkerDetail = {
  id: string;
  name: string;
  autoTitle: string | null;
  description: string;
  stage: WorkflowStageId | null;
  status: AgentTabStatus;
  /** The row's status colour AS PAINTED. It crosses this boundary as a bare `string`, so the row
   *  re-asserts the text tier with `statusInk` at the point of paint rather than trusting the
   *  producer — this row's name is an underlined-on-hover LINK, and it previously took the raw
   *  brand green at 2.22:1. `statusInk` is idempotent on an already-themed value. */
  statusColor: string;
  branchStatus?: BranchStatus;
  shipped: boolean;
  worktreePath: string | null;
  baseBranch: string | null;
  /** True when this worker is the selected tab, so its inline line reads as open. */
  active: boolean;
  onLand: () => void;
  /** Select + open this worker (its inline named line and hover-card name are clickable). */
  onOpen: () => void;
  /** The worker's own ladder rung, so its card line's copy matches its own worktree. */
  section?: BuildSectionId;
};

// A worker's name inside the orchestrator's hover card. Clicking it opens the worker in the main
// pane. stopPropagation keeps the click off the card's own onClick (which selects the orchestrator).
export function WorkerNameButton({ w }: { w: WorkerDetail }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${w.autoTitle || w.name}`}
      title="Open this sub-agent"
      onClick={(e) => {
        e.stopPropagation();
        w.onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          w.onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minWidth: 0,
        lineHeight: 1.3,
        cursor: "pointer",
        textDecoration: hover ? "underline" : "none",
      }}
    >
      <span style={{ color: statusInk(w.statusColor), fontSize: 12, fontWeight: FONT_WEIGHT.semibold }}>
        {w.autoTitle || w.name}
      </span>
      {w.description && (
        <span style={{ color: statusInk(w.statusColor), fontSize: 12, fontWeight: FONT_WEIGHT.regular }}>
          {`:  ${w.description}`}
        </span>
      )}
    </div>
  );
}

// The worker whose title/progress best represents the whole build for the collapsed head row: the
// LEAST-ADVANCED worker — the same one the head's rollup progress bar reflects — so the promoted head
// title and that bar describe the same piece of work. A null stage sorts as "not started" (fraction
// 0). Ties break to the FIRST worker in insertion order: the strict `<` below only replaces `rep` on
// a STRICTLY smaller fraction, so equal-fraction workers keep the earliest one. Returns null for an
// empty list. Used to auto-promote an orchestrator's generic "Build N" name to describe the real work.
export function representativeWorker(workers: WorkerDetail[]): WorkerDetail | null {
  let rep: WorkerDetail | null = null;
  let repFrac = Infinity;
  for (const w of workers) {
    const f = w.stage ? stageFraction(w.stage) : 0;
    if (f < repFrac) {
      rep = w;
      repFrac = f;
    }
  }
  return rep;
}
