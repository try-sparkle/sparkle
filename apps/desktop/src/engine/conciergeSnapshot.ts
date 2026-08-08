// The compact fleet context the headless brain is given with every user turn.
//
// Moved verbatim out of components/ConciergeHost. It is a pure string build over the feed with no
// React in it, and it is the SECOND caller of `engine/conciergeRosterLine` — `buildProactivePrompt`
// is the first — so it sits beside that rather than inside a component.
import { bandCountLabel } from "./statusBandLabels";
import { rosterLine } from "./conciergeRosterLine";
import { accountedAgents, type ConciergeFeed } from "../services/conciergeFeed";

/** Compact context handed to the headless brain so its reply is grounded in what's actually happening. */
export function buildSnapshot(feed: ConciergeFeed, userText: string): string {
  // The FULL accounted population, rows and rowless alike — this states `scopedCounts.needs_you`
  // right below, and listing only the row-owning half would hand the brain a count it can't see the
  // items behind.
  const surfaced = accountedAgents(feed);
  // The line format — including the trailing `id:<agentId>` the persona's pill syntax depends on —
  // lives in engine/conciergeRosterLine, shared with buildProactivePrompt. See that module's header
  // for why a second copy of the template string is not an option.
  const lines = surfaced.map((a) => rosterLine(a));
  // Keep the project count SCOPED to what's actually surfaced so it can't misstate scope (e.g. say
  // "5 projects" while only counting in-scope agents).
  const scopedProjects = new Set(surfaced.map((a) => a.projectId)).size;
  const state =
    surfaced.length > 0
      ? `${bandCountLabel("needs_you", feed.scopedCounts.needs_you)} across ${scopedProjects} project(s):\n${lines.join("\n")}`
      : `All projects are calm right now.`;
  return `${state}\n\nThe user says: ${userText}\n\nReply briefly and recommend the next action.`;
}
