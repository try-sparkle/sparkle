// WHERE DOES THIS BEAD SIT? — the pure half of "Open in column", answered POSITIONALLY.
//
// ══ THE FOUNDER REJECTED THE SENTENCE ══════════════════════════════════════════════════════════
//
// He pressed **Open in column** on a task, the Epics column lists epics only, and nothing happened.
// The proposed fix was a line of copy explaining that a task is not an epic. His ruling, verbatim:
//
//   *"Well, I think instead of saying this is a task, not an epic, what it should do is it should
//   open the parent epic like you are saying. And then I should already be able to see all the
//   children that are attached to that epic. So maybe it scrolls me to that child or something
//   similar to that. And then it flashes it briefly — it highlights, it flashes, like, a highlight
//   on the background or something. So it draws my attention to it […] I would just want you to
//   show me where it sits inside of the Epic."*
//
// So the question "where does this live?" is answered by MOVING THE COLUMN, never by narrating.
// This module decides WHAT to reveal; `EpicsColumn` does the expanding, scrolling and flashing.
// Keeping the decision here means the four edge cases below are testable without a DOM — and, more
// to the point, without any temptation to answer them differently in each of the surfaces that
// eventually ask.
//
// ══ MEMBERSHIP IS NOT DEFINED HERE, AND THAT IS ENFORCED ═══════════════════════════════════════
//
// Epic-ness and the parent edge are stated in exactly ONE file — `services/beads.ts` — and
// `scripts/lib/epic-membership-guard.sh` fails CI on a second definition anywhere else, comments
// included. This module therefore COMPOSES `parentEpicOfIndexed` (which already resolves "the
// nearest ancestor that is an epic", explicit parent first and then dotted-id prefixes nearest
// first) and `isEpicIndexed`. It never inspects a bead's type field and never walks a parent chain
// of its own: both of those would be a rival answer to a question this codebase has already had
// three incompatible answers to.
//
// ══ THE FOUR OUTCOMES, AND WHY "STANDALONE" IS THE COMMON ONE ══════════════════════════════════
//
// A reveal cannot reveal nothing, and today MOST agent-linked beads are parentless — 45 of 46 when
// this was measured. So the parentless task is not a fallback branch nobody hits; it is the shape
// the feature is used in most often, and it gets a real answer: the task is revealed as its OWN row
// with its card open. "Where it sits" is still answered positionally, even when the answer is "on
// its own". Anything else here would be the explanatory message wearing a different hat.

import { epicIndexOf, isEpicIndexed, parentEpicOfIndexed, type Bead } from "../services/beads";

/**
 * What the column should reveal for a bead.
 *
 * `null` means the id names no bead in this snapshot — a stale reference, or a bead from another
 * project. The column does NOTHING in that case, deliberately: there is no row to move to, and a
 * notice saying so is the message the founder ruled out.
 */
export type EpicReveal =
  /** The bead lives under an epic: open `epicId`'s card and bring `childId` into view inside it. */
  | { kind: "child"; epicId: string; childId: string }
  /** The bead IS an epic: its own row is the reveal, and its card opens. */
  | { kind: "epic"; epicId: string }
  /** Neither — a parentless, childless task. It is revealed as its own row (see the header). */
  | { kind: "standalone"; beadId: string };

/**
 * Resolve the reveal for `beadId` against this snapshot.
 *
 * Order matters and is the founder's: the NEAREST epic ANCESTOR wins over the bead's own epic-ness.
 * A bead can satisfy both — a mid-tree epic with an epic above it — and "show me where it sits"
 * means the container, not the thing itself. Only when there is no such ancestor does the bead get
 * to be its own epic row.
 */
export function revealFor(beads: readonly Bead[], beadId: string): EpicReveal | null {
  const index = epicIndexOf(beads);
  const bead = index.byId.get(beadId);
  if (bead === undefined) return null;

  const ancestor = parentEpicOfIndexed(index, bead);
  if (ancestor !== null) return { kind: "child", epicId: ancestor.id, childId: bead.id };

  if (isEpicIndexed(index, bead)) return { kind: "epic", epicId: bead.id };

  return { kind: "standalone", beadId: bead.id };
}

/** The epic row this reveal points at, or `null` for a standalone bead that has no epic row at all.
 *  A one-liner so callers do not each re-`switch` on the union and get the `"child"` case — whose
 *  row is the PARENT's, not the bead's — subtly wrong. */
export function revealedEpicId(reveal: EpicReveal | null): string | null {
  if (reveal === null) return null;
  return reveal.kind === "standalone" ? null : reveal.epicId;
}

/** The bead whose row/pill should be scrolled to and flashed. Always the bead the user asked about
 *  — for a `"child"` that is the task INSIDE the epic's card, not the epic. */
export function flashTargetId(reveal: EpicReveal | null): string | null {
  if (reveal === null) return null;
  switch (reveal.kind) {
    case "child":
      return reveal.childId;
    case "epic":
      return reveal.epicId;
    case "standalone":
      return reveal.beadId;
  }
}
