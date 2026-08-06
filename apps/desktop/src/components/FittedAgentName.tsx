// The agent name (its auto-generated title) in the collapsed sidebar row. There's a single title
// length now — it's shown bold and truncated with a CSS ellipsis when the column is too narrow
// ("Remove Sparkle Fad…"). The full title + the description are revealed by the row's hover
// slide-out (see AgentSidebar), so this component carries no tooltip of its own. Legacy/manual
// agents with no title just render their canonical `name`.
import { type MouseEvent as ReactMouseEvent } from "react";
import { FONT_WEIGHT } from "../theme/colors";

/** The size EVERY row title in the Build column is set at. Exported because the pinned "Improve
 *  Sparkle" row can't use this component (it has no AgentTab and never renames) but must not be a
 *  different size from the rows above it — which is exactly what it had drifted into. */
export const AGENT_NAME_FONT_SIZE = 13;
const FONT_SIZE = AGENT_NAME_FONT_SIZE;

/**
 * FOCUS IS CARRIED BY WEIGHT, BECAUSE COLOUR IS ALREADY SPOKEN FOR.
 *
 * Every row title used to be `semibold`, with `bold` on the selected one. Two problems: a list
 * where every line is heavy has no hierarchy — the whole column shouts — and one step from 600 to
 * 700 is nearly invisible, so the focus it was meant to carry did not read at all.
 *
 * Regular everywhere, bold on the active row. Four steps instead of one, so the focal point is
 * unmistakable AND the column is calmer at rest.
 *
 * WHY NOT COLOUR, which was the first proposal (white on the active row, grey on the rest): colour
 * in this app is fully committed to STATUS — red/green/grey, on the dots, one vocabulary. Spending
 * it on focus as well would overload the single channel that currently means exactly one thing, and
 * grey-on-dark additionally collides with the DISABLED reading, so "not focused" and "not
 * available" would look identical. Weight was an unused axis; it carries focus without competing.
 *
 * AND IT IS NOT THE ONLY SIGNAL — deliberately. The flood and the two-sided connector say which row
 * is wired; this is reinforcement, so a reader who cannot resolve a weight difference has lost no
 * information.
 *
 * EXPORTED because three titles have to agree and a literal in each is how they drift: this
 * component (the ordinary row), the hover card's expanded title, and the pinned Improve Sparkle row
 * — which cannot use this component at all, since it has no AgentTab and never renames.
 */
export const rowTitleWeight = (active: boolean) =>
  active ? FONT_WEIGHT.bold : FONT_WEIGHT.regular;

/**
 * THE FLOOR THE NAME MAY NEVER GO BELOW. Bead sparkle-tyter.
 *
 * ══ WHAT WENT WRONG ═══════════════════════════════════════════════════════════════════════════
 * This span was `minWidth: 0`, which in a flex row means "take everything from me first". Beside it
 * the row rendered notice chips written as `flex: "0 0 auto"` with `whiteSpace: "nowrap"` — "I will
 * not give up a single pixel" — carrying literal words like "Rate limited" and "Looping". Flexbox
 * resolved that exactly as written: at the real column width the NAME was shrunk to ZERO and
 * vanished, leaving the notice flush against the stage chip that follows it. The founder's
 * screenshot shows eight rows reading `Rate limitedShipped`, `Rate limitedUnsaved`,
 * `Rate limitedSaved`, `Looping Shipped` — with the agent's name ENTIRELY ABSENT.
 *
 * That is a correctness failure, not a density complaint. A fleet list whose rows cannot say which
 * agent they belong to has stopped being a list of agents.
 *
 * ══ WHY A FLOOR AND NOT JUST SHORTER CHIPS ════════════════════════════════════════════════════
 * The notices ARE now wordless glyphs (components/agentNotices), which bounds their width and fixes
 * the case that shipped. But that fix lives in a sibling's styling, so the next chip anyone adds
 * re-opens the hole silently — nothing would fail. This floor is the STRUCTURAL half: whatever else
 * lands in that row, the name keeps at least this much and degrades by ELLIPSIS, which is
 * information ("Remove Sparkle Fad…"), rather than by disappearing, which is not.
 *
 * 64px ≈ 8-9 characters at the 13px row size — enough to tell two agents apart at a glance.
 *
 * ══ IT DOES EXCEED THE COLUMN'S MINIMUM, AND THAT IS HANDLED BY CLIPPING (roborev 58758) ══════
 * An earlier version of this comment claimed the floor "never forces a horizontal scrollbar at the
 * column's own minimum width". That was false: `BUILD_COLUMN_MIN_WIDTH` is 50 (engine/columnResize),
 * and 64 alone is past it before the dot, the elapsed timer, the badges and the row padding. A
 * dragged-down column therefore does produce a row wider than the list — so the list container sets
 * `overflowX: "hidden"` (see AgentSidebar's scroll container), making the overflow CLIP rather than
 * scroll the column sideways. The trade is deliberate: at 50px no arrangement shows a useful name,
 * and a clipped row still says which agent it is for the first eight characters, which a
 * zero-width one does not.
 */
export const AGENT_NAME_MIN_WIDTH_PX = 64;

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
  /** Selected row takes bold; every other row takes regular. See `rowTitleWeight`. */
  active: boolean;
  onDoubleClick: (e: ReactMouseEvent) => void;
}) {
  const display = title?.trim() || name;
  return (
    <span
      data-testid="row-agent-name"
      // `minWidth` is the whole fix — see AGENT_NAME_MIN_WIDTH_PX. `overflow: hidden` plus the
      // inner span's ellipsis still truncate a long name; what they can no longer do is truncate
      // it to nothing.
      style={{
        flex: 1,
        minWidth: AGENT_NAME_MIN_WIDTH_PX,
        display: "block",
        overflow: "hidden",
      }}
    >
      <span
        // Double-click to rename. A single click must NOT enter edit mode — it just selects the
        // agent (the row's onClick), so clicking a tab never accidentally renames it. No title
        // tooltip — the hover-to-rename hint was distracting on every row.
        onDoubleClick={onDoubleClick}
        style={{
          display: "block",
          color, // the whole name takes its status color
          fontSize: FONT_SIZE,
          fontWeight: rowTitleWeight(active),
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
