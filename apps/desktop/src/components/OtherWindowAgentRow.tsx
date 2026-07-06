// A red agent living in ANOTHER open project window, surfaced at the top of this window's sidebar.
// A thin presentational variant of AgentRow: a leading red StatusDot + the agent name, with a
// PROJECT PILL stacked just above the leading glyph slot (left edges aligned), which makes these
// rows a touch taller than normal agent rows. Clicking routes to the owning window (see AgentSidebar).
import { useState } from "react";
import { StatusDot } from "./StatusDot";
import { C, ROW_ACTIVE_BUBBLE, ON_BRAND_FILL, statusInk, AGENT_STATUS, FONT, FONT_WEIGHT } from "../theme/colors";
import type { OtherWindowAgent } from "../services/windowStatus";

// Pill shades — VISUALLY TUNABLE. The earlier "two close blues" pairing was unreadable in both
// themes, so this uses the app's sanctioned high-contrast combo: the vivid brand blue as the fill
// and the on-brand cream as the text (ON_BRAND_FILL is purpose-built for text sitting on a brand
// fill, and both are theme-constant so contrast holds in light AND dark).
const PILL_BG = C.teal; // brand blue #2f6bff (constant both themes)
const PILL_TEXT = ON_BRAND_FILL; // cream #eaf1ff (constant) — high contrast on the blue fill
const PILL_RADIUS = 4; // a squared-off tag, not a full pill (founder: "less rounded")

// Left padding of the row; the pill's left edge and the StatusDot's left edge both anchor here so
// the pill sits flush above the leading glyph slot.
const ROW_PAD_X = 10;

export function OtherWindowAgentRow({
  agent,
  onClick,
  extraCount = 0,
}: {
  agent: OtherWindowAgent;
  onClick: () => void;
  // Number of OTHER red agents in this same window (total − 1). > 0 renders a "+{extraCount}" badge
  // to the right of the project pill; 0 renders just the pill (a single-red-agent window).
  extraCount?: number;
}) {
  const [hover, setHover] = useState(false);
  const extra = extraCount > 0 ? extraCount : 0;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        `${agent.projectName} — ${agent.agentName} (needs attention in another window)` +
        (extra > 0 ? ` · +${extra} more in this window` : "")
      }
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
      {/* Project pill + optional "+N" badge — left edge aligned to the leading glyph slot below (so
          the pill sits just above the StatusDot). alignSelf:flex-start keeps the row hugging its
          content rather than stretching; the badge sits immediately to the pill's right. */}
      <div
        style={{
          alignSelf: "flex-start",
          display: "flex",
          alignItems: "center",
          gap: 5,
          maxWidth: "100%",
          minWidth: 0,
        }}
      >
        <span
          style={{
            // minWidth:0 is required for the ellipsis to engage now that the pill is a flex child
            // (flex items won't shrink below min-content without it) sitting beside the +N badge.
            minWidth: 0,
            maxWidth: "100%",
            boxSizing: "border-box",
            padding: "1px 7px",
            borderRadius: PILL_RADIUS,
            background: PILL_BG,
            color: PILL_TEXT,
            fontFamily: FONT.ui,
            fontSize: 10,
            fontWeight: FONT_WEIGHT.bold,
            lineHeight: 1.5,
            letterSpacing: 0.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {agent.projectName}
        </span>
        {extra > 0 && (
          <span
            // Subordinate to the pill: small, muted secondary ink, no fill. Counts the OTHER red
            // agents collapsed into this one window row.
            style={{
              flexShrink: 0,
              color: C.muted,
              fontFamily: FONT.ui,
              fontSize: 10,
              fontWeight: FONT_WEIGHT.semibold,
              letterSpacing: 0.2,
              lineHeight: 1.5,
              whiteSpace: "nowrap",
            }}
          >
            +{extra}
          </span>
        )}
      </div>

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
            // Match the red status dot — the name reads as red too (statusInk passes red through
            // unchanged in both themes; it only re-inks the gray/green tiers for legibility).
            color: statusInk(AGENT_STATUS[agent.status].color),
            fontFamily: FONT.ui,
            fontSize: 13,
            fontWeight: FONT_WEIGHT.semibold,
          }}
        >
          {agent.agentName}
        </span>
      </div>
    </div>
  );
}
