import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { ModalShell } from "./ModalShell";

/** Shown when the window's close (red traffic light) is requested. Lets the user keep the running
 *  agents alive in the background or stop them and close.
 *
 *  SCOPE (CM-U7): the window hosts EVERY project as a tab, and "stop the agents" reaches every
 *  project's RUNNING agents — not just the tab in front, and not the ones that aren't running.
 *  `runningProjectNames` is exactly the projects that have a live agent (front one first, if it
 *  has any), so the copy names what the button actually does instead of implying the visible
 *  project is the only casualty — or promising to stop agents that don't exist. */
export function ClosePrompt({
  projectName,
  runningProjectNames = [],
  onKeep,
  onKill,
  onCancel,
}: {
  projectName: string;
  runningProjectNames?: readonly string[];
  onKeep: () => void;
  onKill: () => void;
  onCancel: () => void;
}) {
  // One clause, never "{name}'s agents — and the agents in N other projects running", which splits
  // "agents … running" and scans as broken English.
  const others = Math.max(0, runningProjectNames.length - 1);
  const scope =
    runningProjectNames.length === 0
      ? "the running agents"
      : others === 0
        ? `the agents in ${runningProjectNames[0]}`
        : `the agents in ${runningProjectNames[0]} and ${others} other ${others === 1 ? "project" : "projects"}`;
  return (
    <ModalShell width={440} zIndex={200} onCancel={onCancel}>
      <div style={{ fontSize: 16, fontWeight: FONT_WEIGHT.semibold, marginBottom: 6 }}>
        Close {projectName} Project Window?
      </div>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 18 }}>
        Do you want to keep {scope} running in the background until you fully quit the Sparkle app,
        or stop them when you close this window?
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          onClick={onKeep}
          style={{
            background: C.teal,
            // White-on-blue: ON_BRAND_FILL stays light in both themes (C.cream flips to
            // navy in light mode, which would go low-contrast on the blue fill).
            color: ON_BRAND_FILL,
            border: "none",
            borderRadius: 8,
            padding: "11px 14px",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: FONT_WEIGHT.semibold,
            textAlign: "left",
          }}
        >
          Keep agents running in the background
        </button>
        <button
          onClick={onKill}
          style={{
            background: C.forest,
            color: C.cream,
            border: `1px solid ${C.sienna}`,
            borderRadius: 8,
            padding: "11px 14px",
            cursor: "pointer",
            fontSize: 14,
            textAlign: "left",
          }}
        >
          {/* Never "all the agents": the sweep only reaches agents that are actually running, and
              the app-owned Sparkle agent (whose id belongs to no project) is never touched. */}
          Stop {others > 0 ? "those agents" : "the agents"} as well
        </button>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button
          onClick={onCancel}
          style={{
            background: "transparent",
            color: C.muted,
            border: `1px solid ${C.muted}`,
            borderRadius: 8,
            padding: "8px 16px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </ModalShell>
  );
}
