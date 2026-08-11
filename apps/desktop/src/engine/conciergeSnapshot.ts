// The compact fleet context the headless brain is given with every user turn.
//
// Moved verbatim out of components/ConciergeHost. It is a pure string build over the feed with no
// React in it, and it is the SECOND caller of `engine/conciergeRosterLine` — `buildProactivePrompt`
// is the first — so it sits beside that rather than inside a component.
import { renderOpenAsks, type OpenAsk } from "@sparkle/core";

import { bandCountLabel } from "./statusBandLabels";
import { rosterLine } from "./conciergeRosterLine";
import { accountedAgents, type ConciergeFeed } from "../services/conciergeFeed";

/**
 * Compact context handed to the headless brain so its reply is grounded in what's actually happening.
 *
 * ── IT CARRIES WHAT HE ASKED FOR, NOT JUST WHAT IS RUNNING (bead sparkle-yd1ud) ─────────────────
 * For most of this function's life it was two things: the live roster, and the message just typed.
 * Both describe the PRESENT. Nothing described what the founder had previously asked for, so an ask
 * survived only if the concierge minted an artifact for it inside that same turn — and when it
 * merely replied "I'll get that started", the request existed nowhere in the app and evaporated with
 * the context. Two of the four items he had to chase on 2026-08-09 died exactly here.
 *
 * `openAsks` is the fix, and it belongs in THIS function specifically. Filing asks into beads makes
 * them durable, but durability alone changed nothing: the board already existed and the dropped
 * items were still never mentioned, because nothing put them in front of the brain. A durable record
 * nobody reads is the same silence with more storage.
 */
export function buildSnapshot(
  feed: ConciergeFeed,
  userText: string,
  openAsks: readonly OpenAsk[] = [],
): string {
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
  // BEFORE the user's message, not after. The block is standing context the reply must be consistent
  // with, and the last thing in the prompt is the thing a model answers; putting his own words last
  // keeps the turn about what he just said while the open asks remain in view.
  const asksBlock = renderOpenAsks(openAsks);
  const preamble = asksBlock === null ? state : `${state}\n\n${asksBlock}`;
  return `${preamble}\n\nThe user says: ${userText}\n\nReply briefly and recommend the next action.`;
}
