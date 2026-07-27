import { describe, expect, it } from "vitest";
import { expandOnGrowth, workerCounts } from "./workerExpansion";

describe("expandOnGrowth — which orchestrators auto-expand", () => {
  it("expands a parent that gained a worker", () => {
    expect(expandOnGrowth({ p1: 1 }, { p1: 2 })).toEqual(["p1"]);
  });

  it("expands a parent that gained its FIRST worker", () => {
    expect(expandOnGrowth({ p1: 0 }, { p1: 1 })).toEqual(["p1"]);
  });

  // The load-bearing case. On boot the previous counts are empty, so EVERY parent would look like
  // it "gained" workers — which would silently expand every orchestrator on every relaunch and make
  // the persisted collapse choice worthless. First sighting is a baseline, not growth.
  it("does NOT expand on first observation, so a relaunch respects the persisted collapse", () => {
    expect(expandOnGrowth({}, { p1: 3, p2: 1 })).toEqual([]);
  });

  it("does not expand on spin-down", () => {
    expect(expandOnGrowth({ p1: 2 }, { p1: 1 })).toEqual([]);
  });

  it("does not expand when nothing changed", () => {
    expect(expandOnGrowth({ p1: 2 }, { p1: 2 })).toEqual([]);
  });

  // A user who collapsed a busy orchestrator must stay collapsed while it churns, or a fan-out
  // would fight them on every tick.
  it("expands only the parent that grew, leaving its siblings alone", () => {
    expect(expandOnGrowth({ p1: 1, p2: 1, p3: 1 }, { p1: 1, p2: 2, p3: 1 })).toEqual(["p2"]);
  });

  it("expands several parents when several grew", () => {
    expect(expandOnGrowth({ p1: 0, p2: 0 }, { p1: 1, p2: 1 }).sort()).toEqual(["p1", "p2"]);
  });

  // A parent that disappears (closed) must not throw or report anything.
  it("ignores a parent present only in the previous snapshot", () => {
    expect(expandOnGrowth({ p1: 2 }, {})).toEqual([]);
  });
});

describe("workerCounts — the snapshot expandOnGrowth compares", () => {
  it("counts workers by parent, and records a childless orchestrator as 0", () => {
    const agents = [
      { id: "p1", kind: "build" as const, parentId: null },
      { id: "w1", kind: "worker" as const, parentId: "p1" },
      { id: "w2", kind: "worker" as const, parentId: "p1" },
      { id: "p2", kind: "build" as const, parentId: null },
    ];
    // p2's explicit 0 is what lets its FIRST worker read as growth later. Omitting it is roborev
    // 53672-High: the first spawn under any parent would be misread as a first sighting.
    expect(workerCounts(agents)).toEqual({ p1: 2, p2: 0 });
  });

  // The regression above, stated end-to-end through both functions rather than as a shape.
  it("makes a parent's FIRST worker read as growth", () => {
    const before = workerCounts([{ id: "p1", kind: "build" as const, parentId: null }]);
    const after = workerCounts([
      { id: "p1", kind: "build" as const, parentId: null },
      { id: "w1", kind: "worker" as const, parentId: "p1" },
    ]);
    expect(expandOnGrowth(before, after)).toEqual(["p1"]);
  });

  // Order is not guaranteed — the disk reconcile can adopt a worker before its parent — so seeding
  // the zeros must not clobber a count already accumulated.
  it("survives a worker appearing before its parent in the array", () => {
    const agents = [
      { id: "w1", kind: "worker" as const, parentId: "p1" },
      { id: "p1", kind: "build" as const, parentId: null },
    ];
    expect(workerCounts(agents)).toEqual({ p1: 1 });
  });

  // A shell nested under a build is not a worker and must not inflate the count — otherwise its
  // parent would auto-expand for something the subtree never renders as a worker row.
  it("does not count a non-worker child", () => {
    const agents = [
      { id: "p1", kind: "build" as const, parentId: null },
      { id: "s1", kind: "shell" as const, parentId: "p1" },
    ];
    expect(workerCounts(agents)).toEqual({ p1: 0 });
  });

  it("gives a parentless worker no entry rather than an 'undefined' bucket", () => {
    const agents = [{ id: "w1", kind: "worker" as const, parentId: null }];
    expect(workerCounts(agents)).toEqual({});
  });

  it("is empty for no agents", () => {
    expect(workerCounts([])).toEqual({});
  });
});
