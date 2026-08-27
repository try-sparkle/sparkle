// @vitest-environment jsdom
// ── THE ONE BOARD FLATTEN, AND THE COLUMNS A HAND-LISTED ONE FORGETS ─────────────────────────
//
// `Board` has six columns. Every module that wants "all the beads on this board" used to write its
// own spread over the columns it happened to remember, and `epicDecompose.boardBeads` remembered
// four — `blocked` and `archived` were missing (bead sparkle-m3340n). The result type is `Bead[]`
// either way, so the type system could not see the omission, and the flattened list is the SOLE
// input to that module's membership (`childrenOf`) and candidate (`pickEpicsToDecompose`,
// `pickStuckDecomposing`) queries. A column left out is therefore a set of beads that provably do
// not exist to the whole module, in two opposite directions:
//
//   • UNREACHABLE CANDIDATE — an epic sitting in an omitted column can never be picked. Inert, but
//     it silently disables the pipeline for exactly the population it exists to rescue.
//   • PHANTOM-EMPTY PARENT — a parent whose only children sit in an omitted column reads as
//     childless, so it is eligible for a SECOND paid rebuild and grows a duplicate child set. This
//     direction SPENDS money, which is why it is the one that matters.
//
// WHAT THIS FILE ASSERTS, and what it deliberately does not. "The `blocked` key exists on `Board`"
// is the vacuous shape here — it was already true while the bug was live. So every case below ends
// at a real query answering differently, or at the flatten returning a bead it would otherwise have
// dropped. The column list is derived FROM THE TYPE (`BOARD_COLUMNS`), so the last case is about a
// SEVENTH column: it asserts the flatten reads every column the type declares, which is what stops
// this bug from being re-introduced by the next person who adds one.
import { describe, expect, it } from "vitest";
import {
  allBoardBeads,
  ARCHIVED_LABEL,
  BOARD_COLUMNS,
  bucketBeads,
  DELIVERED_LABEL,
  STALLED_LABEL,
  type Bead,
  type Board,
  type BoardColumn,
} from "./beads";
import {
  DECOMPOSE_REQUESTED_LABEL,
  DECOMPOSING_LABEL,
  pickEpicsToDecompose,
  pickStuckDecomposing,
} from "./epicDecompose";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return {
    title: partial.id,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...partial,
  };
}

/** One bead per column, each routed there by the REAL `columnFor` rules rather than placed by
 *  hand — so the fixture cannot claim a column the bucketer would not actually use. */
const ONE_PER_COLUMN: Record<BoardColumn, Bead> = {
  backlog: bead({ id: "in-backlog" }),
  blocked: bead({ id: "in-blocked", labels: [STALLED_LABEL] }),
  inProgress: bead({ id: "in-inProgress", status: "in_progress" }),
  done: bead({ id: "in-done", status: "closed" }),
  delivered: bead({ id: "in-delivered", status: "closed", labels: [DELIVERED_LABEL] }),
  archived: bead({ id: "in-archived", status: "closed", labels: [ARCHIVED_LABEL] }),
};

describe("allBoardBeads — every column, derived from the Board type", () => {
  it("returns a bead from EVERY column, including the two the old flatten dropped", () => {
    const board = bucketBeads(Object.values(ONE_PER_COLUMN));
    // The side effect: the flattened list. A four-column flatten returns four of these six.
    expect(allBoardBeads(board).map((b) => b.id).sort()).toEqual(
      ["in-archived", "in-backlog", "in-blocked", "in-delivered", "in-done", "in-inProgress"],
    );
  });

  it("reads every column the TYPE declares — a seventh column is included with no edit here", () => {
    // The anti-regression case, and the reason `BOARD_COLUMNS` exists rather than a spread. The
    // board is BUILT from the type's own column list, so adding a column to `BoardColumn` grows
    // this expectation automatically and a flatten that hand-lists its columns reds immediately.
    const synthetic = Object.fromEntries(
      BOARD_COLUMNS.map((column) => [column, [bead({ id: `only-in-${column}` })]]),
    ) as unknown as Board;
    expect(allBoardBeads(synthetic).map((b) => b.id)).toEqual(
      BOARD_COLUMNS.map((column) => `only-in-${column}`),
    );
  });

  it("covers exactly the columns the bucketer produces — neither more nor fewer", () => {
    // `BOARD_COLUMNS` is `satisfies Record<BoardColumn, true>`, so a column ADDED to the type fails
    // to compile until it is listed. This is the other half — a column REMOVED from `bucketBeads`,
    // or a stray key in the list, which the type alone would not catch.
    expect([...BOARD_COLUMNS].sort()).toEqual(Object.keys(bucketBeads([])).sort());
  });
});

// ── THE QUERIES, THROUGH THE REAL PICKERS ────────────────────────────────────────────────────
// `epicDecomposeRequest.test.ts` already pins the `blocked` column in both directions. What was
// untested is `archived` — and the crash-recovery picker, which has no status clause and so is the
// ONE query that can legitimately reach a closed bead in either omitted column.
describe("the decompose queries see the previously-omitted columns", () => {
  it("does NOT re-decompose a parent whose only child was ARCHIVED — the paid direction", () => {
    // The expensive half of the bug. `columnFor` routes a closed bead carrying `archived` out of
    // `done` and into its own column, and the founder's low-signal sweep closes ~1,800 beads that
    // way — so an epic whose plan has been archived is a COMMON shape, not an edge case. With
    // `archived` omitted from the flatten the child is invisible, the epic reads as hollow, and the
    // watcher fires a second paid AI call that files a duplicate set of children under it.
    const epic = bead({ id: "e1", type: "epic", labels: [DECOMPOSE_REQUESTED_LABEL] });
    const child = bead({
      id: "e1.1",
      parent: "e1",
      status: "closed",
      labels: [ARCHIVED_LABEL],
    });
    const board = bucketBeads([epic, child]);
    expect(board.archived.map((b) => b.id)).toEqual(["e1.1"]);
    expect(pickEpicsToDecompose(board)).toEqual([]);
  });

  it("still picks the SAME epic once that archived child is gone — the paired control", () => {
    // Without this, the case above passes for a picker that returns nothing at all. Same epic,
    // same board shape, one bead removed: the answer must flip.
    const epic = bead({ id: "e1", type: "epic", labels: [DECOMPOSE_REQUESTED_LABEL] });
    expect(pickEpicsToDecompose(bucketBeads([epic])).map((b) => b.id)).toEqual(["e1"]);
  });

  it("reclaims a stale `decomposing` epic from the ARCHIVED and BLOCKED columns", () => {
    // Crash recovery has no status clause, so it is the query that genuinely reaches both omitted
    // columns. A `decomposing` label that survives a crash is stale by definition; left unread it
    // never clears, and the epic is excluded from every future pick by its own guard label.
    const archivedEpic = bead({
      id: "e-arch",
      type: "epic",
      status: "closed",
      labels: [DECOMPOSING_LABEL, ARCHIVED_LABEL],
    });
    const blockedEpic = bead({
      id: "e-blocked",
      type: "epic",
      labels: [DECOMPOSING_LABEL, STALLED_LABEL],
    });
    const board = bucketBeads([archivedEpic, blockedEpic]);
    expect(board.archived.map((b) => b.id)).toEqual(["e-arch"]);
    expect(board.blocked.map((b) => b.id)).toEqual(["e-blocked"]);
    expect(pickStuckDecomposing(board).map((b) => b.id).sort()).toEqual(["e-arch", "e-blocked"]);
  });
});
