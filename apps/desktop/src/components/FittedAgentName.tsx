// The agent name (its auto-generated title) in the collapsed sidebar row. There's a single title
// length now — it's shown bold and truncated with a CSS ellipsis when the column is too narrow
// ("Remove Sparkle Fad…"). The full title + the description are revealed by the row's hover
// slide-out (see AgentSidebar), so this component carries no tooltip of its own. Legacy/manual
// agents with no title just render their canonical `name`.
import { type MouseEvent as ReactMouseEvent } from "react";
import { FONT_WEIGHT } from "../theme/colors";

const FONT_SIZE = 13;

export function FittedAgentName({
  title,
  name,
  color,
  active,
  onDoubleClick,
}: {
  /** The auto-name title to show, or null for legacy/manual agents (falls back to `name`). */
  title: string | null;
  /** Canonical fallback name. */
  name: string;
  color: string;
  /** Selected row uses the bold weight; others semibold. */
  active: boolean;
  onDoubleClick: (e: ReactMouseEvent) => void;
}) {
  const display = title?.trim() || name;
  return (
    <span style={{ flex: 1, minWidth: 0, display: "block", overflow: "hidden" }}>
      <span
        // Double-click to rename. A single click must NOT enter edit mode — it just selects the
        // agent (the row's onClick), so clicking a tab never accidentally renames it. No title
        // tooltip — the hover-to-rename hint was distracting on every row.
        onDoubleClick={onDoubleClick}
        style={{
          display: "block",
          color, // the whole name takes its status color
          fontSize: FONT_SIZE,
          fontWeight: active ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {display}
      </span>
    </span>
  );
}
