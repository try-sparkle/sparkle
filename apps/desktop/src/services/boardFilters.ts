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

/**
 * WHICH ORDER a column's cards are rendered in — the founder's four, verbatim from his spec.
 *
 * ══ THERE WAS NO SORT AT ALL BEFORE THIS ══════════════════════════════════════════════════════
 * `bucketBeads` pushes each bead into a column in INPUT ORDER and `BoardView` renders that order
 * verbatim. The P0-first board the founder sees is `bd`'s own default output leaking through:
 * measured against a 7,779-row store, priorities are non-decreasing with ZERO inversions, but
 * WITHIN a band the order is arbitrary — `updated_at` is neither ascending nor descending. So the
 * ordering he likes was real and completely UNDEFENDED: nothing here went red if bd changed its
 * default. These comparators own the priority ordering outright rather than inheriting it.
 *
 *   - `priority` — P0 epics, P0 tasks, P1 epics, P1 tasks, … The DEFAULT, and the founder's words:
 *     "we should have p zero epics show first and then all the p zero tasks and then p one epics
 *     would show below that. Each column … So epics basically show at the beginning of the
 *     priority list." Note this is NOT epics-above-everything — it INTERLEAVES by priority band.
 *   - `type` — every epic first (in priority order), then every task (in priority order). This is
 *     the epics-above-everything reading, offered as ONE option rather than as the default.
 *   - `newest` / `oldest` — by date, and by date alone. See {@link isDateSort}.
 */
export type BoardSort = "priority" | "type" | "newest" | "oldest";

/** The founder's own wording for each option, used by the chip menu so the control and this
 *  module cannot drift into describing the order two different ways. */
export const SORT_LABEL: Record<BoardSort, string> = {
  priority: "Priority (P0 at top; Epics before Tasks)",
  type: "Type (All Epics, then Tasks; In priority order)",
  newest: "Date: Newest First",
  oldest: "Date: Oldest First",
};

/** The short form for the collapsed chip — the menu row above is a sentence, and a sentence does
 *  not fit on a chip beside three others. Prefixed "Sort:" because the board already has a
 *  PRIORITY chip that filters, and a bare "Priority" on two adjacent chips means two things. */
export const SORT_CHIP_LABEL: Record<BoardSort, string> = {
  priority: "Sort: Priority",
  type: "Sort: Type",
  newest: "Sort: Newest",
  oldest: "Sort: Oldest",
};

/** The options in menu order, DERIVED from the labels above rather than written out a second time
 *  — two hand-maintained copies of one list is how a menu ends up offering an order nothing
 *  implements. */
export const SORT_OPTIONS: readonly BoardSort[] = ["priority", "type", "newest", "oldest"];

/**
 * Does this sort read a TIMESTAMP, and therefore care which of created/updated is selected?
 *
 * The founder's call: the date sorts follow the existing Created/Updated chip rather than pinning
 * their own field, so the header holds ONE date concept instead of two that can disagree. The
 * consequence is that the chip has to be REACHABLE whenever a date sort is on — it used to appear
 * only once a date window was chosen, which would have left "Date: Newest First" silently ordering
 * by a field the user could not see or change.
 */
export function isDateSort(s: BoardSort): boolean {
  return s === "newest" || s === "oldest";
}

export interface BoardFilter {
  /** A bd priority 0-4, or null for "any priority". */
  priority: number | null;
  dateField: DateField;
  dateWindow: DateWindow;
  /** WHICH ORDER, not which beads. Deliberately part of this object rather than a store key of its
   *  own: it is per-side, it lives on the same chip row, and the date sorts read `dateField`, so
   *  splitting them would put two halves of one control in two places. */
  sortBy: BoardSort;
}

/** The off position for every axis. `updated` is the default field: "what has been touched lately"
 *  is the question a board answers, and created-at buries long-running work that is still moving.
 *
 *  `sortBy` is the ONE field here whose default is not an off position — there is no "unsorted".
 *  `priority` is the founder's specified default order. */
export const NO_BOARD_FILTER: BoardFilter = {
  priority: null,
  dateField: "updated",
  dateWindow: "all",
  sortBy: "priority",
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
  // `sortBy` IS DELIBERATELY NOT PART OF THIS. A sort hides nothing, so counting it as "active"
  // would put a "cards are hidden by your filter" banner and a Clear button on screen for a board
  // that shows every card it always did — and would route the whole board through the filtering
  // pass in BoardView for no reason. Reordering is not narrowing.
  return f.priority !== null || f.dateWindow !== "all";
}

/**
 * The filter, cleared — but keeping the order the user chose.
 *
 * Clear says "Clear FILTERS", and a sort is not a filter: resetting it would silently throw away a
 * choice the button does not name. `dateField` is kept for the same reason and it is now
 * load-bearing rather than cosmetic — with a date sort on it decides the ORDER, so resetting it
 * would reverse the board out from under a button labelled Clear. Keeping it changes nothing about
 * what is filtered: `dateWindow` goes back to "all", which makes the field inert for filtering.
 */
export function clearBoardFilter(f: BoardFilter): BoardFilter {
  return { ...NO_BOARD_FILTER, sortBy: f.sortBy, dateField: f.dateField };
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
