// Pure nudge thresholds (spec §"Ahead/behind + the two nudges"). Inclusive (>=) so the nudge
// fires AT the threshold. Tune here — nothing else hardcodes these numbers.
import type { BranchStatus } from "../services/branchStatus";

export const STALE_WARN = 10; // commits behind → prominent warn
export const GROW_COMMITS = 15; // commits ahead → "land or split"
export const GROW_LINES = 1000; // changed lines → "land or split"

export type StalenessTier = "none" | "info" | "warn";

export function stalenessTier(behind: number): StalenessTier {
  if (behind <= 0) return "none";
  if (behind >= STALE_WARN) return "warn";
  return "info";
}

export function growNudge(status: BranchStatus): boolean {
  return status.ahead >= GROW_COMMITS || status.insertions + status.deletions >= GROW_LINES;
}
