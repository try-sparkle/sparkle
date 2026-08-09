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
  /**
   * How many of {@link memberIds} own a pull request that could be merged RIGHT NOW — or `null` for
   * "we have not been told", which is NOT zero.
   *
   * ONLY EVER SET ON THE `unmerged` VARIANT, because it is the only line whose verb promises an
   * action GitHub gets a say in. A `rows` line says "3 Need you", and whether those three are
   * answerable is not a question anyone else holds the answer to.
   *
   * THE FIELD EXISTS SO THE SPLIT IS MACHINE-READABLE. `text` states it too, but a test that has to
   * grep an English sentence for "0 ready" is a test that goes green the day someone rewords the
   * sentence — and the whole defect here was a number that read as a promise. See {@link digestText}.
   */
  readyCount: number | null;
  text: string;
}

/**
 * WHAT THE APP HAS BEEN TOLD ABOUT PULL-REQUEST READINESS, as the digest needs to ask it.
 *
 * A FUNCTION RATHER THAN A MAP because the two halves are asked at different granularities: "did we
 * look at this project" is per project, "can this agent's PR be merged" is per agent. Collapsing
 * them into one per-project map was tried and is wrong — an agent in one project routinely owns a PR
 * in another repository, so a per-project ready count cannot be attributed back to the agents the
 * line actually counts. See `services/fleetPrs.prReadinessSnapshot`, which produces this.
 */
export interface DigestReadiness {
  /**
   * Has a pull-request probe ANSWERED for this project? A `false` here silences the readiness half
   * of the sentence entirely.
   *
   * This is the load-bearing half. `gh` can be absent, unauthed, offline or rate-limited, and the
   * probe runs on a three-minute poll — so "no agent in this line has a green PR" and "we have not
   * heard back yet" are both, naively, a ready count of zero. Rendering the second as "none ready to
   * merge" would replace one false promise with a false denial, which is the same defect wearing the
   * opposite sign.
   */
  probed: (projectId: string) => boolean;
  /** Does this agent own an open PR whose {@link prMergeReadiness} tone is `ready`? */
  agentReady: (agentId: string) => boolean;
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
  readyCount: number | null,
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
    if (status !== "unmerged") return `${bandCountLabel(band, count)} in ${projectName}`;
    const base = `${count} need merge in ${projectName}`;
    // ── THE SPLIT (bead `sparkle-mf501`, the founder's 2026-08-09 report) ────────────────────────
    //
    // He read "4 need merge in sparkle", clicked through, and NOT ONE of the four could be merged:
    // three were red on CI and the fourth conflicts. The count was arithmetically honest — four
    // agents really did have work that had not reached `main` — and it was still a false promise,
    // because the word it wears is "merge" and none of them could be. Two different predicates were
    // wearing one number.
    //
    // HIS OWN ASK WAS TO HIDE THE ROW UNTIL EVERYTHING IS GREEN, and that is the one thing this
    // must not do. `engine/agentStall` records the standing position from the same fleet: un-landed
    // work is a LANDING STATE, not an alarm, and 27 of 51 agents sat in it — three red pull requests
    // do not stop existing because they are red, and the ruling in this file's own header (bead
    // `sparkle-qogah`) is that a row he owes action on may never be hidden. So the number SPLITS
    // rather than filters: the outstanding count and the actionable count stop being the same word,
    // and a number that invites a click promises only what the click can do.
    //
    // SILENT WHEN WE DID NOT LOOK. `readyCount === null` means no probe has answered — see
    // {@link DigestReadiness.probed} — and it renders the bare sentence rather than "none ready",
    // because a denial we cannot support is the same defect as a promise we cannot keep.
    if (readyCount === null) return base;
    return readyCount > 0 ? `${base} · ${readyCount} ready` : `${base} · none ready yet`;
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
  readiness?: DigestReadiness,
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
    // COUNTED OVER THIS BUCKET'S OWN MEMBERS, never over the project's pull requests. The two are
    // different populations and only one of them is what the line's number stands for: an agent may
    // have committed work with no PR at all, and a project's PR list holds PRs belonging to agents
    // this line does not count. Asking per member keeps the numerator inside the denominator, so
    // "4 need merge · 2 ready" can only ever mean "two of THESE four".
    //
    // GATED ON THE PROJECT'S PROBE, taken from the bucket's own project (every member shares it —
    // the key is `projectId::status`). Un-probed → null → the sentence says nothing about readiness.
    const readyCount =
      variant === "unmerged" && readiness?.probed(first.projectId)
        ? bucket.filter((a) => readiness.agentReady(a.id)).length
        : null;
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
      readyCount,
      text: digestText(
        variant,
        first.band,
        bucket.length,
        first.projectName,
        first.status,
        readyCount,
      ),
    });
  }

  // Most urgent band first; ties by project name so the order is total and stable.
  groups.sort(
    (a, b) => bandRank(a.band) - bandRank(b.band) || a.projectName.localeCompare(b.projectName),
  );
  return { cards, groups };
}
