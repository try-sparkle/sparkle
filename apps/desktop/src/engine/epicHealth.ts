// EPIC HEALTH — the square mark on an epic row, rolled up from the build agents bound to it.
//
// The founder, 2026-08-21 (bead `sparkle-l06ax7`, verbatim): *"I also would like to have status
// icons for the epics where they are green, amber, or red, just like the build agents. They should
// be square instead of circle. The epics should basically have a health score. If everything's good
// and there are build agents that are working, they should be green. If the build agents are amber,
// then the epics should be amber. If the build agents are red, then the epics should be red."*
//
// ══ THE FOURTH STATE, WHICH HE DID NOT NAME AND WHICH IS THE WHOLE POINT ════════════════════════
// His three colours cover every epic that HAS an agent. The epic this feature exists to kill is the
// one that has none — *"I want you to start to move these epics through so they're not just sitting
// there"*. An epic nobody is building is the "just sitting there" case, and it must not render as
// calm. So there is a fourth value, {@link EpicHealth} `"unstaffed"`, and two rules govern it:
//
//   • IT IS NOT GREEN. Green is stated by the founder as "there are build agents that are working",
//     which an unstaffed epic is definitionally not. Absence of an agent is absence of information
//     about progress, and PR #2357 settled for agent rows that absence must never render as calm.
//   • IT IS NOT GRAY EITHER. The founder's own rule, 2026-08-19, quoted in `components/rowClock`:
//     *"Nothing should ever be gray unless it has been effectively finished."* A backlog epic with
//     no agent is not finished; it is unstarted. Gray would say the opposite.
//
// `unstaffed` therefore renders in the AMBER ink but HOLLOW — see `components/EpicHealthSquare`.
// Hollow is the whole reason it can sit at amber severity without building a wall of alarm: most
// epics in Backlog genuinely have no agent, and `packages/ui/tokens.ts` de-escalated `unmerged`
// from red on 2026-07-26 precisely because 27 of 51 agents sat in one band and the wall carried no
// information. An empty box reads as "nobody is in here", which is exactly the fact.
//
// ══ ALL-CALM COLLAPSES INTO `unstaffed`, DELIBERATELY ═══════════════════════════════════════════
// An epic whose bound agents have all finished and gone gray is ALSO sitting there — the work
// stopped and the epic did not move on. Splitting that into a fifth state would give the founder
// two marks meaning "nobody is working on this", which is one more than the fact needs. Both read
// `unstaffed`, and the tooltip says "Nobody is working on this epic", which is true of both.
//
// ══ THE TIERS COME FROM `bandOfRollup`, NOT FROM A COLOUR LIST SPELLED OUT HERE ═════════════════
// `engine/workerRollup` states the taxonomy once and its header warns at length against a second
// copy ("TIERS COME FROM `bandOfStatus`, NOT FROM A LIST SPELLED OUT HERE"). So this module maps
// BANDS, not dots:
//
//   needs_you → red      questions → amber      running → green      done → contributes nothing
//
// The consequence worth stating out loud is `orange`. A build row painted orange (some workers red,
// some green) LOOKS amber on screen, so the founder's sentence would suggest amber here. It maps to
// RED, because `bandOfRollup("orange") === "needs_you"` — orange exists precisely to say "something
// under this row wants you". Filing it as amber would mean the epic square and the "Needs you"
// filter chip disagree about the same epic, which is the column↔chip drift `workerRollup`'s header
// records as already shipped twice. The square is a ROLLUP: "something under this epic needs you"
// is true, and red is how this app says it.
//
// ══ THE ONE ARM THAT READS A STATUS RATHER THAN A BAND ══════════════════════════════════════════
// `lapsed` ("Unfinished, not yours" — brand AMBER in `packages/ui/tokens.ts`) bands as `done`, so a
// band-only rule would file a genuinely amber build row under "contributes nothing". That is the
// one place the founder's sentence and the band table disagree on a colour he can actually see, so
// `lapsed` is read explicitly and lands in amber. It is spelled as ONE named status rather than a
// list, so it cannot quietly grow into a rival taxonomy.
//
// KNOWN NARROWNESS, stated rather than hidden: `components/rowClock.dotFillFor` repaints a gray row
// amber when its git SECTION is pre-terminal, and the epics column does not poll git state, so it
// cannot see that repaint. An epic whose only agent is gray-but-pre-terminal therefore reads
// `unstaffed` here while the build row beside it reads amber. Both say "not progressing"; they
// differ only in which non-green they show. Widening this would mean teaching the epics column to
// poll branch status, which is a real cost for a distinction the founder has not asked for.
import { bandOfRollup, type RollupDot } from "./workerRollup";
import type { AgentTabStatus } from "../types";
import type { EpicLadderKey } from "../services/epicBoard";

