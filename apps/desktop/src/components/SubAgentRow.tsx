// A sub-agent (worker) SURFACED as its own indented row beneath its orchestrator — so the human can
// reach it and open its REPL. A worker surfaces for one of two reasons (see AgentSidebar):
//   • ATTENTION (auto): its live status went red (waiting / approval / errored). No ✕; the row
//     disappears on its own once the worker is no longer red.
//   • PINNED (manual): the human clicked its name in the orchestrator's hover card. Shows a ✕; the
//     row persists regardless of status until the human clicks ✕ (or the worker is spun down).
//
// Layout mirrors the orchestrator row, one level indented: the worker's NAME (in its status ink)
// sits ABOVE its OWN blue bar (the same cyan→blue WorkflowLine the orchestrator shows). No kind
// glyph ("no pickaxe" — the parent already carries it) and no elapsed timer; the half-disc ("D")
// status dot — the same sub-agent marker used in the TopBar dot cluster — plus the indent convey
// "this is a child of the orchestrator above". Clicking the row (not the ✕) selects + opens the
// worker (same onSelect the orchestrator rows use), mounting its pane + REPL.
import { C, CHAT_USER_BUBBLE, statusInk, AGENT_STATUS } from "../theme/colors";
import type { AgentTabStatus } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";
import { StatusDot } from "./StatusDot";
import { WorkflowLine } from "./WorkflowLine";
import { useState } from "react";

export function SubAgentRow({
  name,
  status,
  stage,
  shipped = false,
  active,
  pinned,
  onSelect,
  onUnpin,
  onHoverEnter,
  onHoverLeave,
}: {
  /** The worker's display name (auto-title or canonical name — resolved by the caller). */
  name: string;
  /** The worker's current status — drives the dot color, the name ink, and the status-label tooltip. */
  status: AgentTabStatus;
  /** The worker's workflow stage → its own blue bar. `null` (e.g. no worktree yet) renders no bar. */
  stage: WorkflowStageId | null;
  /** The worker's work has reached main at least once → sticky ✓ on its bar. */
  shipped?: boolean;
  /** True when this worker is the selected tab, so the row reads as open. */
  active: boolean;
  /** Manually pinned (vs auto-surfaced on attention) → show the ✕ close control. */
  pinned: boolean;
  /** Select + open this worker (mounts its pane + REPL). */
  onSelect: () => void;
  /** Un-pin this worker (✕). Required when `pinned`; the ✕ does NOT also select the row. */
  onUnpin?: () => void;
  /** Hover enter/leave hooks so this row shares its orchestrator's hover card (see AgentSidebar):
   *  hovering a surfaced sub-row opens/keeps the parent's card, and moving head↔card↔sub-row never
   *  crosses a dismiss boundary (no flicker). Separate from the local row-bubble hover below. */
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}) {
  const [hover, setHover] = useState(false);
  // The name takes the (light-mode-legible) status ink; red passes through unchanged.
  const color = statusInk(AGENT_STATUS[status].color);
  return (
    <div
      // Indent one level (16px), matching a depth-1 AgentRow, so it nests under the orchestrator.
      // A column: the name row (dot + name + ✕) above the worker's own progress bar.
      onMouseEnter={() => {
        setHover(true);
        onHoverEnter?.();
      }}
      onMouseLeave={() => {
        setHover(false);
        onHoverLeave?.();
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        marginLeft: 16,
        padding: "6px 10px",
        borderRadius: active ? "8px 0 0 8px" : 8,
        marginRight: active ? -8 : 0,
        marginBottom: 2,
        // Active merges into the terminal (C.forest); hover uses the standard row bubble; else flat.
        background: active ? C.forest : hover ? CHAT_USER_BUBBLE : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          role="button"
          tabIndex={0}
          // "<worker name> — Needs you / Approve? / Errored / …": status label from the taxonomy.
          aria-label={`${name} — ${AGENT_STATUS[status].label}`}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
          }}
        >
          {/* Half-disc ("D") dot = the sub-agent marker (same as the TopBar cluster). */}
          <StatusDot status={status} shape="half" />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              color,
              fontSize: 13,
              fontWeight: active ? 700 : 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
        </div>
        {pinned && onUnpin && (
          <button
            type="button"
            aria-label={`Unpin ${name}`}
            title="Unpin"
            onClick={(e) => {
              // The ✕ un-pins WITHOUT selecting the row (stop the click reaching onSelect above).
              e.stopPropagation();
              onUnpin();
            }}
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              padding: 0,
              border: "none",
              background: "transparent",
              color: active ? C.cream : C.muted,
              fontSize: 13,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        )}
      </div>
      {/* The worker's OWN blue bar, one level indented under its name (aligned past the dot). */}
      {stage && (
        <div style={{ marginLeft: 17 }}>
          <WorkflowLine stage={stage} shipped={shipped} />
        </div>
      )}
    </div>
  );
}
