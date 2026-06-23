import type { CSSProperties } from "react";
import { C, FONT, FONT_WEIGHT } from "@sparkle/ui";
import type { Session } from "../types";

interface Props {
  session: Session;
  expertVisible: boolean; // floor >= 4 (§15)
  expertOpen: boolean;
  onPause: () => void;
  onDetails: () => void;
  onToggleExpert: () => void;
}

// §10.1 — one card per agent_session (370 × 160).
export function AgentCard({
  session,
  expertVisible,
  expertOpen,
  onPause,
  onDetails,
  onToggleExpert,
}: Props) {
  const { status } = session;
  const isComplete = status === "complete";
  const pauseLabel =
    status === "paused" ? "Resume" : status === "error" ? "Retry" : "Pause";

  const actionText =
    status === "waiting"
      ? `Waiting for: ${session.waitingFor ?? ""}`
      : status === "error"
        ? (session.errorMessage ?? session.currentAction)
        : `"${session.currentAction}"`;

  return (
    <div style={card}>
      <div style={row}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isComplete ? (
            <span style={{ color: C.teal, fontSize: 14 }}>✓</span>
          ) : (
            <span
              style={{
                ...dot,
                background:
                  status === "pending" ? C.status.paused : C.status[status],
              }}
            />
          )}
          <span
            style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold, fontSize: 15 }}
          >
            {session.name}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!isComplete && (
            <button onClick={onPause} style={btn}>
              {pauseLabel}
            </button>
          )}
          <button onClick={onDetails} style={btn} aria-label="Details">
            ⋯
          </button>
        </div>
      </div>

      <div style={{ color: status === "error" ? C.sienna : C.cream, fontSize: 14 }}>
        {actionText}
      </div>

      {isComplete ? (
        <div style={{ color: C.teal, fontSize: 13 }}>Complete</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={track}>
            <div
              style={{
                width: `${session.progressPercent}%`,
                height: "100%",
                borderRadius: 3,
                background: C.amber,
                transition: status === "active" ? "width 0.4s ease" : "none",
              }}
            />
          </div>
          <div style={{ color: C.muted, fontSize: 12 }}>
            {session.tasksDone}/{session.tasksTotal} tasks
            {session.etaMinutes != null ? `  ~${session.etaMinutes} min` : ""}
          </div>
        </div>
      )}

      <div style={{ marginTop: "auto", ...row }}>
        {session.branch ? (
          <span style={{ fontFamily: FONT.mono, fontSize: 12, color: C.muted }}>
            {session.branch}
          </span>
        ) : (
          <span />
        )}
        {expertVisible && (
          <button onClick={onToggleExpert} style={linkBtn}>
            {expertOpen ? "Hide terminal" : "Show terminal"}
          </button>
        )}
      </div>
    </div>
  );
}

const card: CSSProperties = {
  width: 370,
  minHeight: 160,
  background: C.deepForest,
  borderRadius: 12,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const dot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  display: "inline-block",
};
const track: CSSProperties = { height: 6, borderRadius: 3, background: "#0d140f" };
const btn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.muted}`,
  color: C.cream,
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: FONT.ui,
};
const linkBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: C.muted,
  fontSize: 12,
  cursor: "pointer",
  textDecoration: "underline",
  fontFamily: FONT.ui,
};
