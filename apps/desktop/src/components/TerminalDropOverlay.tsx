// The drag-over affordance for the terminal drop target (hooks/useTerminalDrop): a dashed teal
// scrim over the agent's terminal, named with the agent whose terminal would receive the paths.
//
// This is the ONLY affordance available. A native OS drag fires no mouse events, so there is no
// :hover, no cursor change, nothing the browser gives us for free — without this scrim the user
// gets no signal at all that the terminal will take the file.
//
// Naming the agent is the other half of the job. Every visited pane stays mounted and stacked in
// the same box, so "the terminal" is more ambiguous on screen than it is in the code; the user
// needs to see that the drop lands on the pane they are LOOKING at.
//
// pointerEvents: none — the scrim must never intercept a click if a stray re-render leaves it up,
// and it has nothing to click anyway.
import { FiPaperclip } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";

export function TerminalDropOverlay({ agentName }: { agentName: string }) {
  return (
    <div
      data-testid="terminal-drop-overlay"
      role="presentation"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        border: `2px dashed ${C.teal}`,
        background: `color-mix(in srgb, ${C.teal} 10%, rgba(0,0,0,0.35))`,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 14px",
          borderRadius: 999,
          background: C.deepForest,
          border: `1px solid ${C.teal}`,
          color: C.cream,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: 13,
          fontWeight: FONT_WEIGHT.semibold,
          boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
        }}
      >
        <FiPaperclip size={14} aria-hidden />
        Drop into {agentName}&rsquo;s terminal
      </div>
    </div>
  );
}
