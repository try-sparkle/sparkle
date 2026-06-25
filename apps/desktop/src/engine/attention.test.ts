import { describe, it, expect } from "vitest";
import {
  needsAttention,
  countAttention,
  newlyNeedingAttention,
  type StatusMap,
} from "./attention";

describe("needsAttention", () => {
  it("is true only for the red statuses (waiting, approval)", () => {
    expect(needsAttention("waiting")).toBe(true);
    expect(needsAttention("approval")).toBe(true);
  });

  it("is false for every non-red status and for undefined", () => {
    for (const s of ["working", "idle", "blocked", "errored", "done", "stopped"] as const) {
      expect(needsAttention(s)).toBe(false);
    }
    expect(needsAttention(undefined)).toBe(false);
  });
});

describe("countAttention", () => {
  const status: StatusMap = {
    a: "waiting",
    b: "working",
    c: "approval",
    d: "idle",
    e: "waiting",
  };

  it("counts only the owned ids that need attention", () => {
    expect(countAttention(status, ["a", "b", "c", "d", "e"])).toBe(3);
  });

  it("ignores ids not in the owned set (e.g. another window's project)", () => {
    // `c` (approval) and `e` (waiting) exist in status but aren't owned here.
    expect(countAttention(status, ["a", "b", "d"])).toBe(1);
  });

  it("is zero when nobody is waiting", () => {
    expect(countAttention({ x: "working", y: "idle" }, ["x", "y"])).toBe(0);
  });

  it("counts a missing-status id as not needing attention", () => {
    expect(countAttention(status, ["a", "zzz"])).toBe(1);
  });
});

describe("newlyNeedingAttention", () => {
  it("returns ids that crossed from a calm status into waiting/approval", () => {
    const prev: StatusMap = { a: "working", b: "idle", c: "waiting" };
    const next: StatusMap = { a: "waiting", b: "approval", c: "waiting" };
    // a and b just turned red; c was already red (no fresh ping).
    expect(newlyNeedingAttention(prev, next, ["a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("treats an id absent from prev but already waiting as a fresh transition", () => {
    expect(newlyNeedingAttention({}, { a: "waiting" }, ["a"])).toEqual(["a"]);
  });

  it("does not re-fire while an agent stays red", () => {
    const s: StatusMap = { a: "waiting" };
    expect(newlyNeedingAttention(s, s, ["a"])).toEqual([]);
  });

  it("does not fire when an agent leaves red (waiting → working)", () => {
    expect(newlyNeedingAttention({ a: "waiting" }, { a: "working" }, ["a"])).toEqual([]);
  });

  it("only considers owned ids", () => {
    const prev: StatusMap = { a: "working", b: "working" };
    const next: StatusMap = { a: "waiting", b: "waiting" };
    expect(newlyNeedingAttention(prev, next, ["a"])).toEqual(["a"]);
  });

  it("re-fires after an agent recovers and then needs attention again", () => {
    // red → calm → red should ping again on the second red.
    expect(newlyNeedingAttention({ a: "working" }, { a: "approval" }, ["a"])).toEqual(["a"]);
  });
});
