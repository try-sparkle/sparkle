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
// KEYED BY BAND AS WELL AS PROJECT. Two bands are two different sentences with two different
// urgencies, and collapsing them into one line would hide the urgent behind the count. That
// forward-guard paid off: `unmerged` is surfaced here now too (see below), and widening was the
// one-line change it was designed to be rather than a bug.
//
// GROUPING IS NOT INTERRUPTION, and this module is where the founder's 2026-08-05 ruling landed
// (bead sparkle-qogah — "we should never hide a row that needs action from me"). Committed-but-
// unlanded work used to be excluded from column one entirely, on the reasoning that 27 un-landed
// agents would be 27 nudge cards. The reasoning was right and the conclusion was wrong: the fix for
// too many cards is THIS MODULE, not omission. So `unmerged` gets a variant instead of an
// exemption — one line, the true count, and every member named so the line can expand where it
// sits. Its band stays `done`, so it is surfaced without being escalated into an alarm.
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
 *  • "unmerged" — committed-but-unlanded work: "27 need merge in sparkle". The founder's ruling of
 *                2026-08-05 (bead sparkle-qogah, "we should never hide a row that needs action from
 *                me"), asked whether Needs-merge belongs in the WANTS YOU column: "Yes, but as one
 *                honest group — one row reading '27 need merge' that expands in place. Nothing
 *                hidden, count is true, column stays readable."
 *
 *                It is its own variant rather than a `rows` line over the `done` band for two
 *                reasons. (1) SENTENCE: `bandCountLabel("done", 27)` reads "27 Done", which is the
 *                opposite of what it means — this work is not done, it is un-landed. (2) BUCKET:
 *                `done` also holds `idle`, and he ruled idle/"Done — your turn" INFORMATIONAL in
 *                the same interview, so a `project::band` bucket would sweep agents he owes nothing
 *                on into a count of work he does. This variant keys on the STATUS, so it cannot.
 *
 *                Its count is a promise about neither rows nor reveals but about the line ITSELF:
 *                every member is named in `memberIds` and the line expands in place.
 *
 * Two variants of the same project::band can be live at once — two blocked top-level agents beside
 * two blocked workers in one project — so the ids they generate must not collide.
 */
export type DigestVariant = "rows" | "rowless" | "unmerged";

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
  /** EVERY agent this line stands for, in feed order — `memberIds.length === count`, always.
   *
   *  This is what makes a line EXPAND IN PLACE rather than merely hand off. The founder's two-word
   *  verdict on the old "+11 more" was that the affordance told him nothing: a collapsed count you
   *  cannot open is the same dead end as a hidden row. A line that names its members can be opened
   *  where it sits, without the reader leaving the conversation and without the renderer
   *  re-deriving a population from a feed that has ticked since.
   *
   *  Carried by EVERY variant, not just `unmerged`. The rule "N of anything is one line" is what
   *  makes column one a conversation; "and you can see which N" is what keeps that line honest, and
   *  there is no variant for which that is untrue. */
  memberIds: string[];
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
  status: ConciergeAgent["status"],
): string {
  // THE FOUNDER'S OWN WORDS: "one row reading '27 need merge'". Lower-case "need merge" rather than
  // the status token's "Needs merge", because this is a sentence about many agents and it has to
  // agree in number the way `bandCountLabel` does — and a line is only ever drawn for two or more.
  // NOT `bandCountLabel(band, n)`: this population bands `done`, which would render "27 Done" over
  // twenty-seven un-landed PRs — the single most misleading sentence this column could print.
  //
  // ON THE STATUS, NOT ON THE VARIANT ALONE. The bucket key already keeps a stray non-unmerged agent
  // out of this line's count; this keeps it out of this line's SENTENCE. Two `idle` agents handed to
  // this variant bucket together, and a variant-only test would have labelled them "2 need merge" —
  // a caller's mistake laundered into a confident false statement, which is the failure mode this
  // whole change exists to remove. They fall back to the shared band vocabulary instead.
  if (variant === "unmerged") {
    return status === "unmerged"
      ? `${count} need merge in ${projectName}`
      : `${bandCountLabel(band, count)} in ${projectName}`;
  }
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
    // KEYED ON THE STATUS FOR `unmerged`, on the band for everything else — see DigestVariant. The
    // band would be `done`, which also holds `idle`, so a caller handing this variant a mixed `done`
    // population would fold agents the founder ruled INFORMATIONAL into a count of work he owes. A
    // stray one now forms its own bucket instead of inflating the "need merge" line, and a bucket of
    // one is a card, which is the honest outcome for an agent that does not belong to this line.
    const key = variant === "unmerged" ? `${a.projectId}::${a.status}` : `${a.projectId}::${a.band}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(a);
    else buckets.set(key, [a]);
  }

  const cards: ConciergeAgent[] = [];
  const groups: ConciergeDigestGroup[] = [];
  for (const [key, bucket] of buckets) {
    const first = bucket[0]!;
    // A LONE `unmerged` AGENT STILL GETS A LINE, NEVER A CARD — the one variant where the singleton
    // shortcut is wrong, for two independent reasons.
    //
    // A nudge card is an INTERRUPTION with an agent's affordances on it, and "Approve"/"Open" mean
    // nothing for un-landed work — `ConciergeHost.cloudApproval.test.tsx` pins exactly that. And
    // buckets key on project, so a fleet with one un-landed PR in each of twenty projects would
    // emit twenty cards: the wall of cards the `done` band was excluded to prevent, rebuilt one
    // project at a time. The founder asked for "one honest group", and a group of one is still a
    // line that states a true count and expands in place.
    if (bucket.length === 1 && variant !== "unmerged") {
      cards.push(first);
      continue;
    }
    groups.push({
      // The variant is part of the id, not just of the text: both variants can hold the same
      // project::band at the same time, and two lines sharing an id would collide as React keys and
      // would make a click ambiguous about which population it was re-derived from.
      id: variant === "rows" ? `digest-${key}` : `digest-${variant}-${key}`,
      projectId: first.projectId,
      projectName: first.projectName,
      band: first.band,
      variant,
      count: bucket.length,
      leadAgentId: first.id,
      // EVERY head this line stands for, so the click can open all of them. De-duplicated because
      // several members usually share one orchestrator, and `expandOrchestrators` writes a key per
      // id. A `rows` group's members are heads themselves, so it names none.
      // A `rows` group's members ARE heads, so it names none. `rowless` and `unmerged` may both hold
      // agents that live inside a subtree, and a consumer that wants to show one in column two has
      // to open the head it hides in — so both record every head they name.
      rowHeadIds:
        variant === "rows"
          ? []
          : [...new Set(bucket.map((a) => a.parentRowId).filter((id): id is string => id !== null))],
      // Every member, in feed order. `count` is `memberIds.length` by construction — the line cannot
      // state a number it cannot then show you, which is the whole of "expands in place".
      memberIds: bucket.map((a) => a.id),
      text: digestText(variant, first.band, bucket.length, first.projectName, first.status),
    });
  }

  // Most urgent band first; ties by project name so the order is total and stable.
  groups.sort(
    (a, b) => bandRank(a.band) - bandRank(b.band) || a.projectName.localeCompare(b.projectName),
  );
  return { cards, groups };
}
