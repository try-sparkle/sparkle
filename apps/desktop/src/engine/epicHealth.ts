// EPIC HEALTH — the square mark on an epic row, rolled up from the build agents bound to it.
//
// ══ THE ONE SENTENCE THIS MODULE IS ════════════════════════════════════════════════════════════
// THE SQUARE IS THE BUILD ROW'S DOT, DRAWN AS A SQUARE. `EpicHealth` IS `RollupDot` — the same five
// values, the same meanings, the same colours read from the same table — and `markOf` is the
// identity. There is no epic-side colour vocabulary any more, because there is nothing left for one
// to say.
//
// ══ THE FOUNDER'S HARD RULE, 2026-08-22, VERBATIM ══════════════════════════════════════════════
// *"For the gray I do want it to work exactly like the Build Agent. That's the hard rule. The colors
// work the same between the two and don't let any instruction ever override that. When I say
// 'effectively finished' I just meant that turn is finished or whatever. Where it's not active right
// now, however gray currently works, just make it the same."*
//
// And, the same morning: *"I'm also happy to update Build Agents so if you have a design that you
// think is a good idea for Epics, let's just carry whatever it is over to Build Agents as well. I
// just want the user to not get confused by differences between the two. I don't have an opinion
// about the way that they work. I just want them to be consistent."*
//
// The direction chosen — and approved — is that THE EPICS SIDE CONFORMS TO BUILD AGENTS and the
// Build Agents dot logic does not change: that vocabulary already exists, `engine/workerRollup` is
// already documented as its single source of truth, and adopting it costs the Build Agents side
// nothing.
//
// ══ WHAT THIS FILE USED TO SAY, AND WHY IT NO LONGER SAYS IT ═══════════════════════════════════
// Three epic-only deviations lived here for a day, each with a paragraph arguing for it. All three
// are DELETED, and they are named here so a reader who remembers them can see they were retired on
// purpose rather than lost in an edit:
//
//   1. **`unstaffed` rendered HOLLOW AMBER and now renders GRAY.** The argument was an earlier
//      founder rule (2026-08-19): *"Nothing should ever be gray unless it has been effectively
//      finished."* He has now explicitly retired that reading — *"When I say 'effectively finished'
//      I just meant that turn is finished or whatever. Where it's not active right now, however gray
//      currently works, just make it the same."* Gray means NOT ACTIVE RIGHT NOW. A build row with
//      nothing happening on it is gray, so an epic with nothing happening on it is gray.
//   2. **The `questions` band mapped to amber; a build row paints it BLUE.** An earlier audit found
//      and recorded this exact gap and left it standing. Under the hard rule it is simply fixed:
//      blue is blue on both surfaces.
//   3. **A `lapsed` arm read a STATUS rather than a band**, specifically so it could paint a colour
//      the band table would not. That is, by definition, a difference between the two surfaces —
//      the one thing the hard rule forbids — so it is gone. A `lapsed` agent's build row is gray;
//      its epic square is now gray too.
//
// ══ THE ONE CASE WITH NO BUILD-ROW ANALOGUE ════════════════════════════════════════════════════
// An epic with ZERO agents bound. A build row always has an agent, so nothing on that surface
// corresponds to it — but it does not need a colour of its own, because gray is the honest answer:
// "not active right now" is exactly true of an epic nobody is building. It stays REACHABLE and
// TESTED (`epicHealth([])` is `"gray"`, and `rungForEpicHealth("gray")` is the Build: Unstaffed
// rung); it just no longer gets a private mark.
//
// Note the two words that survive the collapse and mean different things now, so they cannot be
// confused: `"gray"` is a COLOUR (an `EpicHealth`/`RollupDot`), and `"unstaffed"` is a LADDER RUNG
// (an `EpicLadderKey`). {@link rungForEpicHealth} is the one place they meet.
//
// ══ THE FOLD IS `rollupDot`'s OWN LAW, NOT A SECOND ONE ════════════════════════════════════════
// `workerRollup`'s law, quoted from its header: *"grey is ignored; red and green together make
// orange; blue loses to red and beats green."* That is exactly what {@link epicHealth} computes over
// the readings bound to an epic — the mixed test first, then a max over `SEVERITY` whose ordering
// (red > orange > blue > green > gray) reproduces the rest of it. One fleet, one answer, whichever
// surface asks.
import type { RollupDot } from "./workerRollup";
import type { AgentTabStatus } from "../types";
import type { EpicLadderKey } from "../services/epicBoard";

