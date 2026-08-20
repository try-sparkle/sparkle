// How a bead's `status` reads and inks. Shared by the pill and the card so a bead cannot say one
// thing in a sentence and another in the card that sentence opens.
import type { CSSProperties } from "react";
import { C } from "../../theme/colors";
import { columnFor, type Bead, type BeadStatus } from "../../services/beads";
import { STAGE_LABELS, type EpicLadderKey } from "../../services/epicBoard";

/**
 * The status dot's colour — the same three the board already uses for a unit of work's progress:
 * done is the teal accent, running is full-strength cream, not-started is muted.
 */
export function statusColor(status: BeadStatus): string {
  if (status === "closed") return C.teal;
  if (status === "in_progress") return C.cream;
  return C.muted;
}

/**
 * THE WORD A READER SEES FOR A BEAD'S STATE — the stage it is sitting in, never bd's wire status.
 *
 * ══ WHY THE WIRE STATUS CANNOT BE THE ANSWER ═══════════════════════════════════════════════════
 * {@link BeadStatus} is `open | in_progress | closed`, so a chip printing it can only ever say one
 * of three words — and `open` is the single bucket holding backlog, blocked, and planned-but-
 * unstarted alike. The founder, verbatim: *"I want them to have the actual status. So instead of
 * saying open, it should say something like 'Being Built'."* A card reading `open` under a header
 * reading `Being built` is worse than uninformative; it contradicts the thing beside it.
 *
 * ══ `placedIn` IS THE BUCKETING THAT PUT THE CARD WHERE IT IS ══════════════════════════════════
 * Not a re-derivation — the bucket itself, read back off the board by
 * `epicBoard.ladderKeyOf`. That is what makes the chip agree with its column header in EVERY mode:
 * on the task board it is `columnFor`'s answer, and in Epics-only mode it is the seven-rung
 * ladder's, where an open epic whose plan is written correctly reads "Planning" rather than
 * "Backlog". A single always-`columnFor` rule would be right on one board and wrong on the other.
 *
 * ══ THE FALLBACK IS A STAGE TOO, NEVER THE WIRE WORD ═══════════════════════════════════════════
 * `null`/omitted means the surface has no board behind it (a fixture, a support modal, a snapshot
 * still loading). It falls back to `columnFor` on the bead alone — which can miss the blocked
 * split, since blockedness is a dependency fact no bead carries — rather than to `open`. A
 * fallback that reverted to the wire word would put the defect back on exactly the surfaces
 * nobody is watching, and would let a caller that forgot the prop ship green.
 */
export function stageLabel(bead: Bead, placedIn?: EpicLadderKey | null): string {
  return STAGE_LABELS[placedIn ?? columnFor(bead)];
}

/** The dot itself. A circle, so `50%` rather than a radius step — see `theme/scale`'s `PILL`. */
export const statusDot = (status: BeadStatus): CSSProperties => ({
  flex: "0 0 auto",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: statusColor(status),
});
