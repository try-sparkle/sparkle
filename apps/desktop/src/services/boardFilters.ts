// apps/desktop/src/services/boardFilters.ts
// The plan board's PRIORITY and DATE-RANGE filters, as pure functions.
//
// Kept out of BoardView so the rules are unit-testable without a DOM: the interesting behaviour
// here is entirely about which beads survive, and that is a question about data, not about React.
// BoardView applies `matchesBoardFilter` over the already-bucketed columns (the same seam the
// per-agent feedback filter uses), so the poll, the fetch and the 5-column bucketing are untouched.
import type { Bead } from "./beads";

/** Which timestamp the date window is measured against. The founder asked for both, with a switch. */
export type DateField = "created" | "updated";

/** The date windows offered. `all` is the off position, not a 100-year window. */
export type DateWindow = "24h" | "7d" | "30d" | "all";

export interface BoardFilter {
  /** A bd priority 0-4, or null for "any priority". */
  priority: number | null;
  dateField: DateField;
  dateWindow: DateWindow;
}

/** The off position for every axis. `updated` is the default field: "what has been touched lately"
 *  is the question a board answers, and created-at buries long-running work that is still moving. */
export const NO_BOARD_FILTER: BoardFilter = {
  priority: null,
  dateField: "updated",
  dateWindow: "all",
};

const WINDOW_MS: Record<Exclude<DateWindow, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Human labels for the window presets, so the control and any banner cannot drift apart. */
export const WINDOW_LABEL: Record<DateWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "Any date",
};

/**
 * Every priority bd can emit, 0-4 (0 highest) — see AGENTS.md ("Priority: 0-4 or P0-P4") and
 * `scripts/lib/retro-beads.sh` ("bd priorities are 0-4").
 *
 * ══ THIS IS WIDER THAN THE EDITABLE PILL, DELIBERATELY ══════════════════════════════════════════
 * The founder specified the pill's menu as exactly four options ("P0: Do it now and then there
 * should be options for P1…, P2…, and P3…"), so the pill offers those four and nothing else — a
 * fifth choice he did not ask for would be us editing his spec.
 *
 * The FILTER is a different question: it must be able to isolate anything bd actually stores, and
 * bd hands out P4 whether or not the pill can set it (the retro pain-point path files at P4 by
 * default, so the backlog is full of them). Capping the filter at P3 would leave those beads
 * reachable only by clearing the filter entirely — hiding real rows behind a control that looks
 * complete, which is the `sparkle-qogah` failure.
 */
export const PRIORITY_LABEL: Record<number, string> = {
  0: "P0: Do it now",
  1: "P1: Do it next",
  2: "P2: Do it when most efficient",
  3: "P3: Do it when cycles are available",
  4: "P4: Backlog",
};

/**
 * The priorities the EDITABLE pill offers — the founder's four, derived from the list above rather
 * than restated beside it (knightwatch probe 5199421526#5).
 *
 * The wording lived in two places, one per surface, for the same bd domain. This is the services
 * layer both can reach, so the labels are declared once and each surface takes the slice it is
 * entitled to: the filter spans `FILTERABLE_PRIORITIES` (0-4, everything bd emits), the editor
 * spans this (0-3). P4 is absent HERE and only here — a bead that already carries it still renders,
 * because `priorityShort` reads the number rather than this list.
 */
export const EDITABLE_PRIORITIES = [0, 1, 2, 3] as const;

/** The priorities the FILTER offers — bd's whole domain. See PRIORITY_LABEL for why the pill's
 *  menu is shorter, and keep the two from being conflated. */
export const FILTERABLE_PRIORITIES = [0, 1, 2, 3, 4] as const;

/** Is anything actually narrowed? Drives whether the board shows a "filtered" banner at all — an
 *  inert filter must not put a banner on screen claiming the board is narrowed when it is not. */
export function boardFilterIsActive(f: BoardFilter): boolean {
  return f.priority !== null || f.dateWindow !== "all";
}

/**
 * Does this bead survive the filter?
 *
 * `now` is passed in rather than read from `Date.now()` so the rule is deterministic under test —
 * a window function that reads the clock internally can only be tested by mocking time.
 */
export function matchesBoardFilter(bead: Bead, f: BoardFilter, now: number): boolean {
  if (f.priority !== null && bead.priority !== f.priority) return false;
  if (f.dateWindow === "all") return true;

  const raw = f.dateField === "created" ? bead.createdAt : bead.updatedAt;
  // ══ AN UNREADABLE DATE KEEPS THE BEAD, IT NEVER HIDES IT ══════════════════════════════════════
  // bd emits created_at/updated_at on every row, so a missing or unparseable one means something is
  // wrong with the DATA, not with the bead — an old snapshot, a bd version that renamed the key.
  // Hiding on that would silently empty the board and look like "there is no work", which is the
  // exact failure `sparkle-qogah` is about: never hide a row that needs action. Degrading to "the
  // date filter did not apply to this one" is the direction that fails safe.
  if (raw === undefined || raw === "") return true;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return true;

  return now - t <= WINDOW_MS[f.dateWindow];
}