/** The four marks an epic row's square can take.
 *
 *  `"unstaffed"` is NOT a colour name and that is on purpose — it is the only one of the four that
 *  is a statement about the ROSTER rather than about an agent's status, and naming it `"hollow"` or
 *  `"amber2"` would have hidden that. See this file's header. */
export type EpicHealth = "red" | "amber" | "green" | "unstaffed";

/** One build agent bound to the epic, reduced to exactly what the square needs.
 *
 *  Structural rather than an `AgentTab`, so a test builds four keys instead of a whole tab — the
 *  same reason `epicLadder.LadderAgent` is structural. */
export interface EpicAgentReading {
  id: string;
  /** Its head, when it has one. Used to FOLD a worker into an already-counted orchestrator; see
   *  {@link epicHealth}. `null`/absent for a top-level row. */
  parentId?: string | null;
  /** The rolled-up disc this row is painted — `engine/workerRollup.rollupDotAccessor`, the shared
   *  entry point, never a local re-derivation. */
  dot: RollupDot;
  /** Its OWN published status. Only the `lapsed` arm reads it; see this file's header. */
  status: AgentTabStatus;
}

/** Rank, worst first. Exported so the render layer cannot invent a second ordering. */
const SEVERITY: Record<EpicHealth, number> = { red: 3, amber: 2, green: 1, unstaffed: 0 };

/** Is `a` worse than `b`? */
export function worseEpicHealth(a: EpicHealth, b: EpicHealth): EpicHealth {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * The square for one epic, given every build agent bound to it.
 *
 * WORKERS ARE FOLDED, NOT COUNTED TWICE. `epicLadder.agentsForEpicSlices` returns an orchestrator
 * AND the workers beneath it, and `rollupDot` has ALREADY folded those workers into the
 * orchestrator's dot. Counting them again would be harmless for the max (red is red either way) but
 * not for `unstaffed`: a head sitting gray between delegations with a working worker under it rolls
 * up GREEN, and re-reading that worker as its own row cannot change the answer — while an ORPHAN
 * worker, one whose head is not bound to this epic at all, is the only row carrying the epic and
 * must still be seen. So a reading is dropped only when its own parent is also in the list.
 *
 * Pass an EMPTY list for an epic nobody is building; the result is `"unstaffed"`.
 */
export function epicHealth(readings: readonly EpicAgentReading[]): EpicHealth {
  const present = new Set(readings.map((r) => r.id));
  let worst: EpicHealth = "unstaffed";
  for (const r of readings) {
    if (r.parentId && present.has(r.parentId)) continue;
    worst = worseEpicHealth(worst, markOf(r));
    // Nothing outranks red, so the scan can stop the moment one is seen.
    if (worst === "red") return "red";
  }
  return worst;
}

/** One bound agent's contribution. `"unstaffed"` from here means "this row says nothing about
 *  progress" — it is absorbed by {@link worseEpicHealth} unless every row says it. */
export function markOf(r: EpicAgentReading): EpicHealth {
  switch (bandOfRollup(r.dot)) {
    case "needs_you":
      return "red";
    case "questions":
      return "amber";
    case "running":
      return "green";
    case "done":
      // The one status read directly rather than through its band — see this file's header.
      return r.status === "lapsed" ? "amber" : "unstaffed";
  }
}

/** The rungs where "is anyone building this?" is a question worth answering.
 *
 *  A `done`/`delivered`/`archived` epic is FINISHED, and painting a mark on it would be the founder's
 *  gray rule inverted: it would report "nobody is working on this" about work that is complete, on
 *  the three rungs that grow without bound. Those rungs render no square at all — which cannot be
 *  mistaken for calm, because the rung's own header says "Done" / "Shipped" / "Archived".
 *
 *  Written as an EXCLUSION over `EpicLadderKey` so a rung added to the ladder later is live by
 *  default. A new rung is far likelier to be a working state than a terminal one, and the failure
 *  directions are not symmetric: a new live rung silently rendering no square would re-hide exactly
 *  the sitting epics this feature exists to surface. */
const TERMINAL_RUNGS: ReadonlySet<EpicLadderKey> = new Set<EpicLadderKey>([
  "done",
  "delivered",
  "archived",
]);

export function epicHealthApplies(rung: EpicLadderKey): boolean {
  return !TERMINAL_RUNGS.has(rung);
}

/** The hover text for a square. Stated here, beside the rule that picks the value, so the mark and
 *  the words a human reads to interpret it cannot drift apart. */
export function epicHealthLabel(health: EpicHealth): string {
  switch (health) {
    case "red":
      return "Needs you — a build agent on this epic is stopped";
    case "amber":
      return "Paused — a build agent on this epic is waiting on something";
    case "green":
      return "Building — a build agent is working on this epic";
    case "unstaffed":
      return "Nobody is working on this epic";
  }
}
