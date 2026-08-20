// apps/desktop/src/services/boardSort.ts
//
// THE PLAN BOARD'S CARD ORDER, as pure functions. Kept out of BoardView for the same reason
// `boardFilters` beside it is: the interesting behaviour is entirely about which bead lands above
// which, and that is a question about data, not about React.
//
// ══ THIS IS THE COMPARATOR THAT HAS NEVER EXISTED — IT DOES NOT ADD A TIEBREAK TO ONE ═════════
// Before this file, the board did NO sorting at any layer. `bucketBeads` pushes each bead into a
// column in input order, `bucketEpics` filters in input order, and `BoardView` renders
// `beads.slice(0, cap)` verbatim. A repo-wide grep for `sort` across planBoard, BoardView,
// epicBoard, boardFilters and beadsStore returned two comments and no comparator, and
// `beadsStore` states the invariant outright: "bucketBeads preserves input order within each
// column and the board RENDERS that order."
//
// The P0-first board the founder likes was `bd`'s own default output leaking through. Measured
// against a 7,779-row store: priorities are non-decreasing across the whole list with ZERO
// inversions — but WITHIN a band the order is arbitrary (`updated_at` is neither ascending nor
// descending, `created_at` is not ascending either). So the behaviour he relies on was real and
// completely undefended: no test in this repo went red if bd changed its default order.
//
// CONSEQUENCE FOR ANYONE EDITING THIS FILE: the priority ordering is OWNED here now, not
// inherited. `boardSort.test.ts` feeds every comparator an input deliberately scrambled out of
// priority order, so a comparator that quietly stopped ordering by priority cannot pass by having
// bd hand it a pre-sorted list.
import { epicIndexOf, isEpicIndexed, type Bead, type EpicIndex } from "./beads";
import { isDateSort, type BoardSort, type DateField } from "./boardFilters";
import { EPIC_LADDER, type EpicBoard } from "./epicBoard";

/**
 * Where a bead with NO priority sorts.
 *
 * LAST, in every priority-aware mode. bd emits 0-4 on essentially every row, so a missing one
 * means the data is odd, not that the work is urgent — and defaulting the other way would float
 * every malformed row above the founder's real P0s. Deliberately not `4`: a bead with no priority
 * at all is a different fact from one explicitly filed at P4, and collapsing them would make the
 * two indistinguishable in the order.
 */
const NO_PRIORITY = Number.MAX_SAFE_INTEGER;

/**
 * One card, with every ordering key resolved ONCE.
 *
 * ══ WHY DECORATE-SORT-UNDECORATE AND NOT A COMPARATOR THAT ASKS QUESTIONS ═════════════════════
 * `Array.prototype.sort` calls its comparator O(n log n) times — on the founder's 3,117-card
 * Backlog that is ~36,000 calls. Resolving epic-ness inside the compare would run the epic lookup
 * twice per call, ~72,000 times per column per render. That is the shape of the OPEN P0
 * `sparkle-nkoxqs` ("clicking an epic freezes the UI ~4.5s: quadratic childrenOf/isEpic scan over
 * the 7,300-bead store blocks the WebContent main thread"), and with the NAIVE `isEpic` — which
 * walks the whole store per call — it would be a strictly worse version of it: 72,000 x 7,300.
 *
 * So every key is a SCALAR computed once per card, and the comparators below do nothing but
 * subtract numbers. The epic lookup runs exactly n times, against the shared index.
 */
interface Row {
  bead: Bead;
  /** 0 for an epic, 1 for a task — so plain ASCENDING order puts epics first. */
  epic: 0 | 1;
  /** bd priority, or {@link NO_PRIORITY}. Ascending: P0 at the top. */
  priority: number;
  /** 0 when {@link time} is a real timestamp, 1 when the bead carries no readable date. Ascending
   *  first, so an unreadable date sinks to the bottom in BOTH date directions — see below. */
  undated: 0 | 1;
  /** The date sorts' key, read from whichever field the Created/Updated chip selects. */
  time: number;
  /** `updated_at`, the tie-break inside a priority band. Always this field, never the chip's:
   *  the founder chose "most recently updated first" for the tie-break as a separate answer from
   *  which field the DATE SORTS read, and letting the chip swing it would make the default order
   *  change under a control that is documented as belonging to the date filter. */
  updated: number;
  /** Input position — the FINAL tie-break, which is what makes every comparator here a TOTAL
   *  order. Without it two cards identical on every key would be ordered by the engine's internal
   *  sort stability, which is guaranteed by spec but is not something a test can state. */
  i: number;
}

