// A red agent living in ANOTHER open project window, surfaced at the top of this window's sidebar.
// A thin presentational variant of AgentRow: a leading red StatusDot + the agent name, with a
// PROJECT PILL stacked just above the leading glyph slot (left edges aligned), which makes these
// rows a touch taller than normal agent rows. Clicking routes to the owning window (see AgentSidebar).
import { useState } from "react";
import { StatusDot } from "./StatusDot";
import { C, CHAT_USER_BUBBLE, ROW_ACTIVE_BUBBLE, FONT, FONT_WEIGHT } from "../theme/colors";
import type { OtherWindowAgent } from "../services/windowStatus";

// Pill shades — VISUALLY TUNABLE. Founder's intent: the pill background is a blue DARKER than the
// active-row shading (the "darker blue behind the shading"), and the pill TEXT is the active-row
// shading color itself. Kept as named constants so they're easy to adjust after a look in the app.
const PILL_BG = CHAT_USER_BUBBLE; // darker blue (#1d3a7a dark / light-mode mirror)
const PILL_TEXT = ROW_ACTIVE_BUBBLE; // active-row shading (#2c57b0 dark / #bccdf2 light)

// Left padding of the row; the pill's left edge and the StatusDot's left edge both anchor here so
// the pill sits flush above the leading glyph slot.
const ROW_PAD_X = 10;

export function OtherWindowAgentRow({
  agent,
  onClick,
}: {
  agent: OtherWindowAgent;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${agent.projectName} — ${agent.agentName} (needs attention in another window)`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: `6px ${ROW_PAD_X}px`,
        borderRadius: 8,
        cursor: "pointer",
        marginBottom: 2,
        // Hover uses the starker active-row shade, NOT CHAT_USER_BUBBLE — the pill background is
        // CHAT_USER_BUBBLE, so a matching hover would make the pill blend into the row and collapse.
        background: hover ? ROW_ACTIVE_BUBBLE : "transparent",
      }}
    >
      {/* Project pill — left edge aligned to the leading glyph slot below (so it sits just above the
          StatusDot). alignSelf:flex-start keeps it hugging its text rather than stretching. */}
      <span
        style={{
          alignSelf: "flex-start",
          maxWidth: "100%",
          boxSizing: "border-box",
          padding: "1px 7px",
          borderRadius: 999,
          background: PILL_BG,
          color: PILL_TEXT,
          fontFamily: FONT.ui,
          fontSize: 10,
          fontWeight: FONT_WEIGHT.semibold,
          lineHeight: 1.5,
          letterSpacing: 0.2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {agent.projectName}
      </span>

      {/* Leading red status dot + agent name. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <StatusDot status={agent.status} />
        <span
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: C.cream,
            fontFamily: FONT.ui,
            fontSize: 13,
            fontWeight: FONT_WEIGHT.medium,
          }}
        >
          {agent.agentName}
        </span>
      </div>
    </div>
  );
}