/** The five marks an epic row's square can take — which are the five marks a BUILD ROW's disc can
 *  take, because they are the same type.
 *
 *  This is an alias rather than a re-declared union ON PURPOSE. A re-declared union with the same
 *  five members would compile identically today and drift the first time `RollupDot` gains a sixth;
 *  the alias makes that drift impossible to write. See this file's header for the founder rule that
 *  demands it. */
export type EpicHealth = RollupDot;

/** One build agent bound to the epic, reduced to exactly what the square needs.
 *
 *  Structural rather than an `AgentTab`, so a test builds three keys instead of a whole tab — the
 *  same reason `epicLadder.LadderAgent` is structural. */
export interface EpicAgentReading {
  id: string;
  /** Its head, when it has one. Used to FOLD a worker into an already-counted orchestrator; see
   *  {@link epicHealth}. `null`/absent for a top-level row. */
  parentId?: string | null;
  /** The rolled-up disc this row is painted — `engine/workerRollup.rollupDotAccessor`, the shared
   *  entry point, never a local re-derivation. THE ONLY FIELD THAT DECIDES A COLOUR. */
  dot: RollupDot;
  /** Its OWN published status.
   *
   *  NOTHING READS THIS ANY MORE, and that is the point rather than an oversight. The `lapsed` arm
   *  that read it existed precisely to paint a colour the build row does not, which the founder's
   *  hard rule forbids (see this file's header). It is kept as an OPTIONAL field so the existing
   *  callers that already gather it still compile — and so that anyone tempted to re-introduce a
   *  status-reading arm has to walk past this comment to do it. */
  status?: AgentTabStatus;
}

/** Rank, worst first. Stated once so the render layer cannot invent a second ordering.
 *
 *  This ordering is not a taste call — it is `rollupDot`'s law spelled as numbers, so a max over
 *  marks lands where the build row lands: red outranks everything, orange (a half-stopped fleet)
 *  outranks a fleet that is merely asking, blue beats green, and gray is ignored by construction
 *  because it is the floor. Note that this is NOT how the mixed case is REACHED — {@link epicHealth}
 *  decides that from the fleet, exactly as `rollupDot` does, because a max over marks can only ever
 *  return the worst single reading and "mixed" is a property of the set. */
const SEVERITY: Record<EpicHealth, number> = {
  red: 4,
  orange: 3,
  blue: 2,
  green: 1,
  gray: 0,
};

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
 * not for gray: a head sitting gray between delegations with a working worker under it rolls up
 * GREEN, and re-reading that worker as its own row cannot change the answer — while an ORPHAN
 * worker, one whose head is not bound to this epic at all, is the only row carrying the epic and
 * must still be seen. So a reading is dropped only when its own parent is also in the list.
 *
 * Pass an EMPTY list for an epic nobody is building; the result is `"gray"` — "not active right
 * now", which is what the founder's hard rule says gray means.
 *
 * MIXED IS DECIDED OVER THE FLEET, NOT BY THE MAX, and that is why there is no early return on red.
 * `worseEpicHealth` folds one reading into another, so it can only ever report the worst SINGLE row;
 * "some red and some green" is a property of the whole set and is invisible to a max. The two-flag
 * scan below is `rollupDot`'s own shape (`if (anyRed && anyGreen) return "orange"` checked BEFORE
 * `if (anyRed) return "red"`), copied on purpose — that ordering is the founder's "should stay in
 * Being Built", and writing it the same way here is the parity.
 */
