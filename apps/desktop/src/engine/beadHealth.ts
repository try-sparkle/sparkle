// BEAD HEALTH — the same square, on any bead, not only on an epic.
//
// The founder, 2026-08-22 (bead `sparkle-tsyh5u`, verbatim): *"Each of the children should also
// have a status so just like the epic has a square status, the children should also have that
// status. […] I additionally want these square statuses to carry over to the planning board. I want
// to be able to look on the planning board and see the status of each card."*
//
// ══ THIS MODULE IS A DELEGATION, AND THAT IS THE ENTIRE DESIGN ══════════════════════════════════
// It computes NOTHING. `beadHealth` calls `engine/epicHealth.epicHealth` and returns what it says,
// because the founder's other sentence in the same breath was *"I want the way that the square icons
// work to be exactly the same as the way the build icons work so I don't want any differences
// between the two."* A private second copy of "worst wins" here is precisely how an epic square and
// a child square come to disagree about the same agent — and `engine/workerRollup`'s header records
// that this taxonomy has already drifted twice when it was written down twice.
//
// So the file is thin ON PURPOSE, and that thinness is the feature. If you find yourself adding a
// branch to {@link beadHealth}, you are adding the second vocabulary. Add it to `epicHealth`'s fold
// instead, where both surfaces will read it.
//
// ══ HE SAID "GRAY", AND IT NOW *IS* GRAY ═══════════════════════════════════════════════════════
// In the same message: *"gray square because it's not being worked on"*. That used to be flagged
// here as an UNRESOLVED conflict with an earlier rule of his (2026-08-19, *"Nothing should ever be
// gray unless it has been effectively finished"*), and the not-being-worked-on mark rendered hollow
// amber instead. He has since settled it himself, and settled it his way:
//
//   *"For the gray I do want it to work exactly like the Build Agent. That's the hard rule. The
//   colors work the same between the two and don't let any instruction ever override that. When I
//   say 'effectively finished' I just meant that turn is finished or whatever. Where it's not active
//   right now, however gray currently works, just make it the same."*
//
// So there is no conflict left to raise: gray means NOT ACTIVE RIGHT NOW, on a build row and on a
// bead card alike, and `EpicHealth` is now literally `RollupDot`. `epicHealth`'s header carries the
// full account of the three epic-only deviations that were deleted to get there.
//
// ══ THE ONE PLACE THE TWO RULES DIFFER, STATED RATHER THAN DISCOVERED ═══════════════════════════
// The WORDS, and only the words. `epicHealthLabel` says "on this epic", which is a lie on a child
// task row and on a planning-board card for an ordinary bead, and hover text is user-facing copy
// (which this repo treats as code). {@link beadHealthLabel} is the same five values with the same
// meanings and a different noun. The VALUE — which of the five you get — is byte-identical, and
// `beadHealth.test.ts` pins that agreement over a generated fleet rather than trusting this comment.
//
// ══ WHAT THIS DELIBERATELY DOES NOT DO ═════════════════════════════════════════════════════════
// It does not find the agents. Binding agents to a bead is the caller's job (the epics column
// already does it through `services/epicLadder.agentsForEpicSlices`); this module is a pure rule
// over readings that have already been gathered, exactly like `epicHealth`, so it is testable with
// three keys and no GUI.
import { epicHealth, type EpicAgentReading, type EpicHealth } from "./epicHealth";
import type { BeadStatus } from "../services/beads";

export type { EpicAgentReading, EpicHealth };

/**
 * The square for ONE bead, given every build agent bound to THAT bead.
 *
 * Identical in every respect to {@link epicHealth} — including the worker-folding rule, the mixed
 * fleet's `orange` and the empty-list `gray` — because it IS that function. See this file's header
 * for why it is a delegation rather than a reimplementation.
 *
 * Pass an EMPTY list for a bead nobody is building; the result is `"gray"`.
 */
export function beadHealth(readings: readonly EpicAgentReading[]): EpicHealth {
  return epicHealth(readings);
}

/** The bead states that are FINISHED, and so render no square at all.
 *
 *  Mirrors `epicHealth.TERMINAL_RUNGS` in shape: an EXCLUSION, so a `BeadStatus` added to the wire
 *  vocabulary later is live by default. The asymmetry that makes exclusion the right default is the
 *  same one stated there — a new state is far likelier to be a working state than a terminal one,
 *  and a new live state silently rendering no square would re-hide exactly the sitting work these
 *  squares exist to surface. `closed` is bd's only terminal state (see `services/beads.BeadStatus`).
 *
 *  Painting a mark on finished work would say "nothing is active here" about work that is complete.
 *  Nothing renders, which cannot be mistaken for calm — the card is in Done. */
const TERMINAL_BEAD_STATUSES: ReadonlySet<BeadStatus> = new Set<BeadStatus>(["closed"]);

/** Does this bead get a square at all? `false` for finished work.
 *
 *  KNOWN NARROWNESS, stated rather than hidden: this asks the bead's own STATUS, not which board
 *  column it has been bucketed into. An OPEN bead carrying the `archived` label sits in a terminal
 *  rung and still answers `true` here. For epics that dimension is covered by `epicHealthApplies`,
 *  which takes a rung; a caller rendering bead squares per column should gate on both rather than
 *  expecting this one predicate to know about buckets it is never handed. */
export function beadHealthApplies(status: BeadStatus): boolean {
  return !TERMINAL_BEAD_STATUSES.has(status);
}

/** The hover text for a bead's square.
 *
 *  THE ONLY THING IN THIS FILE THAT IS NOT A DELEGATION, and the header says why: `epicHealthLabel`
 *  names "this epic", which is wrong on a child task row and on an ordinary planning-board card.
 *  Same five values, same five meanings, one different noun. Kept beside the rule it describes so
 *  the mark and the words a human reads to interpret it cannot drift apart. */
export function beadHealthLabel(health: EpicHealth): string {
  switch (health) {
    case "red":
      return "Needs you — a build agent on this task is stopped";
    case "orange":
      return "Partly stopped — some agents on this task need you, others are still working";
    case "blue":
      return "Questions — a build agent on this task is waiting on an answer";
    case "green":
      return "Building — a build agent is working on this task";
    case "gray":
      return "Nobody is working on this task right now";
  }
}
