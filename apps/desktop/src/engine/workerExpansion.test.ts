import { describe, expect, it } from "vitest";
import {
  expandOnGrowth,
  expandOnRedWorker,
  redWorkerCounts,
  workerCounts,
} from "./workerExpansion";
import type { AgentTabStatus } from "../types";

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

describe("redWorkerCounts — how many workers under each parent are painted red", () => {
  const agents = [
    { id: "p1", kind: "build" as const, parentId: null },
    { id: "w1", kind: "worker" as const, parentId: "p1" },
    { id: "w2", kind: "worker" as const, parentId: "p1" },
    { id: "p2", kind: "build" as const, parentId: null },
  ];
  const statuses = (m: Record<string, AgentTabStatus>) => (id: string) => m[id] ?? "stopped";

  it("counts only the red ones", () => {
    expect(redWorkerCounts(agents, statuses({ w1: "waiting", w2: "working" }))).toEqual({
      p1: 1,
      p2: 0,
    });
  });

  // The explicit zero is load-bearing: expandOnRedWorker skips ids it has never seen, so a parent
  // omitted while calm would have its FIRST red worker read as a first sighting and stay folded —
  // the one case the whole expansion exists for.
  it("gives a calm parent an explicit zero rather than no entry", () => {
    expect(redWorkerCounts(agents, statuses({ w1: "working", w2: "idle" }))).toEqual({
      p1: 0,
      p2: 0,
    });
  });

  // `blocked` is RED in AGENT_STATUS but is NOT in `needsAttention` — asking the wrong predicate
  // here is the bug that shipped twice, leaving a blocked worker unable to surface on its parent.
  it("counts a BLOCKED worker, which needsAttention would have missed", () => {
    expect(redWorkerCounts(agents, statuses({ w1: "blocked" }))).toEqual({ p1: 1, p2: 0 });
  });

  // `unmerged` is GRAY on purpose — a landing state, not an alarm. It went gray after 27 of 51
  // agents sat in that band and made red meaningless; re-escalating it here would rebuild that.
  it("does not count an unmerged worker as red", () => {
    expect(redWorkerCounts(agents, statuses({ w1: "unmerged", w2: "done" }))).toEqual({
      p1: 0,
      p2: 0,
    });
  });
});

describe("expandOnRedWorker — a worker going red pops its parent open, ONCE", () => {
  it("fires on the transition from no reds to one", () => {
    expect(expandOnRedWorker({ p1: 0 }, { p1: 1 })).toEqual(["p1"]);
  });

  // Already open-worthy and still is: re-firing every render would re-expand a subtree the user
  // folded on purpose, which is the behavior the transition gate exists to avoid.
  it("does not fire again while the count merely grows", () => {
    expect(expandOnRedWorker({ p1: 1 }, { p1: 2 })).toEqual([]);
  });

  it("does not fire while the count holds steady", () => {
    expect(expandOnRedWorker({ p1: 2 }, { p1: 2 })).toEqual([]);
  });

  it("does not fire when reds clear", () => {
    expect(expandOnRedWorker({ p1: 2 }, { p1: 0 })).toEqual([]);
  });

  // On boot the previous snapshot is empty. Without this, every parent with an already-red worker
  // would look like a fresh transition and blow open on every relaunch.
  it("treats a first sighting as a baseline, not a transition", () => {
    expect(expandOnRedWorker({}, { p1: 3 })).toEqual([]);
  });

  it("reports each parent that turned, and only those", () => {
    expect(
      expandOnRedWorker({ p1: 0, p2: 1, p3: 0 }, { p1: 1, p2: 2, p3: 0 }),
    ).toEqual(["p1"]);
  });
});
