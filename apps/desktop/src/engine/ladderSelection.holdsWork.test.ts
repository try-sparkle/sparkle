// The SECTION axis of "selection must agree with the column" (roborev 57842).
//
// `firstLadderRowId` exists because selection kept drifting from what the Build column renders —
// roborev 53411/53428/53439/53440/53858 all found the same class of bug through the STATUS-band
// axis. `local_none` opened a second axis: it sorts ABOVE `local_uncommitted`, so which row is
// "first" now depends on the worktree reading too. `holdsWorkOf` is optional, so a caller that drops
// it is not a type error and, before this file, not a test failure either.
import { describe, expect, it } from "vitest";
import { firstLadderRowId } from "./ladderSelection";
import { allBandsVisible } from "./buildSections";
import { crossRepoAccessors } from "./crossRepo";

const AGENTS = [
  { id: "dirty", kind: "build" as const, parentId: null },
  { id: "clean", kind: "build" as const, parentId: null },
];
// Both at the SAME stage — the worktree reading is the only thing that can separate them, which is
// what makes this a test of the accessor rather than of the ladder order.
const stageOf = () => "building_unsaved" as const;
const statusOf = () => "idle" as const;
const holdsWorkOf = (id: string) => (id === "clean" ? false : true);

describe("firstLadderRowId — the `local_none` rung moves what 'first' means", () => {
  it("picks the CLEAN row, because `local_none` sorts above `local_uncommitted`", () => {
    // `dirty` is first in the array, so a function ignoring sections entirely would return it.
    expect(
      firstLadderRowId(AGENTS, "build", stageOf, statusOf, allBandsVisible(), holdsWorkOf),
    ).toBe("clean");
  });

  it("without the accessor it returns the ARRAY-order row — the drift this guards", () => {
    // Not an endorsement: this pins what omitting the argument actually does, so the divergence from
    // the column is visible as a fact rather than discovered later as a mis-selection. The column
    // passes the accessor, so a caller here that does not disagrees with the screen.
    expect(firstLadderRowId(AGENTS, "build", stageOf, statusOf, allBandsVisible())).toBe("dirty");
  });

  it("an UNREAD row does not jump the queue", () => {
    // `undefined` keeps a row in `local_uncommitted`, so it cannot outrank a positively-clean row.
    expect(
      firstLadderRowId(AGENTS, "build", stageOf, statusOf, allBandsVisible(), () => undefined),
    ).toBe("dirty");
  });
});

// ── The SECOND section-axis rung: `tracked_elsewhere` (bead `sparkle-pgh1ue`) ────────────────────
//
// It is ladder SLOT 0 — above `local_none` and above everything else — so it moves "first" harder
// than `holdsWorkOf` does. `crossRepoOf` is an OPTIONAL trailing parameter, so deleting the argument
// at a call site is neither a type error nor, without this block, a test failure: the feature would
// silently revert to exactly the state roborev 67500 found, where selection pointed at a row the
// column was not rendering. Same paired shape as the tests above, and for the same reason.
describe("firstLadderRowId — the `tracked_elsewhere` rung sorts above everything", () => {
  const ROWS = [
    { id: "local", kind: "build" as const, parentId: null },
    { id: "elsewhere", kind: "build" as const, parentId: null },
  ];
  const BOUND = "drodio/sparkle";
  // Only the SECOND row is cross-repo, and it is second in array order — so a function that ignored
  // this axis would return `local`.
  const { head: crossRepoOf } = crossRepoAccessors(
    [
      { id: "local", parentId: null },
      { id: "elsewhere", parentId: null, task: "ship https://github.com/drodio/drodio-website" },
    ],
    BOUND,
  );

  it("picks the CROSS-REPO row, because `tracked_elsewhere` is ladder slot 0", () => {
    expect(
      firstLadderRowId(ROWS, "build", stageOf, statusOf, allBandsVisible(), () => false, crossRepoOf),
    ).toBe("elsewhere");
  });

  it("without the accessor it returns the ARRAY-order row — the drift this guards", () => {
    // Pins what omitting the argument actually does. The column passes it, so a caller that does not
    // disagrees with the screen — which is the whole failure `crossRepoAccessors` exists to end.
    expect(
      firstLadderRowId(ROWS, "build", stageOf, statusOf, allBandsVisible(), () => false),
    ).toBe("local");
  });

  it("outranks `local_none` specifically, not just array order", () => {
    // `local` is positively clean, so it sits in `local_none` — the rung that used to be the top.
    // The cross-repo row must still beat it, or slot 0 is not slot 0.
    expect(
      firstLadderRowId(ROWS, "build", stageOf, statusOf, allBandsVisible(), (id) => id === "local" ? false : undefined, crossRepoOf),
    ).toBe("elsewhere");
  });

  it("a row holding REAL at-risk edits is not dragged onto the unmeasurable rung", () => {
    // `holdsWork === true` outranks the cross-repo route, so this row stays in `local_uncommitted`
    // and `local` (positively clean → `local_none`) wins instead.
    expect(
      firstLadderRowId(ROWS, "build", stageOf, statusOf, allBandsVisible(), (id) => id === "elsewhere" ? true : false, crossRepoOf),
    ).toBe("local");
  });
});
