// The priority a bead carries, and the one write this card makes.
//
// The four options are the founder's own words for what a priority MEANS. `bd`'s own help calls
// them "0-4 or P0-P4 (0=critical)", which is a scale a machine understands and a human has to
// translate every single time. "Do it now / next / when most efficient / when cycles are available"
// is the translation, and it is the label because the pill is a decision, not a field.
import {
  beadsUpdate,
  isBdMissing,
  isNoWorkspace,
  isStoreBusy,
  toBeadsError,
} from "../../services/beadsCommands";
import { EDITABLE_PRIORITIES, PRIORITY_LABEL } from "../../services/boardFilters";

/** One selectable priority. `value` is what `bd` stores; `label` is what a person reads. */
export interface PriorityOption {
  value: number;
  /** The collapsed pill's text — `P0`. */
  short: string;
  /** The menu row's text, VERBATIM as the founder wrote it. */
  label: string;
}

/**
 * The four priorities, highest first.
 *
 * P4 is deliberately absent even though `bd` accepts it: the founder named four bands, and a fifth
 * row that no scheduler distinguishes from P3 is a choice the reader has to make for no gain. A bead
 * that already carries P4 still RENDERS (see `priorityShort`) — this list governs what can be
 * picked, not what can be shown.
 */
export const PRIORITY_OPTIONS: readonly PriorityOption[] = EDITABLE_PRIORITIES.map((value) => ({
  value,
  short: `P${value}`,
  // ONE declaration site, in the services layer both surfaces reach. The same four strings used to
  // be restated here and in `boardFilters.ts` for the same bd domain, which is two places to edit
  // and one to forget (knightwatch probe 5199421526#5).
  label: PRIORITY_LABEL[value] ?? `P${value}`,
}));

/** The collapsed label for any priority, including one outside `PRIORITY_OPTIONS`.
 *
 *  `undefined` reads as `P?` rather than as nothing: a bead with no priority is the one most worth
 *  clicking, and rendering it as an absence is how it stays unset forever. */
export function priorityShort(priority: number | undefined): string {
  return priority === undefined ? "P?" : `P${priority}`;
}

/**
 * Is this priority in the URGENT band — the one the danger ink is for?
 *
 * ══ WHY THE INK IS BANDED RATHER THAN CONSTANT ══════════════════════════════════════════════════
 * The pill's treatment is `tag(C.dangerInk)`, which is the app's existing red tag (its exact
 * precedent is `ConciergeAuditPane`'s `codePill`) — nothing here invents a colour. What IS a
 * judgement call is whether EVERY priority wears it. Painting a P3 "do it when cycles are
 * available" in the same red as a P0 "do it now" spends the loudest ink in the palette on the
 * quietest fact, and a board where every card is red says nothing at all. So the danger ink marks
 * the two bands that mean "this is ahead of other work", and the rest take the neutral ink every
 * other metadatum on the card already uses.
 *
 * THIS IS NOT AN ATTENTION STATE. It is a tag on a field. It is deliberately absent from
 * `AGENT_STATUS`, `engine/attention.ts` and `isRedStatus`, and nothing here should ever be wired
 * into them — that taxonomy is owned elsewhere and is being extended separately.
 */
export function isUrgentPriority(priority: number | undefined): boolean {
  return priority !== undefined && priority <= 1;
}

/**
 * Write a bead's priority through the beads command surface.
 *
 * ══ WHY `beadsUpdate` AND NOT A NEW `notes.rs` COMMAND ══════════════════════════════════════════
 * `beads_update` already exists end to end and had no caller. The path it runs on is the one that
 * can survive a contended store: `beads_cmd.rs` dispatches through `spawn_blocking` (so a slow `bd`
 * never blocks the UI thread), bounds the child at `BD_TIMEOUT` and KILLS it on expiry, and checks
 * the result with `bd_ack`, which detects `bd`'s `{"error": …}` payload BY CONTENT because `bd`
 * emits it with exit code 0. `notes.rs`'s `run_bd` uses `.output()` with no timeout, which blocks
 * forever against exactly the contention this write is most likely to meet.
 *
 * Rejects with an `Error` whose message is already reader-facing — see `priorityFailureSentence`.
 */
export async function setBeadPriority(
  projectPath: string,
  beadId: string,
  priority: number,
): Promise<void> {
  try {
    // A STRING, because `BeadPatch.priority` is `string` — it is passed to `bd` as a flag value and
    // `0` must not be able to become a falsy omission anywhere along the way.
    await beadsUpdate(projectPath, beadId, { priority: String(priority) });
  } catch (e) {
    throw new Error(priorityFailureSentence(e));
  }
}

/**
 * What the reader is told when the write fails.
 *
 * ══ A BUSY STORE IS ITS OWN SENTENCE, AND THAT IS THE POINT OF THE TYPED ERROR ══════════════════
 * `bd` is a single embedded database that every worktree in the repo shares, and this app polls it
 * every five seconds while dozens of agents write to it. A write that loses that race is therefore
 * the MOST LIKELY failure here, and it is the one where "try again in a moment" is the whole
 * remedy — which a generic "couldn't save" actively hides. `BeadsErrorKind` distinguishes it, so
 * this does too, via `isStoreBusy`: it covers both halves of that one event — us timing out on a bd
 * that was still waiting, and bd giving up first and saying `context canceled`. The second used to
 * fall through to the last line, which put that bare Go phrase in front of the reader as though the
 * request itself had been wrong.
 *
 * The other two are the errors with a DIFFERENT remedy: install `bd`, or run `bd init`. Everything
 * else falls through to `bd`'s own message, which is the most specific thing available.
 */
export function priorityFailureSentence(e: unknown): string {
  const err = toBeadsError(e);
  if (isStoreBusy(e)) return "bd is busy — priority not saved";
  if (isBdMissing(e)) return "bd is not installed — priority not saved";
  if (isNoWorkspace(e)) return "this project has no beads workspace — priority not saved";
  return err.message === "" ? "priority not saved" : `priority not saved — ${err.message}`;
}
