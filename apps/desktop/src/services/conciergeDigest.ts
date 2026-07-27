// Column one is a CONVERSATION, not a card wall (bead sparkle-4562.4, founder redirect 2026-07-24).
//
// The column used to render every surfaced agent as its own nudge card. With twenty-seven agents
// needing attention that is twenty-seven cards stacked above the compose box — the chat is pushed
// off screen and the column becomes an unreadable duplicate of column two, which already IS that
// list.
//
// The rule, from the bead:
//   • ONE item of a band → keep the card. At that volume the card IS the digest.
//   • TWO OR MORE → one line instead: "3 Need you in drodio-website". Clicking it opens that
//     project's tab, which is the handoff to column two rather than a second copy of it.
// Grouped by PROJECT, because that is the unit the digest line names and the unit the click opens.
//
// KEYED BY BAND AS WELL AS PROJECT, even though only `needs_you` is surfaced today. Two bands are
// two different sentences with two different urgencies, and collapsing them into one line would
// hide the urgent behind the count. Keying on it now means widening what the column surfaces is a
// one-line change here rather than a bug.
//
// PURE. No stores, no Tauri — the column renders what this returns, and the whole rule is testable
// as data in / data out.
import { STATUS_BANDS, type StatusBand } from "../engine/buildSections";
import { bandCountLabel } from "../engine/statusBandLabels";
import type { ConciergeAgent } from "../useConciergeFeed";

/** One line standing in for several agents that share a project and a band. */
export interface ConciergeDigestGroup {
  /** Stable across rebuilds so React doesn't remount the row on every feed tick. */
  id: string;
  projectId: string;
  projectName: string;
  band: StatusBand;
  /** How many agents this line stands for (always ≥ 2 — a singleton keeps its card). */
  count: number;
  /** The agent the click reveals: the first in the feed's existing order, which is already
   *  sorted live-question-first then most-recently-touched. Opening the project on the item that
   *  most wants attention beats opening it on an arbitrary one. */
  leadAgentId: string;
  text: string;
}

export interface ConciergeDigest {
  /** Agents that keep an individual card (the singletons). */
  cards: ConciergeAgent[];
  /** Collapsed groups, most urgent first. */
  groups: ConciergeDigestGroup[];
}

/** Band urgency, read from the ONE ordered list rather than restated here — STATUS_BANDS is
 *  already in most-urgent-first order for the sidebar, and a second copy of that ranking is a
 *  copy that drifts. */
const bandRank = (b: StatusBand) => STATUS_BANDS.findIndex((meta) => meta.id === b);

/**
 * Split surfaced agents into the cards worth showing individually and the groups worth collapsing.
 *
 * `agents` must already be in the feed's display order; grouping preserves it, so the lead agent of
 * a group is the one the feed ranked first.
 */
export function buildDigest(agents: ConciergeAgent[]): ConciergeDigest {
  const buckets = new Map<string, ConciergeAgent[]>();
  for (const a of agents) {
    const key = `${a.projectId}::${a.band}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(a);
    else buckets.set(key, [a]);
  }

  const cards: ConciergeAgent[] = [];
  const groups: ConciergeDigestGroup[] = [];
  for (const [key, bucket] of buckets) {
    const first = bucket[0]!;
    if (bucket.length === 1) {
      cards.push(first);
      continue;
    }
    groups.push({
      id: `digest-${key}`,
      projectId: first.projectId,
      projectName: first.projectName,
      band: first.band,
      count: bucket.length,
      leadAgentId: first.id,
      // `bandCountLabel`, not a local template: the label has to AGREE IN NUMBER ("1 Needs you" but
      // "3 Need you"), and a private copy of that rule is exactly the drift the shared helper exists
      // to prevent.
      text: `${bandCountLabel(first.band, bucket.length)} in ${first.projectName}`,
    });
  }

  // Most urgent band first; ties by project name so the order is total and stable.
  groups.sort(
    (a, b) => bandRank(a.band) - bandRank(b.band) || a.projectName.localeCompare(b.projectName),
  );
  return { cards, groups };
}
