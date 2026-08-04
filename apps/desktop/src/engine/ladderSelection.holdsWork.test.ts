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
