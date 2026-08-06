// How a bead's `status` reads and inks. Shared by the pill and the card so a bead cannot say one
// thing in a sentence and another in the card that sentence opens.
import type { CSSProperties } from "react";
import { C } from "../../theme/colors";
import type { BeadStatus } from "../../services/beads";

/**
 * The status dot's colour — the same three the board already uses for a unit of work's progress:
 * done is the teal accent, running is full-strength cream, not-started is muted.
 */
export function statusColor(status: BeadStatus): string {
  if (status === "closed") return C.teal;
  if (status === "in_progress") return C.cream;
  return C.muted;
}

/** What a reader calls the status. `in_progress` is a wire value, never words on screen. */
export function statusLabel(status: BeadStatus): string {
  if (status === "closed") return "closed";
  if (status === "in_progress") return "in progress";
  return "open";
}

/** The dot itself. A circle, so `50%` rather than a radius step — see `theme/scale`'s `PILL`. */
export const statusDot = (status: BeadStatus): CSSProperties => ({
  flex: "0 0 auto",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: statusColor(status),
});