/**
 * A timestamp bd could not give us.
 *
 * ══ IT DOES NOT KEEP THE SUBTRACTION TOTAL — TWO UNDATED ROWS STILL YIELD `NaN` ═══════════════
 * `-Infinity - (-Infinity)` is `NaN`, so `b.time - a.time` is `NaN` whenever BOTH rows are
 * undated. That is harmless here, but only because of two things that are easy to read past, so
 * they are written down rather than left to be rediscovered:
 *   1. `NaN` is FALSY, so the `||` chains below fall through it to `a.i - b.i` and the comparator
 *      never actually hands `sort` a `NaN`.
 *   2. Even if one did, the spec coerces a `NaN` comparator result to `+0` ("equal"), and
 *      `Array.prototype.sort` has been stable since ES2019 — so the input order would survive.
 * So the input-position tiebreak is NOT load-bearing for determinism; it makes the total order
 * EXPLICIT instead of resting on those two subtleties. Keep it for that reason, not because
 * removing it would visibly break something — it would not, which is exactly why a reader should
 * be told before they "simplify" it.
 *
 * What `-Infinity` DOES buy is the mixed case: dated vs undated subtracts to ±Infinity with the
 * right sign, so a dated row beats an undated one even before `undated` is consulted.
 */
const NO_TIME = -Infinity;

function parseTime(raw: string | undefined): number {
  if (raw === undefined || raw === "") return NO_TIME;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? NO_TIME : t;
}

function decorate(
  beads: readonly Bead[],
  index: EpicIndex,
  dateField: DateField,
  needsTime: boolean,
): Row[] {
  // `for…of` with a hand-kept index rather than `beads[i]`: this package compiles with
  // `noUncheckedIndexedAccess`, so an indexed read is `Bead | undefined` and every field access
  // below would need a non-null assertion that says nothing true.
  const rows: Row[] = [];
  let i = 0;
  for (const bead of beads) {
    const updated = parseTime(bead.updatedAt);
    // Only parsed when a DATE sort will read it. The priority and type modes never touch `time`,
    // and `Date.parse` over ~7,000 beads on every poll is real work to skip.
    const time = !needsTime
      ? NO_TIME
      : dateField === "created"
        ? parseTime(bead.createdAt)
        : updated;
    rows.push({
      bead,
      // ── THE ONE PLACE THIS FILE ASKS "IS THIS AN EPIC", AND IT ASKS THE SHARED RESOLVER ──────
      // `isEpicIndexed`, never the naive `isEpic` and never a fourth condition of our own. Epic
      // membership has ONE definition in this codebase (`services/beads.ts`, guarded by
      // `scripts/lib/epic-membership-guard.sh`) precisely because it previously had three, and the
      // failure mode here is the worst version of that drift: a card that renders the orange EPIC
      // chip — which `Card` resolves through this same call — while sorting like a task.
      epic: isEpicIndexed(index, bead) ? 0 : 1,
      priority: bead.priority ?? NO_PRIORITY,
      undated: time === NO_TIME ? 1 : 0,
      time,
      updated,
      i,
    });
    i++;
  }
  return rows;
}

/**
 * THE FOUNDER'S DEFAULT: P0 epics, P0 tasks, P1 epics, P1 tasks, P2 epics, P2 tasks, …
 *
 * Verbatim: "we should have p zero epics show first and then all the p zero tasks and then p one
 * epics would show below that. Each column, and then all the p one tasks, etcetera. So epics
 * basically show at the beginning of the priority list."
 *
 * PRIORITY OUTRANKS EPIC-NESS, and that is the whole distinction from {@link byType} below. A P2
 * epic sorts BELOW a P0 task here. Reading "epics show at the beginning" as "epics show above
 * everything" is the mis-reading this bead was originally filed under; it is a real behaviour the
 * founder wants available, which is why it is the `type` option rather than absent.
 */
function byPriority(a: Row, b: Row): number {
  return (
    a.priority - b.priority ||
    a.epic - b.epic ||
    // Most recently updated first, inside the band. The founder's answer to "what breaks a tie
    // among all the P0 epics" — it puts the work that is actually moving at the top of each band.
    b.updated - a.updated ||
    a.i - b.i
  );
}

/** ALL epics, then all tasks — each group in priority order. The epics-above-everything reading,
 *  offered as one option of four rather than as the default. */
function byType(a: Row, b: Row): number {
  return a.epic - b.epic || a.priority - b.priority || b.updated - a.updated || a.i - b.i;
}

/**
 * Pure date order, newest first — and DELIBERATELY NOT epic-aware.
 *
 * The option is labelled "Date: Newest First", so a user who picks it gets a column ordered by
 * date and nothing else; floating epics inside it would mean the top card is not the newest and
 * the label is a lie. The two epic-aware orders are the other two options, which is the whole
 * reason there are four.
 *
 * UNDATED ROWS SINK IN BOTH DIRECTIONS — they are not "infinitely old", they are UNKNOWN, and
 * "oldest first" must not answer a question about age with a row whose age nobody knows.
 */
function byNewest(a: Row, b: Row): number {
  return a.undated - b.undated || b.time - a.time || a.i - b.i;
}

/** Pure date order, oldest first. See {@link byNewest} for why undated rows sink here too. */
function byOldest(a: Row, b: Row): number {
  return a.undated - b.undated || a.time - b.time || a.i - b.i;
}

