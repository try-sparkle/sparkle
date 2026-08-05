// ONE GLYPH PER TOOL DOMAIN, in one place — because two surfaces draw it now.
//
// The founder, on the per-message status: *"I like how on the left side it gives me a little icon,
// I'd like to see that icon on the right side as well."* The words of an activity line belong to
// exactly one surface (see ConciergeThread.statusOwnership.test.tsx — showing them twice was the
// bug); the GLYPH is the one thing he asked to see in both. So the rail (`ThinkingIndicator`) and
// the under-message status (`MessageStatus`) draw the same icon for the same domain.
//
// THIS MAP LIVES HERE RATHER THAN IN EITHER COMPONENT so "the same icon" is a fact about the code
// and not a coincidence two files have to keep agreeing on. It was `ThinkingIndicator`'s private
// const; importing it from there would have made the status component pull in that file's store
// subscriptions and its 1 Hz liveness ticker for a lookup table.
//
// Feather glyphs, monochrome, small — no emoji as icons (house rule). These are status marks in a
// 360px column, not badges.
import { FiFolder, FiGitBranch, FiTerminal, FiUsers } from "react-icons/fi";
import type { IconType } from "react-icons";

import type { ConciergeActivityIcon } from "../../engine/conciergeActivityLine";

/** Keyed by the union in engine/conciergeActivityLine, so a new domain icon is a TYPECHECK failure
 *  here rather than a silently missing glyph on one of the two surfaces. */
export const ACTIVITY_ICONS: Record<ConciergeActivityIcon, IconType> = {
  agents: FiUsers,
  terminal: FiTerminal,
  workflow: FiGitBranch,
  workspace: FiFolder,
};
