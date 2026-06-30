import { describe, it, expect } from "vitest";
import {
  beadLifecycleActions,
  beadTargetLevel,
  levelAfter,
  BEAD_LEVEL,
  type BeadLifecycleInputs,
} from "./beadLifecycle";

const input = (o: Partial<BeadLifecycleInputs>): BeadLifecycleInputs => ({
  kind: "build",
  hasBead: false,
  hasRealWork: true,
  stage: "building_unsaved",
  writtenLevel: 0,
  ...o,
});

describe("beadTargetLevel", () => {
  it("maps stages to lifecycle levels", () => {
    expect(beadTargetLevel("planned")).toBe(BEAD_LEVEL.none);
    expect(beadTargetLevel("building_unsaved")).toBe(BEAD_LEVEL.in_progress);
    expect(beadTargetLevel("building_saved")).toBe(BEAD_LEVEL.in_progress);
    expect(beadTargetLevel("pushed")).toBe(BEAD_LEVEL.in_progress);
    expect(beadTargetLevel("pull_request")).toBe(BEAD_LEVEL.in_progress);
    expect(beadTargetLevel("merged")).toBe(BEAD_LEVEL.closed);
    expect(beadTargetLevel("shipped")).toBe(BEAD_LEVEL.delivered);
  });
});

describe("beadLifecycleActions — auto-create gating", () => {
  it("build agent, no bead, first real work → create + in_progress", () => {
    expect(beadLifecycleActions(input({ hasBead: false }))).toEqual(["create", "in_progress"]);
  });
  it("no real work → no bead created (an opened-then-abandoned agent leaves none)", () => {
    expect(beadLifecycleActions(input({ hasBead: false, hasRealWork: false }))).toEqual([]);
  });
  it("a worker with no bead does NOT auto-create (only build agents do)", () => {
    expect(beadLifecycleActions(input({ kind: "worker", hasBead: false }))).toEqual([]);
  });
  it("a planning-only stage yields nothing even with real work", () => {
    expect(beadLifecycleActions(input({ stage: "planned" }))).toEqual([]);
  });
  it("jumping straight to merged with no bead → create + closed (no in_progress)", () => {
    expect(beadLifecycleActions(input({ hasBead: false, stage: "merged" }))).toEqual([
      "create",
      "closed",
    ]);
  });
});

describe("beadLifecycleActions — monotonic, forward-only (with a bead)", () => {
  it("building + nothing written → in_progress", () => {
    expect(beadLifecycleActions(input({ hasBead: true, writtenLevel: 0 }))).toEqual(["in_progress"]);
  });
  it("building + already in_progress → no double write", () => {
    expect(beadLifecycleActions(input({ hasBead: true, writtenLevel: 1 }))).toEqual([]);
  });
  it("merged + was in_progress → closed", () => {
    expect(beadLifecycleActions(input({ hasBead: true, stage: "merged", writtenLevel: 1 }))).toEqual(
      ["closed"],
    );
  });
  it("merged + already closed → nothing (a re-climbing new cycle can't re-close)", () => {
    expect(beadLifecycleActions(input({ hasBead: true, stage: "merged", writtenLevel: 2 }))).toEqual(
      [],
    );
  });
  it("shipped → delivered only (subsumes closed; never re-opens with in_progress on relaunch)", () => {
    // writtenLevel 0 simulates a fresh boot first observing already-shipped work.
    expect(beadLifecycleActions(input({ hasBead: true, stage: "shipped", writtenLevel: 0 }))).toEqual(
      ["delivered"],
    );
  });
  it("shipped + already delivered → nothing", () => {
    expect(
      beadLifecycleActions(input({ hasBead: true, stage: "shipped", writtenLevel: 3 })),
    ).toEqual([]);
  });
});

describe("levelAfter", () => {
  it("maps a status action to the level it establishes; create establishes nothing", () => {
    expect(levelAfter("create")).toBe(BEAD_LEVEL.none);
    expect(levelAfter("in_progress")).toBe(BEAD_LEVEL.in_progress);
    expect(levelAfter("closed")).toBe(BEAD_LEVEL.closed);
    expect(levelAfter("delivered")).toBe(BEAD_LEVEL.delivered);
  });
});