const COMPARATORS: Record<BoardSort, (a: Row, b: Row) => number> = {
  priority: byPriority,
  type: byType,
  newest: byNewest,
  oldest: byOldest,
};

/**
 * ONE COLUMN, ORDERED — and the SAME ARRAY back when the order does not change.
 *
 * ══ IDENTITY IS LOAD-BEARING, NOT AN OPTIMISATION ═════════════════════════════════════════════
 * `Card` is `React.memo`'d and `Column` receives its beads as a prop, so a fresh array every time
 * this runs makes every card's props new on every 5-second poll and re-renders the whole board —
 * defeating the memoisation landed for exactly that stall. Handing back the input array when
 * nothing moved covers the columns that are already in order; {@link sortEpicBoard}'s cache covers
 * the ones that genuinely reorder, which under the DEFAULT sort is most of them.
 */
export function sortBoardColumn(
  beads: readonly Bead[],
  sort: BoardSort,
  dateField: DateField,
  index: EpicIndex,
): readonly Bead[] {
  if (beads.length < 2) return beads;
  const rows = decorate(beads, index, dateField, isDateSort(sort));
  rows.sort(COMPARATORS[sort]);
  // Already in order? Hand the caller its own array back rather than an equal copy.
  const out: Bead[] = [];
  let moved = false;
  let at = 0;
  for (const row of rows) {
    if (row.i !== at) moved = true;
    out.push(row.bead);
    at++;
  }
  return moved ? out : beads;
}

/**
 * The sorted columns for one snapshot + one sort, CACHED on the identity of the column array.
 *
 * Three levels, each weak where it can be, so nothing here outlives the snapshot it describes:
 * the {@link EpicIndex} (which `epicIndexOf` already ties to one `allBeads` identity), then the
 * column array, then the `sort|dateField` pair. Keying on the index as well as the array is what
 * keeps a column whose identity survived a store change from being served an order computed
 * against the OLD epic membership.
 */
const SORTED = new WeakMap<EpicIndex, WeakMap<readonly Bead[], Map<string, readonly Bead[]>>>();

function sortCached(
  beads: readonly Bead[],
  sort: BoardSort,
  dateField: DateField,
  index: EpicIndex,
): readonly Bead[] {
  let perIndex = SORTED.get(index);
  if (!perIndex) {
    perIndex = new WeakMap();
    SORTED.set(index, perIndex);
  }
  let perColumn = perIndex.get(beads);
  if (!perColumn) {
    perColumn = new Map();
    perIndex.set(beads, perColumn);
  }
  // The field only participates when a date sort reads it, so switching Created/Updated does not
  // mint a second cache entry for an order that would be identical.
  const key = isDateSort(sort) ? `${sort}|${dateField}` : sort;
  const hit = perColumn.get(key);
  if (hit) return hit;
  const out = sortBoardColumn(beads, sort, dateField, index);
  perColumn.set(key, out);
  return out;
}

/**
 * Every column of the board, ordered — the one entry point BoardView calls.
 *
 * IT COVERS BOTH MODES, and that is a requirement rather than a convenience: the default
 * Tasks+Epics board comes through `withPlanning(displayBoard)` and the Epics-only ladder comes
 * through `bucketEpics`, neither of which sorts. Applying this to the finished `EpicBoard` — after
 * the kind toggles, the agent filter and the priority/date filter have all had their say — is what
 * makes one implementation serve every mode instead of one per path.
 *
 * `allBeads` is the UNFILTERED store and is a different set from the beads being ordered, for the
 * same reason `bucketEpics` needs it: a bead cannot tell you whether anything points at it, so
 * asking epic-ness against a filtered list would demote an epic whose children a filter hid.
 */
export function sortEpicBoard(
  board: EpicBoard,
  sort: BoardSort,
  dateField: DateField,
  allBeads: readonly Bead[],
): EpicBoard {
  // CACHED, not `buildEpicIndex` — the same `allBeads` identity every Card resolves through, so a
  // direct build here would pay a second full O(n) walk of a store the cache already holds.
  const index = epicIndexOf(allBeads);
  const out = {} as EpicBoard;
  // Driven by the LADDER's own key list so a column added there cannot be silently left unsorted.
  for (const key of EPIC_LADDER) {
    // THE CAST HANDS OUT A CACHED ARRAY, SO THE CALLER MUST NOT MUTATE IT. `EpicBoard`'s published
    // type is a mutable `Bead[]`, but these arrays are shared with the cache above and with the
    // caller's own input when nothing moved — an in-place `sort()`/`push()` on one would corrupt
    // every later render, not just this one. Every consumer today only reads (`BoardView` does
    // `beads.slice(0, cap)` and `beads.length`); keep it that way, or copy first.
    out[key] = sortCached(board[key], sort, dateField, index) as Bead[];
  }
  return out;
}