export function epicHealth(readings: readonly EpicAgentReading[]): EpicHealth {
  const present = new Set(readings.map((r) => r.id));
  let worst: EpicHealth = "gray";
  let anyRed = false;
  let anyGreen = false;
  for (const r of readings) {
    if (r.parentId && present.has(r.parentId)) continue;
    const mark = markOf(r);
    // An already-orange reading is a mixed SUBTREE folded into one head — it carries both facts, so
    // it feeds both flags rather than being a third case the fleet test has to know about.
    if (mark === "red" || mark === "orange") anyRed = true;
    if (mark === "green" || mark === "orange") anyGreen = true;
    worst = worseEpicHealth(worst, mark);
  }
  if (anyRed && anyGreen) return "orange";
  return worst;
}

/**
 * One bound agent's contribution: ITS OWN DOT, UNCHANGED.
 *
 * This is the whole of the founder's hard rule in one line. `RollupDot` already IS the mark the
 * build row paints for this agent, so re-deriving it here could only ever produce a difference
 * between the two surfaces — which is the one thing he ruled out. Everything this function used to
 * do (a band lookup, an amber arm for `questions`, a status arm for `lapsed`) was exactly such a
 * re-derivation, and every one of them is now deleted; see this file's header.
 *
 * It survives as a named function rather than being inlined for two reasons: {@link epicHealth}
 * reads better for it, and it is the place to put this comment — the next reader tempted to add "a
 * small epic-only exception" has to add it HERE, standing on the rule that forbids it.
 */
export function markOf(r: EpicAgentReading): EpicHealth {
  return r.dot;
}

/** The rungs where "is anyone building this?" is a question worth answering.
 *
 *  A `done`/`delivered`/`archived` epic is FINISHED, and painting a mark on it would report
 *  "nothing is active here" about work that is complete, on the three rungs that grow without
 *  bound. Those rungs render no square at all — which cannot be mistaken for calm, because the
 *  rung's own header says "Done" / "Shipped" / "Archived".
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
 *  the words a human reads to interpret it cannot drift apart.
 *
 *  These are the epic-flavoured wording of `workerRollup.rollupLabel`'s five, not a sixth taxonomy:
 *  same five values, same five meanings, a noun that suits an epic row. `beadHealthLabel` is the
 *  third phrasing of the same five, for the same reason. */
export function epicHealthLabel(health: EpicHealth): string {
  switch (health) {
    case "red":
      return "Needs you — a build agent on this epic is stopped";
    case "orange":
      return "Partly stopped — some agents on this epic need you, others are still working";
    case "blue":
      return "Questions — a build agent on this epic is waiting on an answer";
    case "green":
      return "Building — a build agent is working on this epic";
    case "gray":
      return "Nobody is working on this epic right now";
  }
}

