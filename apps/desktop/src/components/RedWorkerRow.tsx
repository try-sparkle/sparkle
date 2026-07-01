// A worker that has gone RED (waiting / approval / errored) is promoted out of its orchestrator's
// inline roll-up into its OWN selectable row, indented beneath the orchestrator — so the human can
// actually reach it and open its REPL to unblock it. (Normally workers are NOT their own rows; they
// live as bare progress lines on the orchestrator's card. This row appears only while a worker is
// red, and collapses back into that roll-up once it's resolved.)
//
// Deliberately minimal, per the founder's steer: a status dot + the worker's name. No kind glyph
// ("no pickaxe"), no elapsed timer ("no number of minutes"), no hover slide-out, no progress bar.
// The indentation + the half-disc ("D") status dot — the same sub-agent marker used in the TopBar
// dot cluster — are what convey "this is a child of the orchestrator above". Clicking it selects +
// opens the worker (same onSelect the orchestrator rows use), which mounts its pane and REPL.
import { C, CHAT_USER_BUBBLE, statusInk, AGENT_STATUS } from "../theme/colors";
import type { AgentTabStatus } from "../types";
import { StatusDot } from "./StatusDot";
import { useState } from "react";

export function RedWorkerRow({
  name,
  status,
  active,
  onSelect,
}: {
  /** The worker's display name (auto-title or canonical name — resolved by the caller). */
  name: string;
  /** The worker's current (red) status — drives the dot color + the status label tooltip. */
  status: AgentTabStatus;
  /** True when this worker is the selected tab, so the row reads as open. */
  active: boolean;
  /** Select + open this worker (mounts its pane + REPL). */
  onSelect: () => void;
}) {
  const [hover, setHover] = useState(false);
  // The name takes the (light-mode-legible) status ink; red passes through unchanged.
  const color = statusInk(AGENT_STATUS[status].color);
  return (
    <div
      role="button"
      tabIndex={0}
      // "<worker name> — Needs you / Approve? / Errored": the status label comes from the taxonomy.
      aria-label={`${name} — ${AGENT_STATUS[status].label}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        // Indent one level (16px), matching a depth-1 AgentRow, so it nests under the orchestrator.
        marginLeft: 16,
        padding: "6px 10px",
        borderRadius: active ? "8px 0 0 8px" : 8,
        marginRight: active ? -8 : 0,
        marginBottom: 2,
        cursor: "pointer",
        // Active merges into the terminal (C.forest); hover uses the standard row bubble; else flat.
        background: active ? C.forest : hover ? CHAT_USER_BUBBLE : "transparent",
      }}
    >
      {/* Half-disc ("D") dot = the sub-agent marker (same as the TopBar cluster), reinforcing that
          this is a child of the orchestrator above it. */}
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
  );
}
