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
// THE RULE HAS NO EXEMPT POPULATION. Agents with no row of their own (workers nothing else speaks
// for) used to bypass this module entirely and render one card each — which reproduced the card wall
// on any fleet with several blocked workers under an absent or in-motion orchestrator, the exact
// shape the module exists to prevent. They go through the same grouping now, as the `rowless`
// variant: same "two or more become a line", a sentence that does not state a row count, and a click
// that reveals rather than filters. See DigestVariant.
//
// KEYED BY BAND AS WELL AS PROJECT, even though only `needs_you` is surfaced today. Two bands are
// two different sentences with two different urgencies, and collapsing them into one line would
// hide the urgent behind the count. Keying on it now means widening what the column surfaces is a
// one-line change here rather than a bug.
//
// THE RULE BEHIND THE KEY: a line may only group agents ONE CLICK CAN DELIVER. That is a constraint
// on the CLICK's reach as much as on the grouping, and the fix belongs on whichever side keeps the
// column a conversation. A `rows` click narrows the column to a band, so project+band is exactly
// deliverable. A `rowless` click expands the subtrees its members hide in — so the group records
// EVERY head it names (`rowHeadIds`) and the click opens all of them, rather than the key being
// split per head. Splitting the key was tried and reverted: it made each line honest but fragmented
// the common shape (several in-motion orchestrators, one blocked worker each) into a bucket apiece,
// and a bucket of one is a card — the card wall, rebuilt by the module meant to prevent it
// (roborev 53734, then 53737).
//
// PURE. No stores, no Tauri — the column renders what this returns, and the whole rule is testable
// as data in / data out.
import { STATUS_BANDS, type StatusBand } from "../engine/buildSections";
import { bandCountLabel, bandLabel } from "../engine/statusBandLabels";
import type { ConciergeAgent } from "../useConciergeFeed";

/**
 * WHICH POPULATION a line stands for — and therefore what its number is allowed to promise.
 *
 *  • "rows"    — agents that own a row in column two. The count is a PROMISE: click the line and
 *                exactly that many rows are left standing (ConciergeHost.digestFilter.test.tsx).
 *  • "rowless" — agents with no row of their own: workers nothing else speaks for. The GROUPING
 *                rule is identical, because the rule is about the column being a conversation —
 *                N of anything is one line, never N cards. What differs is the sentence (it names
 *                what they ARE, so the number cannot read as a row count) and the click (it
 *                reveals, it does not filter a column that has no rows to leave standing).
 *
 * Two variants of the same project::band can be live at once — two blocked top-level agents beside
 * two blocked workers in one project — so the ids they generate must not collide.
 */
export type DigestVariant = "rows" | "rowless";

/** One line standing in for several agents that share a project and a band. */
export interface ConciergeDigestGroup {
  /** Stable across rebuilds so React doesn't remount the row on every feed tick. */
  id: string;
  projectId: string;
  projectName: string;
  band: StatusBand;
  /** What this line's count is a promise about — see {@link DigestVariant}. */
  variant: DigestVariant;
  /** How many agents this line stands for (always ≥ 2 — a singleton keeps its card). */
  count: number;
  /** The agent the click reveals: the first in the feed's existing order, which is already
   *  sorted live-question-first then most-recently-touched. Opening the project on the item that
   *  most wants attention beats opening it on an arbitrary one. */
  leadAgentId: string;
  /** For a `rowless` line, EVERY head row whose subtree holds one of the agents this line stands
   *  for, de-duplicated and in first-seen order. Empty for a `rows` line, whose agents are heads.
   *
   *  A rowless line's members have no row of their own, so the click has to EXPAND the heads they
   *  nest under: `collapsedOrchestrators` reads a missing entry as collapsed, so on a fresh launch
   *  the subtrees are shut and revealing the lead would show a terminal pane above zero worker rows.
   *
   *  It is a LIST, and that is the whole design (roborev 53734, then 53737). Keying the bucket by
   *  head instead would also have made the count honest — but it fragments the common fleet shape,
   *  several in-motion orchestrators with one blocked worker each, into one bucket apiece; a bucket
   *  of one is a card, so the line the digest exists to draw became N cards. Grouping stays
   *  `project::band`, and the click's reach is what widens to match: `expandOrchestrators` already
   *  takes an array, so one line can name several subtrees and still deliver all of them. */
  rowHeadIds: string[];
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

/** The line's sentence.
 *
 *  `rows` states the band count the click can deliver, in the shared inflected vocabulary.
 *  `rowless` names what the agents ARE instead: these have no row anywhere, so "N Need you in web"
 *  would state a number the click cannot produce — the exact promise the founder's empty column
 *  came from. Naming them as workers nested inside the project says the same true thing without
 *  the arithmetic about rows. */
function digestText(
  variant: DigestVariant,
  band: StatusBand,
  count: number,
  projectName: string,
): string {
  if (variant === "rows") {
    // `bandCountLabel`, not a local template: the label has to AGREE IN NUMBER ("1 Needs you" but
    // "3 Need you"), and a private copy of that rule is exactly the drift the shared helper exists
    // to prevent.
    return `${bandCountLabel(band, count)} in ${projectName}`;
  }
  // A line is only ever drawn for two or more (a singleton keeps its card), so the plural here is
  // unconditional rather than a second copy of the inflection rule.
  return band === "needs_you"
    ? `${count} workers inside ${projectName} need you`
    : `${count} workers inside ${projectName} are ${bandLabel(band).toLowerCase()}`;
}

/**
 * Split surfaced agents into the cards worth showing individually and the groups worth collapsing.
 *
 * `agents` must already be in the feed's display order; grouping preserves it, so the lead agent of
 * a group is the one the feed ranked first.
 *
 * `variant` changes what a line SAYS, what its id is, and what its click must OPEN — never how the
 * grouping works: both populations go through the one `project::band` rule, because "two or more
 * become a line" is the whole reason column one is a conversation rather than a card wall. See
 * `ConciergeDigestGroup.rowHeadIds` for how a rowless line stays deliverable without splitting.
 */
export function buildDigest(
  agents: ConciergeAgent[],
  variant: DigestVariant = "rows",
): ConciergeDigest {
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
      // The variant is part of the id, not just of the text: both variants can hold the same
      // project::band at the same time, and two lines sharing an id would collide as React keys and
      // would make a click ambiguous about which population it was re-derived from.
      id: variant === "rows" ? `digest-${key}` : `digest-rowless-${key}`,
      projectId: first.projectId,
      projectName: first.projectName,
      band: first.band,
      variant,
      count: bucket.length,
      leadAgentId: first.id,
      // EVERY head this line stands for, so the click can open all of them. De-duplicated because
      // several members usually share one orchestrator, and `expandOrchestrators` writes a key per
      // id. A `rows` group's members are heads themselves, so it names none.
      rowHeadIds:
        variant === "rows"
          ? []
          : [...new Set(bucket.map((a) => a.parentRowId).filter((id): id is string => id !== null))],
      text: digestText(variant, first.band, bucket.length, first.projectName),
    });
  }

  // Most urgent band first; ties by project name so the order is total and stable.
  groups.sort(
    (a, b) => bandRank(a.band) - bandRank(b.band) || a.projectName.localeCompare(b.projectName),
  );
  return { cards, groups };
}
