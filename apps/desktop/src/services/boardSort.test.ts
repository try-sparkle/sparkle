// apps/desktop/src/services/boardSort.test.ts
//
// ══ EVERY INPUT HERE IS SCRAMBLED OUT OF PRIORITY ORDER, ON PURPOSE ═══════════════════════════
// The board had NO comparator before this: it rendered `bd`'s output order verbatim, and bd
// happens to emit priorities non-decreasing. So a suite that fed a pre-sorted list would go green
// against a `sortBoardColumn` that did nothing at all — the same vacuous shape AGENTS.md names,
// where the assertion was already true before the change. Every fixture below is therefore built
// deliberately shuffled, and the expected order is written out in full rather than compared
// against the input.
import { describe, expect, it } from "vitest";
import { buildEpicIndex, type Bead } from "./beads";
import { emptyEpicBoard, type EpicBoard } from "./epicBoard";
import { sortBoardColumn, sortEpicBoard } from "./boardSort";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return {
    title: partial.id,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...partial,
  };
}

/** Ids in rendered order — the only thing any assertion here reads. */
const order = (beads: readonly Bead[]) => beads.map((b) => b.id);

// ── THE FIXTURE ─────────────────────────────────────────────────────────────────────────────
// Three priority bands, an epic and a task in each, and the two beads of each band adjacent so a
// comparator that only got the BANDS right (and left epic-ness alone) still fails.
//
// EPIC-NESS IS EXPRESSED BOTH WAYS THE RESOLVER ACCEPTS: `e0` is a structural epic (a child points
// at it) and `e1`/`e2` are typed epics. Mixing them is the point — the board's orange EPIC chip
// resolves through the same `isEpicIndexed`, so a sort that understood only one encoding would
// promote a strict SUBSET of the chipped cards and leave the rest sorting like tasks.
const e0 = bead({ id: "e0", priority: 0, updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" });
const e1 = bead({ id: "e1", priority: 1, type: "epic", updatedAt: "2026-02-01T00:00:00Z", createdAt: "2026-02-01T00:00:00Z" });
const e2 = bead({ id: "e2", priority: 2, type: "epic", updatedAt: "2026-03-01T00:00:00Z", createdAt: "2026-03-01T00:00:00Z" });
const t0 = bead({ id: "t0", priority: 0, updatedAt: "2026-04-01T00:00:00Z", createdAt: "2026-04-01T00:00:00Z" });
const t1 = bead({ id: "t1", priority: 1, updatedAt: "2026-05-01T00:00:00Z", createdAt: "2026-05-01T00:00:00Z" });
const t2 = bead({ id: "t2", priority: 2, updatedAt: "2026-06-01T00:00:00Z", createdAt: "2026-06-01T00:00:00Z" });
/** The child that makes `e0` a STRUCTURAL epic. It is a P3 task itself and sorts last everywhere. */
const kid = bead({ id: "kid", priority: 3, parent: "e0", updatedAt: "2026-07-01T00:00:00Z", createdAt: "2026-07-01T00:00:00Z" });

const ALL = [e2, t1, e0, t2, kid, e1, t0];
const INDEX = buildEpicIndex(ALL);

/** Deliberately not in priority order, and not in epic-then-task order either. */
const COLUMN: readonly Bead[] = [t2, e1, t0, e2, kid, e0, t1];

describe("sortBoardColumn — the founder's default: priority bands, epics first WITHIN each band", () => {
  it("interleaves P0 epic, P0 task, P1 epic, P1 task, P2 epic, P2 task", () => {
    expect(order(sortBoardColumn(COLUMN, "priority", "updated", INDEX))).toEqual([
      "e0", // P0 epic  — structural (its child points at it)
      "t0", // P0 task
      "e1", // P1 epic  — typed
      "t1", // P1 task
      "e2", // P2 epic  — typed
      "t2", // P2 task
      "kid", // P3 task
    ]);
  });

  // ── THE ASSERTION THAT TELLS `priority` APART FROM `type` ───────────────────────────────────
  // Stated separately from the sequence above because it is the ONE thing the founder corrected
  // this bead on: "epics show at the beginning of the priority list" is not "epics show above
  // everything". If PRIORITY ever stopped outranking epic-ness, the sequence test would still read
  // plausibly (it would just look like the `type` order) — this one names the pair that must not
  // swap, so the mistake cannot pass as a different-but-reasonable order.
  it("puts a P0 TASK above a P2 EPIC — priority outranks epic-ness", () => {
    const out = order(sortBoardColumn([e2, t0], "priority", "updated", INDEX));
    expect(out).toEqual(["t0", "e2"]);
  });

  it("orders by priority even when every card is an epic (and when every card is a task)", () => {
    expect(order(sortBoardColumn([e2, e0, e1], "priority", "updated", INDEX))).toEqual(["e0", "e1", "e2"]);
    expect(order(sortBoardColumn([t2, t0, t1], "priority", "updated", INDEX))).toEqual(["t0", "t1", "t2"]);
  });

  it("breaks a tie inside one band by MOST RECENTLY UPDATED first", () => {
    const stale = bead({ id: "stale", priority: 1, updatedAt: "2026-01-01T00:00:00Z" });
    const fresh = bead({ id: "fresh", priority: 1, updatedAt: "2026-09-01T00:00:00Z" });
    const mid = bead({ id: "mid", priority: 1, updatedAt: "2026-05-01T00:00:00Z" });
    const idx = buildEpicIndex([stale, fresh, mid]);
    expect(order(sortBoardColumn([stale, mid, fresh], "priority", "updated", idx))).toEqual([
      "fresh",
      "mid",
      "stale",
    ]);
  });

  // The tie-break reads `updated_at` in EVERY mode, including when the Created/Updated chip says
  // "created". The chip governs the DATE SORTS; letting it swing the default order too would make
  // the board reshuffle under a control documented as belonging to the date filter.
  it("uses updated_at for the tie-break even when the date field is 'created'", () => {
    const a = bead({ id: "a", priority: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
    const b = bead({ id: "b", priority: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" });
    const idx = buildEpicIndex([a, b]);
    expect(order(sortBoardColumn([a, b], "priority", "created", idx))).toEqual(["b", "a"]);
  });

  it("sorts a bead with NO priority last, below an explicit P4", () => {
    const none = bead({ id: "none" });
    const p4 = bead({ id: "p4", priority: 4 });
    const p0 = bead({ id: "p0", priority: 0 });
    const idx = buildEpicIndex([none, p4, p0]);
    expect(order(sortBoardColumn([none, p4, p0], "priority", "updated", idx))).toEqual([
      "p0",
      "p4",
      "none",
    ]);
  });
});

describe("sortBoardColumn — 'Type': all epics, then all tasks, priority-ordered within each", () => {
  it("promotes every epic above every task", () => {
    expect(order(sortBoardColumn(COLUMN, "type", "updated", INDEX))).toEqual([
      "e0",
      "e1",
      "e2", // every epic, in priority order …
      "t0",
      "t1",
      "t2",
      "kid", // … then every task, in priority order
    ]);
  });

  // The exact pair the `priority` mode orders the other way round. Together the two assertions pin
  // that these are genuinely DIFFERENT orders — one comparator wired to both options would fail
  // one of them.
  it("puts a P2 EPIC above a P0 TASK — the inverse of the priority mode", () => {
    expect(order(sortBoardColumn([t0, e2], "type", "updated", INDEX))).toEqual(["e2", "t0"]);
  });
});

describe("sortBoardColumn — the two date orders", () => {
  it("orders newest-first and oldest-first as exact reverses of each other", () => {
    expect(order(sortBoardColumn(COLUMN, "newest", "updated", INDEX))).toEqual([
      "kid",
      "t2",
      "t1",
      "t0",
      "e2",
      "e1",
      "e0",
    ]);
    expect(order(sortBoardColumn(COLUMN, "oldest", "updated", INDEX))).toEqual([
      "e0",
      "e1",
      "e2",
      "t0",
      "t1",
      "t2",
      "kid",
    ]);
  });

  // A DATE SORT IS NOT EPIC-AWARE, and that is the deliberate reading of a control labelled
  // "Date: Newest First": the top card is the newest, full stop. `t2` (a P2 TASK, updated June)
  // above `e0` (a P0 EPIC, updated January) is the assertion — under either epic-aware mode that
  // pair is the other way round.
  it("does NOT float epics — a newer task outranks an older epic", () => {
    expect(order(sortBoardColumn([e0, t2], "newest", "updated", INDEX))).toEqual(["t2", "e0"]);
  });

  it("reads whichever field the Created/Updated chip selects", () => {
    // Deliberately opposed: `old-created` was filed first but touched last.
    const a = bead({ id: "old-created", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" });
    const b = bead({ id: "new-created", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" });
    const idx = buildEpicIndex([a, b]);
    expect(order(sortBoardColumn([a, b], "newest", "created", idx))).toEqual(["new-created", "old-created"]);
    expect(order(sortBoardColumn([a, b], "newest", "updated", idx))).toEqual(["old-created", "new-created"]);
  });

  // UNKNOWN IS NOT "INFINITELY OLD". A bead bd gave us no readable date for sinks in BOTH
  // directions — answering "oldest first" with a row whose age nobody knows is a wrong answer, not
  // a conservative one.
  // TWO UNDATED ROWS, where the timestamp subtraction yields `NaN` (`-Infinity - (-Infinity)`).
  //
  // ── WHAT THIS DOES AND DOES NOT CLAIM ───────────────────────────────────────────────────────
  // It pins the OBSERVABLE contract — undated rows come back in input order, in every mode — and
  // that is worth pinning because `NaN` in a comparator is the kind of thing a later edit can turn
  // into a real reordering. It is NOT a guard on the input-position tiebreak: removing that
  // tiebreak leaves this green, because `NaN` coerces to `+0` and `sort` is stable per spec. Said
  // plainly so nobody reads a pass here as proof the tiebreak is exercised — see `NO_TIME`.
  it("keeps a DETERMINISTIC order between two undated beads", () => {
    const a = bead({ id: "undated-a" });
    const b = bead({ id: "undated-b" });
    const c = bead({ id: "undated-c" });
    const idx = buildEpicIndex([a, b, c]);
    for (const sort of ["newest", "oldest", "priority", "type"] as const) {
      // Input order, preserved — asserted for the SAME input twice so a merely-unstable sort that
      // happened to agree once cannot pass.
      expect(order(sortBoardColumn([c, a, b], sort, "updated", idx))).toEqual([
        "undated-c",
        "undated-a",
        "undated-b",
      ]);
      expect(order(sortBoardColumn([c, a, b], sort, "updated", idx))).toEqual(
        order(sortBoardColumn([c, a, b], sort, "updated", idx)),
      );
    }
  });

  it("sinks an undated bead to the bottom in BOTH directions", () => {
    const dated = bead({ id: "dated", updatedAt: "2026-05-01T00:00:00Z" });
    const missing = bead({ id: "missing" });
    const unparseable = bead({ id: "unparseable", updatedAt: "not-a-date" });
    const idx = buildEpicIndex([dated, missing, unparseable]);
    expect(order(sortBoardColumn([missing, unparseable, dated], "newest", "updated", idx))[0]).toBe("dated");
    expect(order(sortBoardColumn([missing, unparseable, dated], "oldest", "updated", idx))[0]).toBe("dated");
  });
});

describe("sortBoardColumn — array identity", () => {
  // `Card` is memoised and `Column` takes its beads as a prop, so minting an equal-but-new array
  // on every 5-second poll would re-render the whole board and undo the memoisation this repo
  // landed for exactly that stall.
  it("hands back the SAME array when nothing moves", () => {
    const already = [e0, t0, e1, t1, e2, t2, kid];
    expect(sortBoardColumn(already, "priority", "updated", INDEX)).toBe(already);
    const one = [t2];
    expect(sortBoardColumn(one, "priority", "updated", INDEX)).toBe(one);
  });

  it("returns a NEW array when the order really changes, leaving the input untouched", () => {
    const input = [t2, e0];
    const out = sortBoardColumn(input, "priority", "updated", INDEX);
    expect(out).not.toBe(input);
    expect(order(input)).toEqual(["t2", "e0"]); // the caller's array is not mutated
    expect(order(out)).toEqual(["e0", "t2"]);
  });
});

describe("sortEpicBoard — every ladder column, both modes", () => {
  function boardOf(col: readonly Bead[]): EpicBoard {
    const b = emptyEpicBoard();
    for (const key of Object.keys(b) as (keyof EpicBoard)[]) b[key] = [...col];
    return b;
  }

  // EVERY column, not just Backlog. The founder's ask is "each column", and a loop that stopped at
  // the first one would pass a test that only looked at Backlog. `planning` is in here too — it is
  // the Epics-only ladder's own column and the one a `Board`-shaped loop would silently miss.
  it("orders EVERY column of the ladder, including planning", () => {
    const sorted = sortEpicBoard(boardOf(COLUMN), "priority", "updated", ALL);
    const keys = Object.keys(sorted) as (keyof EpicBoard)[];
    expect(keys).toContain("planning");
    for (const key of keys) {
      expect(order(sorted[key])).toEqual(["e0", "t0", "e1", "t1", "e2", "t2", "kid"]);
    }
  });

  it("switches order with the sort, on every column", () => {
    const sorted = sortEpicBoard(boardOf(COLUMN), "type", "updated", ALL);
    for (const key of Object.keys(sorted) as (keyof EpicBoard)[]) {
      expect(order(sorted[key])).toEqual(["e0", "e1", "e2", "t0", "t1", "t2", "kid"]);
    }
  });

  // `allBeads` is the UNFILTERED store and is a different set from the beads being ordered: a bead
  // cannot tell you whether anything points at it. Here the column does NOT contain `kid`, so
  // `e0`'s epic-ness is knowable only from the wider list — sort against the column alone and `e0`
  // silently demotes to a task.
  it("resolves epic-ness against the whole store, not against the column", () => {
    const column = [t0, e0];
    const narrow = sortEpicBoard(boardOf(column), "type", "updated", ALL);
    expect(order(narrow.backlog)).toEqual(["e0", "t0"]);
  });
});