/**
 * WHICH LADDER RUNG AN EPIC'S LIVE FLEET SAYS IT BELONGS IN.
 *
 * ══ THE BUG THIS EXISTS TO KILL ═════════════════════════════════════════════════════════════════
 * `services/beads.columnFor` maps `bead.status === "in_progress"` straight to "Being built". That
 * status is stamped ONCE, at promote-to-build, and is never re-derived from whether anything is
 * actually running — no agent, no PID, no pane is consulted. Measured on the founder's own store on
 * 2026-08-22: 128 beads `in_progress`, five of them touched in the last two hours, thirty-five
 * older than a fortnight. His words: *"I don't have a good understanding of why an epic can be in
 * the being built category and yet there are no active billed agents running against it."* The
 * answer is that nothing ever asked the fleet. This function is the asking.
 *
 * ══ THE MAPPING, WHICH IS THE FOUNDER'S, NOT AN INFERENCE ═══════════════════════════════════════
 * He split the column in two — *"'Build: Unstaffed' and 'Build: Active'. So the unstaffed one would
 * be right above the active one"* — and then said which fleet lands where: *"If there are Build
 * Agents currently working on an Epic then it should be in the Being Built status. If there are not
 * any and it's not finished then by definition it should be considered blocked […] Meaning if the
 * agents are Red then it would go into blocked. […] if there are some agents that are red and there
 * are some agents that are not red […] probably it should stay in Being Built."*
 *
 * Those two messages have to be reconciled on ONE point and the split is what reconciles it: the
 * no-agents case borrowed Blocked only because it had nowhere else to go, and now it has its own
 * rung. So "nothing active" goes to `unstaffed`, and Blocked keeps the meaning it has everywhere
 * else in this app — A HUMAN IS REQUIRED. An all-red fleet is exactly that, and it is his sentence
 * verbatim.
 *
 *   green | blue | orange → inProgress    ("Build: Active" — something is moving, or is mixed)
 *   red                   → blocked       (every agent stopped; only you can restart it)
 *   gray                  → unstaffed     ("Build: Unstaffed" — nothing is active on it at all)
 *
 * ══ THE TWO WORDS THAT LOOK ALIKE AND ARE NOT ══════════════════════════════════════════════════
 * `"gray"` in, `"unstaffed"` out. The input is a COLOUR — `EpicHealth`, which is `RollupDot` — and
 * the output is a LADDER RUNG. They used to share the name `"unstaffed"`, which read as though the
 * function were a no-op on that arm; it never was, and now the types say so.
 *
 * ══ WHY `orange` LANDS IN `inProgress` AND NOT IN `blocked` ═════════════════════════════════════
 * Because he said so — "should stay in Being Built" — and because the rung is a question about
 * WHERE THE WORK IS, while the square is a question about how it is going. A half-broken epic is
 * still being built; the orange square is what says part of it needs you.
 *
 * ══ CONSULTED ONLY FOR AN EPIC THAT WOULD OTHERWISE LAND IN "Build: Active" ═════════════════════
 * Never for a finished one — see {@link epicHealthApplies} — and never to OVERRIDE a rung the bead's
 * own state already establishes. A Backlog epic with no agent is in Backlog because nobody promoted
 * it, which is a different fact from a promoted epic nobody staffed, and only the second is what the
 * founder is complaining about.
 *
 * ══ THE RETURN TYPE IS A LITERAL UNION, DELIBERATELY, NOT `EpicLadderKey` ═══════════════════════
 * These three are the only rungs a LIVE FLEET can argue for. Typing it as the whole ladder would say
 * this function might return "archived" or "delivered", which it must never do — that would let a
 * fleet reading un-ship a shipped epic. The narrow type is that guarantee.
 *
 * THE BLOCKER THIS DOC USED TO CARRY IS GONE, AND SAYING SO IS THE POINT. It warned at length that
 * `"unstaffed"` was not yet an `EpicLadderKey`, that the union therefore would not compile against
 * one, and that casting it would drop epics into a rung with no column header — making them VANISH
 * from the board, the exact failure this whole feature exists to prevent. That was true and is no
 * longer: `services/epicBoard.ts` now has a real `"unstaffed"` rung ("Build: Unstaffed", between
 * Blocked and "Build: Active"), so this union IS assignable and no cast is needed.
 *
 * The narrow type stays anyway, deliberately, for the reason in the paragraph above — a fleet
 * reading must never be able to argue for "delivered" or "archived". What changed is only that the
 * narrowness is now a guarantee rather than a compile barrier.
 *
 * AND IT IS WIRED. `services/epicBoard.bucketEpics` takes this function's result as its
 * `buildRungFor` argument, so the `red -> "blocked"` arm below is the one the founder's screen
 * actually runs. It previously had NO production caller while five tests asserted it as though it
 * did — a green suite over a rule the shipped path never reached, which is the vacuous shape
 * `AGENTS.md` names. If you ever find yourself adding a second "which building rung" decision
 * somewhere else, that is the drift to stop: this is the one rule.
 */
export function rungForEpicHealth(health: EpicHealth): "blocked" | "unstaffed" | "inProgress" {
  switch (health) {
    case "red":
      // "if the agents are Red then it would go into blocked" — every agent stopped, so the only
      // thing that can restart this epic is the human.
      return "blocked";
    case "gray":
      // The rung the split created. NOT `blocked`: nothing is broken, nothing is active.
      return "unstaffed";
    case "orange":
    case "blue":
    case "green":
      // "should stay in Being Built" — something on this epic is moving or is answerable.
      return "inProgress";
  }
}
